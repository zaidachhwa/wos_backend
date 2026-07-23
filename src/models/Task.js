import mongoose from "mongoose";

import { PRIORITIES, TASK_STATUSES, TASK_APPROVAL_STATUSES } from "../constants/enums.constants.js";

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

const recurrenceSchema = new mongoose.Schema(
  { frequency: { type: String, enum: ["daily", "weekly", "monthly"], required: true }, interval: { type: Number, default: 1, min: 1 } },
  { _id: false }
);

const taskSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    module: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectModule", default: null },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    assignees: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    // Not `required` — tasks created before this field existed have none,
    // and forcing it would break saving on every pre-existing task. Only
    // read for approval-pipeline permission checks, which only apply to
    // tasks created after this field shipped.
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvalStatus: { type: String, enum: TASK_APPROVAL_STATUSES, default: "not_required" },
    approvalComment: { type: String, default: "" },
    priority: { type: String, enum: PRIORITIES, default: "medium" },
    status: { type: String, enum: TASK_STATUSES, default: "backlog" },
    estimatedHours: { type: Number, default: null },
    actualHours: { type: Number, default: null },
    deadline: { type: Date, default: null },
    // Time-of-day on `deadline`'s date, "HH:mm" — not a separate Date, to
    // avoid drifting out of sync with `deadline` if only one is edited.
    startTime: { type: String, default: null },
    endTime: { type: String, default: null },
    // Senior-awarded discretionary bonus for the leaderboard, capped at
    // maxBonusFor(priority) — see utils/points.js.
    bonusPoints: { type: Number, default: 0, min: 0 },
    labels: [{ type: String }],
    subtasks: [subtaskSchema],
    comments: [commentSchema],
    // Set once at creation — the day this task entered someone's "Today". Not
    // touched by later edits/reassignment; drives the Today/Yesterday split.
    assignedDate: { type: Date, default: Date.now },
    // Display-only — nothing enforces these being done first (see design decision).
    blockedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: "Task" }],
    // Present + non-null means "recurring"; null means one-off (default).
    recurrence: { type: recurrenceSchema, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("Task", taskSchema);
