import Project from "../models/Project.js";
import ProjectModule from "../models/ProjectModule.js";
import { recordActivity, notify } from "../utils/record.js";
import { computeProjectProgress, modulesWithProgress } from "../utils/progress.js";

// project.manager/members may be a raw ObjectId or a populated User doc
// (getProject populates them for the response) — always compare by _id.
// Exported for taskController: same "compare a ref field to the actor" need.
export const idOf = (v) => String(v?._id || v);

const canManage = (user, project) =>
  ["admin", "manager"].includes(user.role) || idOf(project.manager) === String(user._id);

// Exported for moduleController/taskController: same visibility rule applies
// to viewing a project's modules/tasks.
export const canViewProject = async (user, project) => {
  if (["admin", "manager"].includes(user.role)) return true;
  if (idOf(project.manager) === String(user._id)) return true;
  if ((project.members || []).some((m) => idOf(m) === String(user._id))) return true;
  const leadsAModule = await ProjectModule.exists({ project: project._id, lead: user._id });
  return !!leadsAModule;
};

// Exported for taskController: build a Project filter matching what a user
// may view, so task list filtering doesn't duplicate the visibility rule.
export const visibilityFilter = async (user) => {
  if (["admin", "manager"].includes(user.role)) return {};
  const ledProjectIds = await ProjectModule.find({ lead: user._id }).distinct("project");
  return {
    $or: [{ members: user._id }, { manager: user._id }, { _id: { $in: ledProjectIds } }],
  };
};

export const createProject = async (req, res) => {
  try {
    const { name, description, manager, members, priority, startDate, deadline, status } = req.body;
    const project = await Project.create({
      name,
      description,
      manager,
      members: members || [],
      priority,
      startDate: startDate || null,
      deadline: deadline || null,
      status,
    });
    recordActivity({
      actor: req.user._id,
      action: "created",
      entityType: "project",
      entityId: project._id,
      project: project._id,
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
    const projects = await Project.find(filter)
      .populate("manager", "name role designation")
      .sort("-createdAt")
      .lean();
    const withProgress = await Promise.all(
      projects.map(async (p) => ({ ...p, progress: await computeProjectProgress(p._id) }))
    );
    return res.json({ success: true, message: "Projects fetched", data: { projects: withProgress } });
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
    if (!canManage(req.user, project)) {
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
    ];
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
    return res.json({ success: true, message: "Project deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
