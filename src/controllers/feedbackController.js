import AnonymousFeedback, { FEEDBACK_CATEGORIES } from "../models/AnonymousFeedback.js";
import BonusRequest from "../models/BonusRequest.js";
import User from "../models/User.js";
import { istDayStr, toIST } from "../utils/istTime.js";
import { notify } from "../utils/record.js";

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const serverError = (res, error) => {
  console.error(error?.name || "error"); // never log request bodies here — feedback must stay anonymous
  return fail(res, 500, "Something went wrong");
};

export const FEEDBACK_VIEWERS = ["admin", "hr"];
export const BONUS_REQUEST_VIEWERS = ["admin", "hr", "director"];

// ------------------------------------------------------------ anonymous feedback

// Deliberately reads nothing about req.user beyond "is logged in" (enforced
// by the route), and stores nothing that identifies them.
export const submitFeedback = async (req, res) => {
  try {
    const message = String(req.body?.message || "").trim();
    if (message.length < 5) return fail(res, 400, "Please write at least a few words");
    if (message.length > 5000) return fail(res, 400, "Feedback can be at most 5000 characters");
    const category = FEEDBACK_CATEGORIES.includes(req.body?.category) ? req.body.category : "general";
    await AnonymousFeedback.create({ message, category, day: istDayStr() });
    // No notification on purpose: an instant "new feedback" alert would tell
    // HR the exact moment it was written, which narrows down who wrote it.
    // The inbox shows a count of new items instead. Nothing about the stored
    // record is returned either.
    return res.status(201).json({ success: true, message: "Feedback submitted anonymously" });
  } catch (error) {
    return serverError(res, error);
  }
};

export const listFeedback = async (req, res) => {
  try {
    const filter = {};
    if (req.query.status && ["new", "reviewed"].includes(req.query.status)) filter.status = req.query.status;
    if (req.query.category && FEEDBACK_CATEGORIES.includes(req.query.category)) filter.category = req.query.category;
    const feedback = await AnonymousFeedback.find(filter).sort({ day: -1 }).limit(1000).lean();
    const counts = { new: await AnonymousFeedback.countDocuments({ status: "new" }), total: await AnonymousFeedback.estimatedDocumentCount() };
    return res.json({ success: true, message: "Feedback fetched", data: { feedback, counts, categories: FEEDBACK_CATEGORIES } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const setFeedbackStatus = async (req, res) => {
  try {
    const status = req.body?.status === "reviewed" ? "reviewed" : "new";
    const r = await AnonymousFeedback.updateOne({ _id: String(req.params.id) }, { $set: { status } });
    if (!r.matchedCount) return fail(res, 404, "Feedback not found");
    return res.json({ success: true, message: status === "reviewed" ? "Marked as reviewed" : "Marked as new" });
  } catch (error) {
    return serverError(res, error);
  }
};

// ------------------------------------------------------------ special bonus requests

// Window: 25th 00:00 IST to the last day of the month 23:59 IST.
export const bonusWindow = (now = new Date()) => {
  const ist = toIST(now);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const day = ist.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const month = `${y}-${String(m + 1).padStart(2, "0")}`;
  return { month, open: day >= 25, opensOn: `${month}-25`, closesOn: `${month}-${String(lastDay).padStart(2, "0")}` };
};

export const myBonusRequest = async (req, res) => {
  try {
    const window = bonusWindow();
    const request = await BonusRequest.findOne({ user: req.user._id, month: window.month }).lean();
    const history = await BonusRequest.find({ user: req.user._id }).sort({ month: -1 }).limit(12).lean();
    return res.json({ success: true, message: "Bonus request fetched", data: { window, request, history } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const submitBonusRequest = async (req, res) => {
  try {
    const window = bonusWindow();
    if (!window.open) {
      return fail(res, 409, `Bonus requests open from the 25th (${window.opensOn}) to the last day of the month (IST)`);
    }
    const reason = String(req.body?.reason || "").trim();
    if (reason.length < 20) return fail(res, 400, "Please explain in at least 20 characters");
    if (reason.length > 5000) return fail(res, 400, "At most 5000 characters");
    try {
      const request = await BonusRequest.create({ user: req.user._id, month: window.month, reason });
      const viewers = await User.find({ role: { $in: BONUS_REQUEST_VIEWERS }, isActive: true }).select("_id").lean();
      for (const v of viewers) {
        notify({ user: v._id, type: "bonus_request", title: `${req.user.name} submitted a special bonus request`, link: "/bonus-requests" });
      }
      return res.status(201).json({ success: true, message: "Bonus request submitted", data: { request } });
    } catch (error) {
      if (error.code === 11000) return fail(res, 409, "You have already submitted your bonus request for this month");
      throw error;
    }
  } catch (error) {
    return serverError(res, error);
  }
};

export const listBonusRequests = async (req, res) => {
  try {
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(req.query.month || "") ? req.query.month : bonusWindow().month;
    const requests = await BonusRequest.find({ month })
      .populate({ path: "user", select: "name email designation department", populate: { path: "department", select: "name" } })
      .sort({ createdAt: -1 })
      .lean();
    return res.json({ success: true, message: "Bonus requests fetched", data: { month, requests } });
  } catch (error) {
    return serverError(res, error);
  }
};
