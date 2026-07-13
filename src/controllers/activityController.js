import Project from "../models/Project.js";
import Activity from "../models/Activity.js";
import { canViewProject } from "./projectController.js";

export const listActivity = async (req, res) => {
  try {
    const { project: projectId } = req.query;
    const parsedLimit = parseInt(req.query.limit, 10);
    const limit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 100);

    let filter;
    if (projectId) {
      const project = await Project.findById(projectId);
      if (!project) {
        return res.status(404).json({ success: false, message: "Project not found" });
      }
      if (!(await canViewProject(req.user, project))) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      filter = { project: projectId };
    } else {
      filter = { actor: req.user._id };
    }

    const activity = await Activity.find(filter).sort("-createdAt").limit(limit).populate("actor", "name role");

    return res.json({ success: true, message: "Activity fetched", data: { activity } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
