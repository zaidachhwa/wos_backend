import Project from "../models/Project.js";
import Task from "../models/Task.js";
import User from "../models/User.js";
import { visibilityFilter } from "./projectController.js";
import { resolveDepartmentScope } from "../utils/departmentScope.js";

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const globalSearch = async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (q.length < 2) {
      return res.json({ success: true, message: "Search", data: { projects: [], tasks: [], users: [] } });
    }
    const rx = { $regex: escapeRegex(q), $options: "i" };

    const projectScope = await visibilityFilter(req.user);
    const scopedProjectIds =
      Object.keys(projectScope).length > 0 ? await Project.find(projectScope).distinct("_id") : null;

    const taskFilter = { title: rx };
    if (scopedProjectIds) taskFilter.project = { $in: scopedProjectIds };

    const scope = await resolveDepartmentScope(req.user);
    const userFilter = scope
      ? { name: rx, isActive: true, $or: [{ team: { $in: scope.teamIds } }, { _id: req.user._id }] }
      : { name: rx, isActive: true };

    const [projects, tasks, users] = await Promise.all([
      Project.find({ ...projectScope, name: rx }).select("name status").limit(5),
      Task.find(taskFilter).select("title status project").limit(7),
      User.find(userFilter).select("name role designation").limit(5),
    ]);

    return res.json({ success: true, message: "Search", data: { projects, tasks, users } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
