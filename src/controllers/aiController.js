import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
import Task from "../models/Task.js";
import TimeBlock from "../models/TimeBlock.js";
import FollowUp from "../models/FollowUp.js";
import User from "../models/User.js";
import { canViewProject, visibilityFilter } from "./projectController.js";
import { localDay } from "./notificationController.js";
import { aiConfigured, generateText, generateJson } from "../services/gemini.js";
import { isTaskOverdue } from "../utils/taskDates.js";
import { reportScopeFilter } from "../utils/subadminScope.js";

export const requireAI = (req, res, next) => {
  if (!aiConfigured()) {
    return res.status(503).json({ success: false, message: "AI is not configured" });
  }
  next();
};

const fmtTask = (t) =>
  `- "${t.title}" [${t.status}, ${t.priority}${t.deadline ? `, due ${t.deadline.toISOString().slice(0, 10)}` : ""}]`;

// Context builders only ever expose names/roles/titles — never emails or
// anything from select:false fields.
const dayContext = async (user) => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const in7d = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const today = localDay(now);

  const [todayTasks, upcoming, blocks, followUps] = await Promise.all([
    Task.find({
      assignees: user._id,
      $or: [{ deadline: { $gte: start, $lte: end } }, { status: "in_progress" }],
    }),
    Task.find({ assignees: user._id, deadline: { $gte: now, $lte: in7d }, status: { $ne: "completed" } }).sort(
      "deadline"
    ),
    TimeBlock.find({ user: user._id, start: { $gte: start, $lte: end } }).sort("start"),
    FollowUp.find({ user: user._id, date: today }),
  ]);

  const fmtBlock = (b) =>
    `- ${b.title} (${b.category}) ${b.start.toTimeString().slice(0, 5)}-${b.end.toTimeString().slice(0, 5)}`;
  const fuStatus = (type) => {
    const f = followUps.find((x) => x.type === type);
    return !f || f.status === "draft" ? "not submitted" : f.status;
  };

  return [
    `Today's tasks:\n${todayTasks.map(fmtTask).join("\n") || "- none"}`,
    `Deadlines in the next 7 days:\n${upcoming.map(fmtTask).join("\n") || "- none"}`,
    `Today's schedule:\n${blocks.map(fmtBlock).join("\n") || "- none"}`,
    `Follow-ups today: morning ${fuStatus("morning")}, evening ${fuStatus("evening")}.`,
  ].join("\n\n");
};

const workloadContext = async (user) => {
  const reportFilter = await reportScopeFilter(user);
  const reports = await User.find(reportFilter).select("name role");
  const openTasks = await Task.find({
    assignees: { $in: reports.map((r) => r._id) },
    status: { $ne: "completed" },
  }).select("assignees estimatedHours actualHours status");

  return reports
    .map((r) => {
      const mine = openTasks.filter((t) => t.assignees.some((a) => String(a) === String(r._id)));
      const est = mine.reduce((s, t) => s + (t.estimatedHours || 0), 0);
      const blocked = mine.filter((t) => t.status === "blocked").length;
      return `- ${r.name} (${r.role}): ${mine.length} open tasks, ${est}h estimated, ${blocked} blocked`;
    })
    .join("\n");
};

export const dailyPlanner = async (req, res) => {
  try {
    const context = await dayContext(req.user);
    const plan = await generateText(
      `You are a productivity assistant for ${req.user.name} (${req.user.role}) on an internal team-management platform.\n\n${context}\n\nWrite a concise, prioritized plan for their day: top priorities first, then meetings/schedule notes, then reminders (pending follow-ups, imminent deadlines). Use short bullet points. No preamble.`
    );
    return res.json({ success: true, message: "Daily plan generated", data: { plan } });
  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(502).json({ success: false, message: "AI request failed" });
  }
};

export const workloadAnalysis = async (req, res) => {
  try {
    const context = await workloadContext(req.user);
    if (!context) {
      return res.json({
        success: true,
        message: "Workload analyzed",
        data: { analysis: "No reports with assigned work yet." },
      });
    }
    const analysis = await generateText(
      `You are analyzing team workload for a manager on an internal platform.\n\nTeam workload:\n${context}\n\nIdentify overloaded and underutilized people and suggest specific reassignments if warranted. Be concise, bullet points, no preamble.`
    );
    return res.json({ success: true, message: "Workload analyzed", data: { analysis } });
  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(502).json({ success: false, message: "AI request failed" });
  }
};

