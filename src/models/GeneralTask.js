import mongoose from "mongoose";

// One assignee's progress on a general task. Each assignee completes the
// task for themselves, so on-time/late/overdue is tracked per person.
const assignmentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

// A simple, project-less task the Director hands out from the "General"
// section. Deliberately separate from Task: it never appears on project
// boards, in leaderboard points or in appraisal scores.
const generalTaskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, default: "", maxlength: 5000 },
    dueAt: { type: Date, required: true },
    assignments: { type: [assignmentSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

generalTaskSchema.index({ createdBy: 1, dueAt: -1 });
generalTaskSchema.index({ "assignments.user": 1, dueAt: -1 });

export default mongoose.model("GeneralTask", generalTaskSchema);
