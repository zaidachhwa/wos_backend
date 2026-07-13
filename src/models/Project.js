import mongoose from "mongoose";

import { PRIORITIES, PROJECT_STATUSES } from "../constants/enums.constants.js";

const projectSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    manager: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    startDate: { type: Date, default: null },
    deadline: { type: Date, default: null },
    status: { type: String, enum: PROJECT_STATUSES, default: "planning" },
  },
  { timestamps: true }
);

export default mongoose.model("Project", projectSchema);
