import Project from "../models/Project.js";
import Activity from "../models/Activity.js";
import { canViewProject } from "./projectController.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";

export const listActivity = async (req, res) => {
  try {
    const { project: projectId } = req.query;
    const parsedLimit = parseInt(req.query.limit, 10);
    const legacyLimit = Math.min(Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : 20, 100);

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

    // ?page takes over paging; plain ?limit (no ?page) keeps the old
    // "just cap the result" behavior so existing callers are unaffected.
    const pageParams = req.query.page !== undefined ? paginationParams(req.query) : null;
    const total = await Activity.countDocuments(filter);
    let query = Activity.find(filter).sort("-createdAt").populate("actor", "name role");
    query = pageParams ? query.skip(pageParams.skip).limit(pageParams.limit) : query.limit(legacyLimit);
    const activity = await query;

    // Legacy (no ?page) mode still caps the result at legacyLimit — report
    // that as the effective limit rather than falsely claiming "everything".
    const metaParams = pageParams || { page: 1, limit: legacyLimit };
    return res.json({
      success: true,
      message: "Activity fetched",
      data: { activity, pagination: paginationMeta(total, metaParams) },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
