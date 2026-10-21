import Project from "../models/Project.js";
import Task from "../models/Task.js";
import Team from "../models/Team.js";
import User from "../models/User.js";
import { combineDeadlineAndTime, endOfDayLocal } from "../utils/taskDates.js";
import { istDayStr } from "../utils/istTime.js";

// "Who is engaged until when, and when do they get free?" — derived purely
// from open project tasks: a person is engaged until the latest deadline of
// their unfinished, approved tasks, and free once that has passed (or when
// they have no open task with a deadline).

const DAY_MS = 24 * 60 * 60 * 1000;

const deadlineCutoff = (t) => (t.endTime ? combineDeadlineAndTime(t.deadline, t.endTime) : endOfDayLocal(t.deadline));

// Whole IST calendar days from today to `day` ("YYYY-MM-DD").
export const istDaysUntil = (day, now = new Date()) =>
  Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${istDayStr(now)}T00:00:00Z`)) / DAY_MS);

// Availability for many people at once (two queries total).
export const computeAvailability = async (userIds, now = new Date()) => {
  const ids = userIds.map(String);
  const [users, tasks] = await Promise.all([
    User.find({ _id: { $in: ids }, isActive: true })
      .select("name email role designation department team")
      .populate("department", "name")
      .populate("team", "name")
      .lean(),
    Task.find({
      assignees: { $in: ids },
      status: { $ne: "completed" },
      approvalStatus: { $nin: ["pending", "rejected"] },
    })
      .select("title assignees status deadline endTime project priority")
      .populate("project", "name priority")
      .lean(),
  ]);

  const byUser = new Map(ids.map((id) => [id, []]));
  for (const t of tasks) for (const a of t.assignees) byUser.get(String(a))?.push(t);

  const priorityRank = { high: 3, medium: 2, low: 1 };

  return users
    .map((u) => {
      const open = byUser.get(String(u._id)) || [];
      const dated = open.filter((t) => t.deadline).map((t) => ({ ...t, cutoff: deadlineCutoff(t) }));
      const latest = dated.reduce((max, t) => (!max || t.cutoff > max.cutoff ? t : max), null);
      const overdue = dated.filter((t) => t.cutoff < now).length;
      const engagedUntil = latest && latest.cutoff > now ? latest.cutoff : null;
      const freeDay = engagedUntil ? istDayStr(engagedUntil) : null;
      let status = "free";
      if (engagedUntil) status = "engaged";
      else if (overdue) status = "overdue"; // nothing ahead, but behind on work

      const highestTaskPriority = open.reduce((hi, t) => {
        const p = t.priority || "low";
        return (priorityRank[p] || 1) > (priorityRank[hi] || 1) ? p : hi;
      }, "low");

      const openProjectsMap = new Map();
      for (const t of open) {
        if (t.project) {
          const pid = String(t.project._id);
          if (!openProjectsMap.has(pid)) {
            openProjectsMap.set(pid, {
              _id: t.project._id,
              name: t.project.name,
              priority: t.project.priority || "medium",
            });
          }
        }
      }
      const projects = [...openProjectsMap.values()];

      const highestProjectPriority = projects.reduce((hi, p) => {
        const pr = p.priority || "medium";
        return (priorityRank[pr] || 2) > (priorityRank[hi] || 2) ? pr : hi;
      }, projects.length ? "low" : null);

      return {
        user: { _id: u._id, name: u.name, email: u.email, role: u.role, designation: u.designation, department: u.department, team: u.team },
        status,
        engagedUntil,
        freeDay,
        daysUntilFree: freeDay ? istDaysUntil(freeDay, now) : 0,
        openTasks: open.length,
        undatedTasks: open.length - dated.length,
        overdueTasks: overdue,
        highestTaskPriority: open.length ? highestTaskPriority : null,
        highestProjectPriority,
        projects,
        tasks: dated
          .sort((a, b) => a.cutoff - b.cutoff)
          .map((t) => ({
            _id: t._id,
            title: t.title,
            priority: t.priority || "low",
            project: t.project?.name || "",
            projectPriority: t.project?.priority || null,
            status: t.status,
            dueAt: t.cutoff,
          })),
      };
    })
    .sort((a, b) => (a.engagedUntil?.getTime?.() ?? 0) - (b.engagedUntil?.getTime?.() ?? 0) || a.user.name.localeCompare(b.user.name));
};

// Whom a viewer sees, and in which capacity:
//   Team Lead (manager / sub-lead)    → people in the team(s) they manage
//   Project Manager (Project.manager) → members + assignees of their projects
//   Technical Coordinator             → everyone in their department
//   Admin                             → everyone
export const visiblePeople = async (viewer) => {
  const groups = [];
  const self = String(viewer._id);
  const add = (label, users) => {
    const list = users.map(String).filter((id) => id !== self);
    if (list.length) groups.push({ label, userIds: [...new Set(list)] });
  };

  if (viewer.role === "admin" || viewer.role === "head_of_technical_operations") {
    add("Everyone", await User.find({ isActive: true, role: { $nin: ["admin", "head_of_technical_operations"] } }).distinct("_id"));
    return groups;
  }

  const teamIds =
    viewer.role === "manager" ? [viewer.managedTeam].filter(Boolean) : viewer.role === "sublead" ? viewer.managedTeams || [] : [];
  if (teamIds.length) {
    const teams = await Team.find({ _id: { $in: teamIds } }).select("name").lean();
    add(`My team${teams.length > 1 ? "s" : ""}: ${teams.map((t) => t.name).join(", ")}`, await User.find({ team: { $in: teamIds }, isActive: true }).distinct("_id"));
  }

  const projects = await Project.find({ manager: viewer._id, status: { $nin: ["completed", "cancelled"] } }).select("members").lean();
  if (projects.length) {
    const projectIds = projects.map((p) => p._id);
    const assignees = await Task.find({ project: { $in: projectIds } }).distinct("assignees");
    add("My projects", [...projects.flatMap((p) => p.members || []), ...assignees]);
  }

  if (viewer.role === "technical_coordinator" && viewer.department) {
    add("My department", await User.find({ department: viewer.department, isActive: true }).distinct("_id"));
  }
  return groups;
};
