import mongoose from "mongoose";

// Singleton: one document holds the admin/hr-editable minimum-completed-
// tasks-before-a-score-shows threshold, per tenure band. Band boundaries
// (6 months, 12 months) are fixed; only the threshold per band is tunable —
// see appraisalController.js's tenureBandFor/minTasksFor.
const appraisalConfigSchema = new mongoose.Schema(
  {
    minTasksNew: { type: Number, required: true, default: 3 }, // 0–6 months tenure
    minTasksMid: { type: Number, required: true, default: 5 }, // 6–12 months tenure
    minTasksSenior: { type: Number, required: true, default: 8 }, // 12+ months tenure
  },
  { timestamps: true }
);

export default mongoose.model("AppraisalConfig", appraisalConfigSchema);
