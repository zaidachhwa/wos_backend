import mongoose from "mongoose";

import { ACTIVITY_ENTITY_TYPES } from "../constants/enums.constants.js";

const activitySchema = new mongoose.Schema(
  {
    // Most activity is attributed to the acting user. A few are system-
    // triggered (e.g. the overdue-penalty sweep in services/overdueSweep.js)
    // and have no human actor — ActivityFeed.jsx already renders these as
    // "Someone".
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true },
    entityType: { type: String, enum: ACTIVITY_ENTITY_TYPES, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

activitySchema.index({ project: 1, createdAt: -1 });

export default mongoose.model("Activity", activitySchema);
