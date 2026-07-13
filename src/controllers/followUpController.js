import FollowUp from "../models/FollowUp.js";
import User from "../models/User.js";
import { recordActivity, notify } from "../utils/record.js";

const SUBLEAD_PLUS = ["admin", "manager", "sublead"];

export const upsertFollowUp = async (req, res) => {
  try {
    const { date, type, data, submit } = req.body;

    let followUp = await FollowUp.findOne({ user: req.user._id, date, type });
    if (followUp && followUp.status === "reviewed") {
      return res.status(409).json({ success: false, message: "Follow-up already reviewed and locked" });
    }
    if (!followUp) {
      followUp = new FollowUp({ user: req.user._id, date, type });
    }

    followUp.set(type, data);
    if (submit === true) {
      followUp.status = "submitted";
      followUp.submittedAt = new Date();
    }
    await followUp.save();

    if (submit === true) {
      recordActivity({
        actor: req.user._id,
        action: "submitted",
        entityType: "followup",
        entityId: followUp._id,
      });
      if (req.user.reportingManager) {
        notify({
          user: req.user.reportingManager,
          type: "followup_submitted",
          title: `${req.user.name} submitted their ${type} follow-up`,
          link: "/follow-ups",
        });
      }
    }

    return res.status(200).json({ success: true, message: "Follow-up saved", data: { followUp } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "Follow-up already exists" });
    }
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listFollowUps = async (req, res) => {
  try {
    const { date, type, scope = "own" } = req.query;

    if (scope === "team") {
      if (!SUBLEAD_PLUS.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      if (!date || !type) {
        return res
          .status(400)
          .json({ success: false, message: "date and type are required for scope=team" });
      }
      const reportFilter =
        req.user.role === "admin"
          ? { isActive: true }
          : { reportingManager: req.user._id, isActive: true };
      const reports = await User.find(reportFilter).select("name role");
      const existing = await FollowUp.find({
        user: { $in: reports.map((r) => r._id) },
        date,
        type,
      }).populate("user", "name role");
      const byUser = new Map(existing.map((f) => [String(f.user._id), f]));
      const followUps = reports.map(
        (r) =>
          byUser.get(String(r._id)) || {
            user: { _id: r._id, name: r.name, role: r.role },
            date,
            type,
            status: "missing",
          }
      );
      return res.json({ success: true, message: "Follow-ups fetched", data: { followUps } });
    }

    const filter = { user: req.user._id };
    if (date) filter.date = date;
    if (type) filter.type = type;
    const followUps = await FollowUp.find(filter).sort("-date");
    return res.json({ success: true, message: "Follow-ups fetched", data: { followUps } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const reviewFollowUp = async (req, res) => {
  try {
    const followUp = await FollowUp.findById(req.params.id);
    if (!followUp) {
      return res.status(404).json({ success: false, message: "Follow-up not found" });
    }
    if (followUp.status !== "submitted") {
      return res.status(409).json({ success: false, message: "Only submitted follow-ups can be reviewed" });
    }

    const owner = await User.findById(followUp.user);
    const isOwnManager = owner && String(owner.reportingManager) === String(req.user._id);
    if (req.user.role !== "admin" && !isOwnManager) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    followUp.status = "reviewed";
    followUp.managerComment = req.body.managerComment || "";
    followUp.reviewedBy = req.user._id;
    await followUp.save();

    recordActivity({
      actor: req.user._id,
      action: "reviewed",
      entityType: "followup",
      entityId: followUp._id,
    });
    notify({
      user: followUp.user,
      type: "followup_reviewed",
      title: `Your ${followUp.type} follow-up was reviewed`,
      link: "/follow-ups",
    });

    return res.json({ success: true, message: "Follow-up reviewed", data: { followUp } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
