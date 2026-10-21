import crypto from "node:crypto";

import mongoose from "mongoose";

export const FEEDBACK_CATEGORIES = ["general", "workplace", "management", "process", "suggestion", "other"];

// Anonymous by construction: there is NO sender field of any kind (no user
// id, email, IP or device), the id is a random UUID instead of an ObjectId
// (an ObjectId embeds its creation second, which could be matched against
// request logs), and only the IST calendar day is kept — no timestamps.
// Do not add any field that could identify who wrote it.
const anonymousFeedbackSchema = new mongoose.Schema(
  {
    _id: { type: String, default: () => crypto.randomUUID() },
    message: { type: String, required: true, trim: true, maxlength: 5000 },
    category: { type: String, enum: FEEDBACK_CATEGORIES, default: "general" },
    day: { type: String, required: true }, // "YYYY-MM-DD", IST
    status: { type: String, enum: ["new", "reviewed"], default: "new" },
  },
  { timestamps: false, versionKey: false }
);

anonymousFeedbackSchema.index({ day: -1 });

export default mongoose.model("AnonymousFeedback", anonymousFeedbackSchema);
