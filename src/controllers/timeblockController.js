import TimeBlock from "../models/TimeBlock.js";
import User from "../models/User.js";
import { recordActivity } from "../utils/record.js";

// Can `actor` create/list time blocks on behalf of `targetUserId`?
// Self always OK; admin can act for anyone; manager only for their own reports.
export const canActForUser = async (actor, targetUserId) => {
  if (String(targetUserId) === String(actor._id)) return true;
  if (actor.role === "admin") return true;
  if (actor.role === "manager") {
    const target = await User.findById(targetUserId);
    return !!target && String(target.reportingManager) === String(actor._id);
  }
  return false;
};

const canModify = (actor, block) =>
  actor.role === "admin" ||
  String(block.user) === String(actor._id) ||
  String(block.createdBy) === String(actor._id);

export const createTimeBlock = async (req, res) => {
  try {
    const { title, start, end, category, description, color, project, user } = req.body;
    const targetUser = user || req.user._id;
    if (!(await canActForUser(req.user, targetUser))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const block = await TimeBlock.create({
      user: targetUser,
      title,
      start,
      end,
      category,
      description,
      color,
      project: project || null,
      createdBy: req.user._id,
    });
    recordActivity({
      actor: req.user._id,
      action: "created",
      entityType: "timeblock",
      entityId: block._id,
      project: block.project ?? null,
    });
    return res.status(201).json({ success: true, message: "Time block created", data: { timeBlock: block } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listTimeBlocks = async (req, res) => {
  try {
    const { from, to, user } = req.query;
    const targetUser = user || req.user._id;
    if (!(await canActForUser(req.user, targetUser))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const filter = { user: targetUser };
    if (from || to) {
      filter.start = {};
      if (from) filter.start.$gte = new Date(from);
      if (to) filter.start.$lte = new Date(to);
    }
    const timeBlocks = await TimeBlock.find(filter).sort("start");
    return res.json({ success: true, message: "Time blocks fetched", data: { timeBlocks } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateTimeBlock = async (req, res) => {
  try {
    const block = await TimeBlock.findById(req.params.id);
    if (!block) {
      return res.status(404).json({ success: false, message: "Time block not found" });
    }
    if (!canModify(req.user, block)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const allowed = ["title", "start", "end", "category", "description", "color", "project"];
    for (const key of allowed) {
      if (key in req.body) block[key] = req.body[key];
    }
    if (!(new Date(block.end) > new Date(block.start))) {
      return res.status(400).json({ success: false, message: "end must be after start" });
    }
    await block.save();
    recordActivity({
      actor: req.user._id,
      action: "updated",
      entityType: "timeblock",
      entityId: block._id,
      project: block.project ?? null,
    });
    return res.json({ success: true, message: "Time block updated", data: { timeBlock: block } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteTimeBlock = async (req, res) => {
  try {
    const block = await TimeBlock.findById(req.params.id);
    if (!block) {
      return res.status(404).json({ success: false, message: "Time block not found" });
    }
    if (!canModify(req.user, block)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    await block.deleteOne();
    recordActivity({
      actor: req.user._id,
      action: "deleted",
      entityType: "timeblock",
      entityId: block._id,
      project: block.project ?? null,
    });
    return res.json({ success: true, message: "Time block deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
