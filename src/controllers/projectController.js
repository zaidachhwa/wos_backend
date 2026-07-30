import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { recordActivity, notify } from "../utils/record.js";
import { computeProjectProgress, modulesWithProgress } from "../utils/progress.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";
import { getManagedUserIds, getManagedTeamIds } from "../utils/subadminScope.js";

// project.manager/members may be a raw ObjectId or a populated User doc
// (getProject populates them for the response) — always compare by _id.
// Exported for taskController: same "compare a ref field to the actor" need.
export const idOf = (v) => String(v?._id || v);

const canManage = async (user, project) => {
  if (["admin", "manager"].includes(user.role)) return true;
  if (idOf(project.manager) === String(user._id)) return true;
  if (user.role === "subadmin") {
    const managedIds = (await getManagedUserIds(user)).map(String);
    return managedIds.includes(idOf(project.manager));
  }
  return false;
};

// Exported for moduleController/taskController: same visibility rule applies
// to viewing a project's modules/tasks.
export const canViewProject = async (user, project) => {
  if (["admin", "manager"].includes(user.role)) return true;
  if (idOf(project.manager) === String(user._id)) return true;
  if ((project.members || []).some((m) => idOf(m) === String(user._id))) return true;
  if (user.role === "subadmin") {
    const managedIds = (await getManagedUserIds(user)).map(String);
    if (managedIds.includes(idOf(project.manager))) return true;
    if ((project.members || []).some((m) => managedIds.includes(idOf(m)))) return true;
  }
  const scopeIds =
    user.role === "subadmin" ? [...(await getManagedUserIds(user)), user._id] : [user._id];
  const assignedToAModule = await ProjectModule.exists({ project: project._id, assignees: { $in: scopeIds } });
  if (assignedToAModule) return true;
  const assignedToATask = await Task.exists({ project: project._id, assignees: { $in: scopeIds } });
  return !!assignedToATask;
};

// Exported for taskController: build a Project filter matching what a user
// may view, so task list filtering doesn't duplicate the visibility rule.
export const visibilityFilter = async (user) => {
  if (["admin", "manager"].includes(user.role)) return {};
  const scopeIds =
    user.role === "subadmin" ? [...(await getManagedUserIds(user)), user._id] : [user._id];
  const [assignedModuleProjectIds, assignedTaskProjectIds] = await Promise.all([
    ProjectModule.find({ assignees: { $in: scopeIds } }).distinct("project"),
    Task.find({ assignees: { $in: scopeIds } }).distinct("project"),
  ]);
  const assignedProjectIds = [...assignedModuleProjectIds, ...assignedTaskProjectIds];
  return {
    $or: [
      { members: { $in: scopeIds } },
      { manager: { $in: scopeIds } },
      { _id: { $in: assignedProjectIds } },
    ],
  };
};

export const createProject = async (req, res) => {
  try {
    const { name, description, manager, members, priority, startDate, deadline, status, type } = req.body;
    const project = await Project.create({
      name,
      description,
      manager,
      members: members || [],
      priority,
      startDate: startDate || null,
      deadline: deadline || null,
      status,
      type,
    });
    recordActivity({
      actor: req.user._id,
      action: "created",
      entityType: "project",
      entityId: project._id,
      project: project._id,
      meta: { title: project.name },
    });
    for (const memberId of project.members) {
      notify({
        user: memberId,
        type: "project_updated",
        title: `Added to project ${project.name}`,
        link: `/projects/${project._id}`,
      });
    }
    return res.status(201).json({ success: true, message: "Project created", data: { project } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listProjects = async (req, res) => {
  try {
    const filter = await visibilityFilter(req.user);
    if (req.query.status) filter.status = req.query.status;
    if (req.query.type) filter.type = req.query.type;
    if (req.query.search) {
      const escaped = req.query.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.name = { $regex: escaped, $options: "i" };
    }
    if (req.query.team) {
      // Project has no team field of its own — team membership is a User
      // property, so "this project's team" means its manager or any member
      // is on that team. Same subadmin-scope check as the leaderboard's
      // ?team= filter (getLeaderboard).
      if (req.user.role === "subadmin") {
        const managedTeamIds = (await getManagedTeamIds(req.user.managedDepartment)).map(String);
        if (!managedTeamIds.includes(String(req.query.team))) {
          return res.status(403).json({ success: false, message: "Forbidden" });
        }
      }
      const teamUserIds = await User.find({ team: req.query.team }).distinct("_id");
      const teamCondition = { $or: [{ manager: { $in: teamUserIds } }, { members: { $in: teamUserIds } }] };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, teamCondition];
        delete filter.$or;
      } else {
        Object.assign(filter, teamCondition);
      }
    }
    const pageParams = paginationParams(req.query);
    const total = await Project.countDocuments(filter);
    let query = Project.find(filter).populate("manager", "name role designation").sort("-createdAt").lean();
    if (pageParams) query = query.skip(pageParams.skip).limit(pageParams.limit);
    const projects = await query;
    const withProgress = await Promise.all(
      projects.map(async (p) => ({ ...p, progress: await computeProjectProgress(p._id) }))
    );
    return res.json({
      success: true,
      message: "Projects fetched",
      data: { projects: withProgress, pagination: paginationMeta(total, pageParams) },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getProject = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate("manager", "name role designation")
      .populate("members", "name role designation");
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const [progress, modules] = await Promise.all([
      computeProjectProgress(project._id),
      modulesWithProgress(project._id),
    ]);
    return res.json({
      success: true,
      message: "Project fetched",
      data: { project: { ...project.toObject(), progress, modules } },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateProject = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canManage(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const allowed = [
      "name",
      "description",
      "manager",
      "members",
      "priority",
      "startDate",
      "deadline",
      "status",
      "type",
    ];
    const prevStatus = project.status;
    for (const key of allowed) {
      if (key in req.body) project[key] = req.body[key];
    }
    await project.save();
    recordActivity({
      actor: req.user._id,
      action: "updated",
      entityType: "project",
      entityId: project._id,
      project: project._id,
      meta:
        project.status !== prevStatus
          ? { title: project.name, statusFrom: prevStatus, statusTo: project.status }
          : { title: project.name },
    });
    return res.json({ success: true, message: "Project updated", data: { project } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    await Promise.all([
      Task.deleteMany({ project: project._id }),
      ProjectModule.deleteMany({ project: project._id }),
    ]);
    return res.json({ success: true, message: "Project deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
