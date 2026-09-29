import mongoose from "mongoose";

import { APPRAISAL_STATUSES, CRITERION_TYPES } from "../constants/appraisal.constants.js";

// HR's per-criterion input: a rating (manual) or an adjustment (hybrid).
// Keyed by criterion key, kept apart from the computed `entries` so a
// recalculation never wipes what HR typed.
const evaluationSchema = new mongoose.Schema(
  {
    criterionKey: { type: String, required: true },
    ratingKey: { type: String, default: null },
    overridePct: { type: Number, default: null, min: 0, max: 100 },
    overrideReason: { type: String, default: "" },
    comment: { type: String, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedAt: { type: Date, default: null },
  },
  { _id: false }
);

// One computed criterion line — a self-contained explanation of where its
// score came from (weightage, method, params, metric value, steps).
const entrySchema = new mongoose.Schema(
  {
    criterionKey: { type: String, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: CRITERION_TYPES, required: true },
    group: { type: String, default: "automatic" },
    weightage: { type: Number, required: true },
    metric: { type: String, default: null },
    scoringMethod: { type: String, required: true },
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    metricValue: { type: Number, default: null },
    metricDetails: { type: mongoose.Schema.Types.Mixed, default: null },
    systemPct: { type: Number, default: null },
    ratingKey: { type: String, default: null },
    ratingLabel: { type: String, default: null },
    overridePct: { type: Number, default: null },
    overrideReason: { type: String, default: "" },
    comment: { type: String, default: "" },
    performancePct: { type: Number, default: null },
    score: { type: Number, default: 0 },
    maxScore: { type: Number, default: 0 },
    complete: { type: Boolean, default: true },
    noData: { type: Boolean, default: false },
    source: { type: String, default: "" },
    steps: [{ type: String }],
  },
  { _id: false }
);

const reopenSchema = new mongoose.Schema(
  {
    by: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    at: { type: Date, default: Date.now },
    reason: { type: String, required: true },
    oldScore: { type: Number, required: true },
    oldClassification: { type: String, default: null },
    newScore: { type: Number, default: null },
    newClassification: { type: String, default: null },
    refinalizedAt: { type: Date, default: null },
    changes: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: true }
);

// One employee's appraisal for one IST calendar month. Created lazily as a
// draft (first HR input, dashboard load, or month close) and recalculated
// live until finalized; from then on it's an immutable snapshot — nothing
// re-derives it from tasks/bugs/config again unless HR reopens it.
const employeeAppraisalSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ }, // "YYYY-MM", IST
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    status: { type: String, enum: APPRAISAL_STATUSES, default: "draft" },

    // HR-entered monthly numbers — the ONLY source for appraisal
    // leaves/late marks. null = not entered yet.
    hrInputs: {
      leaves: { type: Number, default: null, min: 0 },
      lateMarks: { type: Number, default: null, min: 0 },
      notes: { type: String, default: "" },
      updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
      updatedAt: { type: Date, default: null },
    },
    evaluations: { type: [evaluationSchema], default: [] },

    entries: { type: [entrySchema], default: [] },
    totalScore: { type: Number, default: 0 },
    classification: {
      key: { type: String, default: null },
      label: { type: String, default: null },
      tone: { type: String, default: null },
    },
    improvementAreas: [{ criterionKey: String, name: String, score: Number, maxScore: Number, performancePct: Number }],
    missingInputs: [{ type: String }],
    metricsSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    configSnapshot: { type: mongoose.Schema.Types.Mixed, default: null },
    // Who the employee was at finalization (name/department/designation can
    // change later; the historical record shouldn't).
    employeeSnapshot: {
      name: String,
      email: String,
      role: String,
      designation: String,
      departmentId: { type: mongoose.Schema.Types.ObjectId, default: null },
      departmentName: String,
      teamName: String,
    },
    department: { type: mongoose.Schema.Types.ObjectId, ref: "Department", default: null },
    calculatedAt: { type: Date, default: null },
    evaluator: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    submittedAt: { type: Date, default: null },
    finalizedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    finalizedAt: { type: Date, default: null },
    autoFinalized: { type: Boolean, default: false },
    reopenHistory: { type: [reopenSchema], default: [] },
    // Set once an AppraisalEmailLog row exists for this appraisal — lets the
    // email queue find new finalized appraisals without scanning history.
    emailQueuedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// One appraisal per employee per month — also the month-close job's
// idempotency guard (drafts are upserted, never blindly inserted).
employeeAppraisalSchema.index({ user: 1, month: 1 }, { unique: true });
employeeAppraisalSchema.index({ month: 1, status: 1 });
employeeAppraisalSchema.index({ month: 1, department: 1 });
employeeAppraisalSchema.index({ status: 1, emailQueuedAt: 1, periodEnd: 1 });

export default mongoose.model("EmployeeAppraisal", employeeAppraisalSchema);
