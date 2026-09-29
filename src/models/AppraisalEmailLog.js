import mongoose from "mongoose";

import { EMAIL_STATUSES } from "../constants/appraisal.constants.js";

// One row per finalized appraisal's monthly email. The unique `appraisal`
// index + the atomic pending/failed -> processing claim in
// services/appraisal/appraisalEmails.js are what make a double scheduler run
// unable to send twice.
const appraisalEmailLogSchema = new mongoose.Schema(
  {
    appraisal: { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeAppraisal", required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    month: { type: String, required: true },
    recipient: { type: String, required: true },
    subject: { type: String, required: true },
    status: { type: String, enum: EMAIL_STATUSES, default: "pending" },
    attempts: { type: Number, default: 0 },
    retryCount: { type: Number, default: 0 },
    lastError: { type: String, default: "" },
    nextAttemptAt: { type: Date, default: null },
    processingStartedAt: { type: Date, default: null },
    sentAt: { type: Date, default: null },
    providerMessageId: { type: String, default: null },
  },
  { timestamps: true }
);

appraisalEmailLogSchema.index({ status: 1, nextAttemptAt: 1 });
appraisalEmailLogSchema.index({ month: 1, status: 1 });

export default mongoose.model("AppraisalEmailLog", appraisalEmailLogSchema);
