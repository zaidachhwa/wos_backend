import { TIMEBLOCK_CATEGORIES } from "../constants/enums.constants.js";

export const validateTimeBlockCreate = (req, res, next) => {
  const { title, start, end, category } = req.body;
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: "title is required" });
  }
  if (!start || Number.isNaN(new Date(start).getTime())) {
    return res.status(400).json({ success: false, message: "start is required" });
  }
  if (!end || Number.isNaN(new Date(end).getTime())) {
    return res.status(400).json({ success: false, message: "end is required" });
  }
  if (!TIMEBLOCK_CATEGORIES.includes(category)) {
    return res.status(400).json({ success: false, message: "category is invalid" });
  }
  if (!(new Date(end) > new Date(start))) {
    return res.status(400).json({ success: false, message: "end must be after start" });
  }
  next();
};
