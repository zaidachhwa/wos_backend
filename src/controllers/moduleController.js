import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
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
    });
    return res.json({ success: true, message: "Module updated", data: { module: projectModule } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};
