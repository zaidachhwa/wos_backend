import { FOLLOWUP_TYPES } from "../constants/enums.constants.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const validateFollowUpUpsert = (req, res, next) => {
  const { date, type, data, submit, lat, lng } = req.body;
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ success: false, message: "date must be in YYYY-MM-DD format" });
  }
  if (!FOLLOWUP_TYPES.includes(type)) {
    return res
      .status(400)
      .json({ success: false, message: `type must be one of ${FOLLOWUP_TYPES.join(", ")}` });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ success: false, message: "data is required" });
  }
  // lat/lng are optional (skipped entirely when no office location is
  // configured — see upsertFollowUp) but must be real numbers when sent.
  if (submit === true && lat !== undefined && (typeof lat !== "number" || typeof lng !== "number")) {
    return res.status(400).json({ success: false, message: "lat and lng must both be numbers" });
  }
  
  if (type === "evening" && submit === true) {
    if (!data.projects || !Array.isArray(data.projects)) {
      return res.status(400).json({ success: false, message: "Project allocations are required for evening follow-up" });
    }
    const totalMinutes = data.projects.reduce((acc, p) => acc + (Number(p.totalMinutes) || 0), 0);
    if (totalMinutes < 480) {
      return res.status(400).json({ success: false, message: "Your total recorded working time is less than 8 hours. Please complete at least 8 hours before submitting your Evening Follow-up." });
    }
  }
  
  next();
};
