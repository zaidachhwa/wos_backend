import mongoose from "mongoose";

// An employee's once-a-month case for why they deserve a special bonus,
// submitted between the 25th and the last day of the month (IST). Seen by
// HR, Admin and Directors, who can then grant a Special Bonus % on the
// appraisal. The unique (user, month) index enforces "only once".
const bonusRequestSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    month: { type: String, required: true, match: /^\d{4}-(0[1-9]|1[0-2])$/ },
    reason: { type: String, required: true, trim: true, maxlength: 5000 },
  },
  { timestamps: true }
);

bonusRequestSchema.index({ user: 1, month: 1 }, { unique: true });
bonusRequestSchema.index({ month: 1, createdAt: -1 });

export default mongoose.model("BonusRequest", bonusRequestSchema);
