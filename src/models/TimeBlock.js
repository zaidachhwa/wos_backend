import mongoose from "mongoose";

import { TIMEBLOCK_CATEGORIES } from "../constants/enums.constants.js";

const timeBlockSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    title: { type: String, required: true, trim: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    description: { type: String, default: "" },
    category: { type: String, enum: TIMEBLOCK_CATEGORIES, required: true },
    color: { type: String, default: "" },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("TimeBlock", timeBlockSchema);
