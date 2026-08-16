import mongoose from "mongoose";

import { PRIORITIES, PROJECT_STATUSES, PROJECT_TYPES } from "../constants/enums.constants.js";

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    // Added to every completed task's points for this project — see
    // utils/points.js pointsForCompletedTask.
    weightage: { type: Number, default: 0, min: 0 },
    startDate: { type: Date, default: null },
    deadline: { type: Date, default: null },
    status: { type: String, enum: PROJECT_STATUSES, default: "planning" },
    type: { type: String, enum: PROJECT_TYPES, required: true, default: "internal" },
  },
  { timestamps: true }
);

export default mongoose.model("Project", projectSchema);
