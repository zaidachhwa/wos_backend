import mongoose from "mongoose";

import { AUDIT_ACTIONS } from "../constants/appraisal.constants.js";

// Append-only trail for the appraisal module. Separate from Activity (the
// project/task feed) so HR-sensitive history never shows up in project feeds.
const appraisalAuditLogSchema = new mongoose.Schema(
  {
    actor: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // null = system job
    action: { type: String, enum: AUDIT_ACTIONS, required: true },
    entityType: { type: String, required: true }, // criterion | settings | appraisal | bug | task | email | period
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    subject: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // employee affected
    month: { type: String, default: null },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

appraisalAuditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
appraisalAuditLogSchema.index({ subject: 1, createdAt: -1 });
appraisalAuditLogSchema.index({ createdAt: -1 });

export default mongoose.model("AppraisalAuditLog", appraisalAuditLogSchema);
