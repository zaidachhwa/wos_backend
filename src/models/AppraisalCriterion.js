import mongoose from "mongoose";

import { CRITERION_TYPES, SCORING_METHODS } from "../constants/appraisal.constants.js";

const ratingOptionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    pct: { type: Number, required: true, min: 0, max: 100 },
  },
  { _id: false }
);

// One configurable appraisal criterion. Never hard-deleted once it has been
// used by a finalized appraisal (usedInFinalized) — deactivate instead, so
// history stays intact. Finalized appraisals also carry their own full copy
// of every criterion they used (EmployeeAppraisal.configSnapshot), so edits
// here never reach back into history.
const appraisalCriterionSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    type: { type: String, enum: CRITERION_TYPES, required: true },
    // Percent of the 100-point total. Active criteria must sum to exactly 100.
    weightage: { type: Number, required: true, min: 0, max: 100 },
    // Automatic/hybrid only — key into METRICS (appraisal.constants.js).
    metric: { type: String, default: null },
    scoringMethod: { type: String, enum: SCORING_METHODS, required: true },
    // Method parameters: { target } | { unitPct, freeUnits, floorPct } |
    // { bands: [{ min, max, pct }] }, plus { noDataPct } for ratio metrics
    // with nothing to measure (e.g. no tasks in the month).
    params: { type: mongoose.Schema.Types.Mixed, default: {} },
    ratingOptions: { type: [ratingOptionSchema], default: [] },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    group: { type: String, enum: ["automatic", "hr_metric", "hr_evaluation"], default: "automatic" },
    usedInFinalized: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

appraisalCriterionSchema.index({ isActive: 1, sortOrder: 1 });

export default mongoose.model("AppraisalCriterion", appraisalCriterionSchema);
