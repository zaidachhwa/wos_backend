import mongoose from "mongoose";

// Singleton: exactly one document holds the admin-editable point values.
const leaderboardConfigSchema = new mongoose.Schema(
  {
    pointsByPriority: {
      low: { type: Number, required: true },
      medium: { type: Number, required: true },
      high: { type: Number, required: true },
    },
    penalties: {
      completedLate: { type: Number, required: true },
      overdue: { type: Number, required: true },
      bug: { type: Number, required: true },
    },
    // Weights for the monthly performance score (appraisalController.js).
    monthlyPenalties: {
      leave: { type: Number, default: 1 },
      lateMark: { type: Number, default: 1 },
      clientChange: { type: Number, default: 1 },
      bug: { type: Number, default: 1 },
    },
    // null fields = not configured yet; follow-up submission geofencing is
    // skipped entirely until an admin sets this.
    officeLocation: {
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      radiusMeters: { type: Number, default: null },
    },
  },
  { timestamps: true }
);

export default mongoose.model("LeaderboardConfig", leaderboardConfigSchema);
