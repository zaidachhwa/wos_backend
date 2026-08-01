import mongoose from "mongoose";

// One row per pre-existing Project whose manager/members span more than one
// department under the new department-segregation rule (2026-07-30). Written
// once by migrate-manager-departments.js; not auto-fixed, surfaced for an
// admin to review at their own pace.
const departmentViolationSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    departments: [{ type: mongoose.Schema.Types.ObjectId, ref: "Department" }],
    flaggedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model("DepartmentViolation", departmentViolationSchema);
