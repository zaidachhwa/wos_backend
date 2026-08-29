import mongoose from "mongoose";

const teamSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    department: { type: mongoose.Schema.Types.ObjectId, ref: "Department", required: true },
    // Monthly-performance band cutoffs for this team's members: score < red
    // -> Red, red <= score < yellow -> Yellow, score >= yellow -> Green.
    // Defaults match the colors appraisal/page.js already used before these
    // were configurable (>=80 green, >=50 yellow, else red).
    performanceThresholds: {
      red: { type: Number, default: 50 },
      yellow: { type: Number, default: 80 },
    },
  },
  { timestamps: true }
);

export default mongoose.model("Team", teamSchema);
