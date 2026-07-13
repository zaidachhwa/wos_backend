import mongoose from "mongoose";

import { ACTIVITY_ENTITY_TYPES } from "../constants/enums.constants.js";

const activitySchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
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
