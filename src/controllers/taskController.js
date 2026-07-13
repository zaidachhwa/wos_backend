import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
import Task from "../models/Task.js";
import { recordActivity, notify } from "../utils/record.js";
import { broadcast } from "../utils/io.js";
import { canViewProject, visibilityFilter, idOf } from "./projectController.js";

const SUBLEAD_PLUS = ["admin", "manager", "sublead"];

const FULL_FIELDS = [
  "title",
  "description",
  "module",
  "assignee",
  "priority",
  "status",
  "estimatedHours",
  "actualHours",
  "deadline",
  "labels",
  "subtasks",
];
const ASSIGNEE_FIELDS = ["status", "actualHours", "subtasks"];

export const createTask = async (req, res) => {
  try {
    const {
      project: projectId,
      module: moduleId,
      title,
      description,
      assignee,
      priority,
      status,
      estimatedHours,
      deadline,
      labels,
    } = req.body;

    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    if (moduleId) {
      const projectModule = await ProjectModule.findOne({ _id: moduleId, project: project._id });
      if (!projectModule) {
        return res.status(400).json({ success: false, message: "module must belong to the project" });
      }
    }

    const task = await Task.create({
      project: project._id,
      module: moduleId || null,
      title,
      description,
      assignee: assignee || null,
      priority,
      status,
      estimatedHours,
      deadline: deadline || null,
      labels: labels || [],
    });

    recordActivity({
      actor: req.user._id,
      action: "created",
      entityType: "task",
      entityId: task._id,
      project: project._id,
    });
    if (task.assignee) {
      notify({
        user: task.assignee,
        type: "task_assigned",
        title: `Assigned to task "${task.title}"`,
        link: `/tasks/${task._id}`,
      });
    }

    broadcast("tasks_changed");
    return res.status(201).json({ success: true, message: "Task created", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listTasks = async (req, res) => {
  try {
    const { project, module, assignee, status, priority, search, dueBefore } = req.query;
    const filter = {};
    if (module) filter.module = module;
    if (status) filter.status = status;
    if (priority) filter.priority = priority;
    if (assignee) filter.assignee = assignee === "me" ? req.user._id : assignee;
    if (search) {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.title = { $regex: escaped, $options: "i" };
    }
    if (dueBefore) filter.deadline = { $lte: new Date(dueBefore) };

    if (project) {
      const projectDoc = await Project.findById(project);
      if (!projectDoc) {
        return res.status(404).json({ success: false, message: "Project not found" });
      }
      if (!(await canViewProject(req.user, projectDoc))) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      filter.project = project;
    } else if (!["admin", "manager"].includes(req.user.role)) {
      const viewableIds = await Project.find(await visibilityFilter(req.user)).distinct("_id");
      filter.project = { $in: viewableIds };
    }

    const tasks = await Task.find(filter)
      .populate("assignee", "name role designation")
      .sort("-createdAt")
      .lean();
    return res.json({ success: true, message: "Tasks fetched", data: { tasks } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate("assignee", "name role designation")
      .populate("comments.user", "name role designation");
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const project = await Project.findById(task.project);
    if (!project || !(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    return res.json({ success: true, message: "Task fetched", data: { task } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateTask = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const project = await Project.findById(task.project);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }

    const canManageFully = SUBLEAD_PLUS.includes(req.user.role) && (await canViewProject(req.user, project));
    const isAssignee = task.assignee && idOf(task.assignee) === String(req.user._id);
    if (!canManageFully && !isAssignee) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const allowedFields = canManageFully ? FULL_FIELDS : ASSIGNEE_FIELDS;
    const disallowed = Object.keys(req.body).filter((key) => !allowedFields.includes(key));
    if (disallowed.length) {
      return res
        .status(403)
        .json({ success: false, message: `Cannot update field(s): ${disallowed.join(", ")}` });
    }

    if (req.body.module) {
      const projectModule = await ProjectModule.findOne({ _id: req.body.module, project: task.project });
      if (!projectModule) {
        return res.status(400).json({ success: false, message: "module must belong to the project" });
      }
    }

    const prevAssignee = task.assignee ? String(task.assignee) : null;
    const prevStatus = task.status;

    for (const key of allowedFields) {
      if (key in req.body) task[key] = req.body[key];
    }
    await task.save();

    recordActivity({
      actor: req.user._id,
      action: "updated",
      entityType: "task",
      entityId: task._id,
      project: task.project,
    });

    const newAssignee = task.assignee ? String(task.assignee) : null;
    if (newAssignee && newAssignee !== prevAssignee) {
      notify({
        user: newAssignee,
        type: "task_assigned",
        title: `Assigned to task "${task.title}"`,
        link: `/tasks/${task._id}`,
      });
    }
    if (task.status !== prevStatus && task.assignee) {
      notify({
        user: task.assignee,
        type: "status_changed",
        title: `Task "${task.title}" is now ${task.status}`,
        link: `/tasks/${task._id}`,
      });
    }

    broadcast("tasks_changed");
    return res.json({ success: true, message: "Task updated", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const addComment = async (req, res) => {
  try {
    const task = await Task.findById(req.params.id);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    const project = await Project.findById(task.project);
    if (!project || !(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    task.comments.push({ user: req.user._id, text: req.body.text });
    await task.save();

    recordActivity({
      actor: req.user._id,
      action: "commented",
      entityType: "task",
      entityId: task._id,
      project: task.project,
    });
    if (task.assignee && idOf(task.assignee) !== String(req.user._id)) {
      notify({
        user: task.assignee,
        type: "comment_added",
        title: `New comment on "${task.title}"`,
        link: `/tasks/${task._id}`,
      });
    }

    return res.status(201).json({ success: true, message: "Comment added", data: { task } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};
