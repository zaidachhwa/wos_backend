import mongoose from "mongoose";
import { EVALUATION_FREQUENCIES, PERFORMANCE_RATINGS } from "../constants/appraisal.constants.js";

const performanceEvaluationSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    criterion: { type: mongoose.Schema.Types.ObjectId, ref: "AppraisalCriterion", required: true, index: true },
    evaluator: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    period: {
      frequency: { type: String, enum: EVALUATION_FREQUENCIES, required: true },
      // YYYY-MM-DD
      startDate: { type: String, required: true },
      endDate: { type: String, required: true },
      // YYYY-MM
      month: { type: String, required: true, index: true },
    },
    rating: { type: String, enum: PERFORMANCE_RATINGS, required: true },
    numericScore: { type: Number, required: true, min: 0, max: 100 },
    comment: { type: String, default: "", maxlength: 2000 },
    recordedAt: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true }
);

// Prevent duplicate evaluation entry for the same employee, criterion, and evaluation period
performanceEvaluationSchema.index(
  { employee: 1, criterion: 1, "period.startDate": 1, "period.endDate": 1 },
  { unique: true }
);

export default mongoose.model("PerformanceEvaluation", performanceEvaluationSchema);
