import mongoose from "mongoose";

// One row per IST month the month-close job has touched. Its atomic
// open -> closing -> closed transition (with a lock expiry for a crashed
// run) is what stops two scheduler ticks/instances closing the same month.
const appraisalPeriodSchema = new mongoose.Schema(
  {
    month: { type: String, required: true, unique: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    // When the previous-month emails become due: 1st of next month, 00:01 IST.
    emailDueAt: { type: Date, required: true },
    status: { type: String, enum: ["open", "closing", "closed"], default: "open" },
    lockedUntil: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    closeSummary: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

export default mongoose.model("AppraisalPeriod", appraisalPeriodSchema);
