import mongoose from "mongoose";

// Singleton: exactly one document holds the admin-editable point values.
const leaderboardConfigSchema = new mongoose.Schema(
  {
    pointsByPriority: {
      low: { type: Number, required: true },
      medium: { type: Number, required: true },
      high: { type: Number, required: true },
      critical: { type: Number, required: true },
    },
  },
  { timestamps: true }
);

export default mongoose.model("LeaderboardConfig", leaderboardConfigSchema);
