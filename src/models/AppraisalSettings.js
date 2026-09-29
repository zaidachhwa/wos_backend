import mongoose from "mongoose";

const severitySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    penalty: { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: false }
);

const clientChangeCategorySchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    // Only categories that are the employee's fault should count against them.
    countsAgainstEmployee: { type: Boolean, default: false },
  },
  { _id: false }
);

const classificationSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    min: { type: Number, required: true },
    max: { type: Number, required: true },
    tone: { type: String, enum: ["danger", "warning", "success", "info", "muted"], default: "muted" },
    emailMessage: { type: String, default: "" },
    showImprovementAreas: { type: Boolean, default: false },
  },
  { _id: false }
);

// Singleton: org-wide appraisal configuration other than the criteria
// themselves (models/AppraisalCriterion.js). `version` bumps on every save
// and is stamped onto snapshots so a finalized appraisal says which config
// revision produced it.
const appraisalSettingsSchema = new mongoose.Schema(
  {
    version: { type: Number, default: 1 },
    bugSeverities: { type: [severitySchema], default: [] },
    // Bug statuses that count toward the penalty. "reported" (a TL report
    // HR hasn't reviewed yet) and "rejected" don't count by default.
    bugCountableStatuses: { type: [String], default: ["confirmed", "resolved"] },
    clientChangeCategories: { type: [clientChangeCategorySchema], default: [] },
    // Whether an isClientChange task nobody has categorized yet counts
    // against the employee. Default false: never assume it was their fault.
    uncategorizedClientChangeCounts: { type: Boolean, default: false },
    classifications: { type: [classificationSchema], default: [] },
    // Decimals the total is rounded to before looking up its classification
    // band (0 => bands are whole numbers, 35.4 -> 35 -> band 0–35).
    classificationDecimals: { type: Number, default: 0, min: 0, max: 2 },
    improvementRule: {
      thresholdPct: { type: Number, default: 60, min: 0, max: 100 },
      maxItems: { type: Number, default: 3, min: 1, max: 10 },
    },
    // Roles that get a monthly appraisal (same default set the attendance
    // sweep tracks — see services/attendanceSweep.js TRACKED_ROLES).
    appraisedRoles: { type: [String], default: ["manager", "sublead", "member", "qa"] },
    automation: {
      // "complete" = at month close (1st, 00:01 IST) auto-finalize every
      // appraisal with all HR inputs/ratings present; "submitted" = only
      // those HR explicitly submitted; "off" = HR finalizes everything by hand.
      autoFinalizeMode: { type: String, enum: ["complete", "submitted", "off"], default: "complete" },
      emailsEnabled: { type: Boolean, default: true },
      maxEmailAttempts: { type: Number, default: 3, min: 1, max: 10 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

export default mongoose.model("AppraisalSettings", appraisalSettingsSchema);
