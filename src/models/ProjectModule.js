import mongoose from "mongoose";

import { PROJECT_STATUSES } from "../constants/enums.constants.js";

// Model name "ProjectModule" (not "Module" — that collides with Node's own global).
const projectModuleSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    deadline: { type: Date, default: null },
    lead: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    status: { type: String, enum: PROJECT_STATUSES, default: "planning" },
  },
  { timestamps: true }
);

export default mongoose.model("ProjectModule", projectModuleSchema);