export const projectHealth = async (req, res) => {
  try {
    const { projectId } = req.body;
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const [modules, tasks] = await Promise.all([
      ProjectModule.find({ project: project._id }),
      Task.find({ project: project._id }).select("status deadline startTime endTime"),
    ]);
    const now = new Date();
    const counts = {};
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    const overdue = tasks.filter((t) => isTaskOverdue(t, now)).length;

    const summary = [
      `Project "${project.name}" — status ${project.status}, deadline ${project.deadline ? project.deadline.toISOString().slice(0, 10) : "none"} (today ${now.toISOString().slice(0, 10)}).`,
      `Modules: ${modules.length}. Tasks by status: ${JSON.stringify(counts)}. Overdue tasks: ${overdue}.`,
    ].join("\n");

    const result = await generateJson(
      `${summary}\n\nAssess this project's health. Respond with ONLY a JSON object: {"healthScore": <0-100 integer>, "riskLevel": "low"|"medium"|"high", "recommendations": ["...", "..."]} — no other text.`
    );
    const healthScore = Math.max(0, Math.min(100, Number(result.healthScore) || 0));
    const riskLevel = ["low", "medium", "high"].includes(result.riskLevel) ? result.riskLevel : "medium";
    const recommendations = Array.isArray(result.recommendations) ? result.recommendations.map(String) : [];
    return res.json({
      success: true,
      message: "Project health analyzed",
      data: { healthScore, riskLevel, recommendations },
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    if (error instanceof SyntaxError) {
      return res.status(502).json({ success: false, message: "AI returned an unreadable response" });
    }
    return res.status(502).json({ success: false, message: "AI request failed" });
  }
};

export const chat = async (req, res) => {
  try {
    const { message } = req.body;
    const [projects, ownTasks] = await Promise.all([
      Project.find(await visibilityFilter(req.user)).populate("manager", "name"),
      Task.find({ assignees: req.user._id, status: { $ne: "completed" } }),
    ]);

    const pieces = [
      `Projects visible to them:\n${projects
        .map(
          (p) =>
            `- "${p.name}" [${p.status}${p.deadline ? `, due ${p.deadline.toISOString().slice(0, 10)}` : ""}] managed by ${p.manager?.name || "?"}`
        )
        .join("\n") || "- none"}`,
      `Their open tasks:\n${ownTasks.map(fmtTask).join("\n") || "- none"}`,
    ];

    if (["admin", "manager", "subadmin", "sublead"].includes(req.user.role)) {
      const today = localDay(new Date());
      const reportFilter = await reportScopeFilter(req.user);
      const reports = await User.find(reportFilter).select("name role");
      const reportIds = reports.map((r) => r._id);
      const [followUps, blocked] = await Promise.all([
        FollowUp.find({ user: { $in: reportIds }, date: today }),
        Task.find({ assignees: { $in: reportIds }, status: "blocked" }).populate("assignees", "name"),
      ]);
      const submitted = new Set(
        followUps.filter((f) => f.status !== "draft").map((f) => `${String(f.user)}:${f.type}`)
      );
      pieces.push(
        `Their reports and today's follow-ups:\n${reports
          .map(
            (r) =>
              `- ${r.name} (${r.role}): morning ${submitted.has(`${String(r._id)}:morning`) ? "submitted" : "pending"}, evening ${submitted.has(`${String(r._id)}:evening`) ? "submitted" : "pending"}`
          )
          .join("\n") || "- none"}`,
        `Blocked tasks in their team:\n${blocked.map((t) => `- "${t.title}" (${t.assignees.map((a) => a.name).join(", ") || "unassigned"})`).join("\n") || "- none"}`
      );
    }

    const answer = await generateText(
      `You are the WorkOS assistant answering ${req.user.name} (${req.user.role}). Answer ONLY from this context; if the context can't answer, say so briefly.\n\n${pieces.join("\n\n")}\n\nQuestion: ${message}`
    );
    return res.json({ success: true, message: "Answer generated", data: { answer } });
  } catch (error) {
    console.error(error.response?.data || error.message);
    return res.status(502).json({ success: false, message: "AI request failed" });
  }
};
