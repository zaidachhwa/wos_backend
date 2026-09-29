import mongoose from "mongoose";

import { BUG_STATUSES } from "../constants/appraisal.constants.js";

const bugCommentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    text: { type: String, required: true, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

// A defect attributed to an employee, for appraisal purposes. Distinct from
// a Task with type "bug" — that's the fix *work item* (assignment, kanban,
// points). A report can point at one via `task`, but penalizing someone is
// this record's job, so it carries what a Task doesn't: the responsible
// employee, severity, reporter role and an HR review status.
const bugReportSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", default: null },
    task: { type: mongoose.Schema.Types.ObjectId, ref: "Task", default: null },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    // Key into AppraisalSettings.bugSeverities — not an enum, so HR can add levels.
    severity: { type: String, required: true },
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // IST calendar day, like FollowUp.date
    status: { type: String, enum: BUG_STATUSES, default: "reported" },
    includeInAppraisal: { type: Boolean, default: true },
    exclusionReason: { type: String, default: "" },
    resolution: { type: String, default: "" },
    resolvedAt: { type: Date, default: null },
    reportedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    reporterRole: { type: String, required: true },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    reviewedAt: { type: Date, default: null },
    comments: { type: [bugCommentSchema], default: [] },
  },
  { timestamps: true }
);

bugReportSchema.index({ employee: 1, date: 1 });
bugReportSchema.index({ date: 1, status: 1 });

export default mongoose.model("BugReport", bugReportSchema);
