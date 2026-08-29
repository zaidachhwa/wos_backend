import mongoose from "mongoose";

// One memo per (user, month) — a red-band month. The unique index below is
// also the monthly sweep's idempotency guard: a re-run (including after an
// admin voids a memo) never creates a second row for the same month.
const memoSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", required: true },
    month: { type: String, required: true }, // "YYYY-MM"
    score: { type: Number, required: true },
    // Snapshot of the team's thresholds at issue time — a later threshold
    // edit must not rewrite what this memo's band decision was based on.
    thresholds: {
      red: { type: Number, required: true },
      yellow: { type: Number, required: true },
    },
    // 1-based count of this user's non-voided memos, including this one.
    sequenceNumber: { type: Number, required: true },
    consequence: { type: String, enum: ["review_delay", "termination_flag"], required: true },
    emailSent: { type: Boolean, default: false },
    // The admin "reset memos" action sets this rather than deleting rows,
    // preserving history while excluding the memo from the live count.
    voided: { type: Boolean, default: false },
  },
  { timestamps: true }
);

memoSchema.index({ user: 1, month: 1 }, { unique: true });

export default mongoose.model("Memo", memoSchema);
