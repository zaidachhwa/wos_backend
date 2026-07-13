import mongoose from "mongoose";

import { FOLLOWUP_STATUSES, FOLLOWUP_TYPES } from "../constants/enums.constants.js";

const followUpSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    date: { type: String, required: true }, // "YYYY-MM-DD"
    type: { type: String, enum: FOLLOWUP_TYPES, required: true },
    status: { type: String, enum: FOLLOWUP_STATUSES, default: "draft" },
    morning: {
      yesterdayCompleted: { type: String, default: "" },
      todayPlan: { type: String, default: "" },
      blockers: { type: String, default: "" },
      estimatedHours: { type: Number, default: null },
    },
    evening: {
      completedWork: { type: String, default: "" },
      remainingWork: { type: String, default: "" },
      tomorrowPlan: { type: String, default: "" },
      actualHours: { type: Number, default: null },
      challenges: { type: String, default: "" },
    },
    managerComment: { type: String, default: "" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    submittedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

followUpSchema.index({ user: 1, date: 1, type: 1 }, { unique: true });

export default mongoose.model("FollowUp", followUpSchema);
