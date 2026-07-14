import mongoose from "mongoose";

import { PRIORITIES, TASK_STATUSES } from "../constants/enums.constants.js";

const subtaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    done: { type: Boolean, default: false },
  },
  { _id: true }
);

const commentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const taskSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    module: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectModule", default: null },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    collaborators: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    status: { type: String, enum: TASK_STATUSES, default: "backlog" },
    estimatedHours: { type: Number, default: null },
    actualHours: { type: Number, default: null },
    deadline: { type: Date, default: null },
    labels: [{ type: String }],
    subtasks: [subtaskSchema],
    comments: [commentSchema],
  },
  { timestamps: true }
);

export default mongoose.model("Task", taskSchema);
