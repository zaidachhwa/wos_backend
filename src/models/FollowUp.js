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
      projects: [{
        project: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
        hours: { type: Number, required: true },
        minutes: { type: Number, required: true },
        totalMinutes: { type: Number, required: true }
      }]
    },
    managerComment: { type: String, default: "" },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    submittedAt: { type: Date, default: null },
    // Where the submit happened — set only on a real submit (never on a
    // draft save), and only once the office geofence is configured. Kept
    // for audit (how far from the office someone was) even though the
    // submit itself is already rejected if it's outside the radius.
    submitLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      distanceMeters: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

followUpSchema.index({ user: 1, date: 1, type: 1 }, { unique: true });

export default mongoose.model("FollowUp", followUpSchema);
