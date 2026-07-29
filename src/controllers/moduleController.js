import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
import Task from "../models/Task.js";
import { recordActivity } from "../utils/record.js";
import { modulesWithProgress } from "../utils/progress.js";
import { canViewProject } from "./projectController.js";

export const listModules = async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const modules = await modulesWithProgress(project._id);
    return res.json({ success: true, message: "Modules fetched", data: { modules } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const createModule = async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const { name, description, deadline, assignees, status } = req.body;
    const projectModule = await ProjectModule.create({
      project: project._id,
      name,
      description,
      deadline: deadline || null,
      assignees: assignees || [],
      status,
    });
    recordActivity({
      actor: req.user._id,
      action: "created",
      entityType: "module",
      entityId: projectModule._id,
      project: project._id,
      meta: { title: projectModule.name },
    });
    return res
      .status(201)
      .json({ success: true, message: "Module created", data: { module: projectModule } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const updateModule = async (req, res) => {
  try {
    const project = await Project.findById(req.params.projectId);
    if (!project) {
      return res.status(404).json({ success: false, message: "Project not found" });
    }
    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const projectModule = await ProjectModule.findOne({
      _id: req.params.id,
      project: req.params.projectId,
    });
    if (!projectModule) {
      return res.status(404).json({ success: false, message: "Module not found" });
    }
    const prevStatus = projectModule.status;
    const allowed = ["name", "description", "deadline", "assignees", "status"];
    for (const key of allowed) {
      if (key in req.body) projectModule[key] = req.body[key];
    }
    await projectModule.save();
    recordActivity({
      actor: req.user._id,
      action: "updated",
      entityType: "module",
      entityId: projectModule._id,
      project: projectModule.project,
      meta:
        projectModule.status !== prevStatus
          ? { title: projectModule.name, statusFrom: prevStatus, statusTo: projectModule.status }
          : { title: projectModule.name },
    });
    return res.json({ success: true, message: "Module updated", data: { module: projectModule } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteModule = async (req, res) => {
  try {
    const projectModule = await ProjectModule.findOneAndDelete({
      _id: req.params.id,
      project: req.params.projectId,
    });
    if (!projectModule) {
      return res.status(404).json({ success: false, message: "Module not found" });
    }
    // Unlink the deleted module from every task that has it, then hard-delete
    // only the tasks that are left with zero modules as a result — a task
    // that still belongs to another module survives with this one removed.
    const affectedTaskIds = await Task.find({ modules: projectModule._id }).distinct("_id");
    await Task.updateMany({ _id: { $in: affectedTaskIds } }, { $pull: { modules: projectModule._id } });
    await Task.deleteMany({ _id: { $in: affectedTaskIds }, modules: { $size: 0 } });
    recordActivity({
      actor: req.user._id,
      action: "deleted",
      entityType: "module",
      entityId: projectModule._id,
      project: projectModule.project,
      meta: { title: projectModule.name },
    });
    return res.json({ success: true, message: "Module deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
