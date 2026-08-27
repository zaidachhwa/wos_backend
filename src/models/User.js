import mongoose from "mongoose";

import { ROLES } from "../constants/roles.constants.js";

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    designation: { type: String, default: "" },
    department: { type: mongoose.Schema.Types.ObjectId, ref: "Department", default: null },
    // Only set (and required, enforced in the controller, not here) when
    // role === "subadmin" — the one department a sub-admin manages. Their
    // managed teams are resolved dynamically from this (see departmentScope.js),
    // not stored, so a team added to the department later is covered
    // automatically without re-assigning the sub-admin.
    managedDepartment: { type: mongoose.Schema.Types.ObjectId, ref: "Department", default: null },
    // Only set (and required, enforced in the controller) when role ===
    // "manager" — the single team a manager manages (narrower than a
    // sub-admin's whole department, per the hierarchy: sub-admin owns the
    // department, manager owns one team within it).
    managedTeam: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    // Only meaningful when role === "sublead" — the set of teams a sub-lead
    // manages (can be more than one, unlike manager's single team). Empty
    // until an admin/sub-admin explicitly assigns teams.
    managedTeams: [{ type: mongoose.Schema.Types.ObjectId, ref: "Team" }],
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Actual joining date, distinct from createdAt (when the account was
    // created — often later than when someone actually joined, e.g. a
    // backfilled account). Drives the appraisal tenure band (see
    // appraisalController.js) — defaults to createdAt via the pre-save hook
    // below so existing/unset users still get a sane tenure instead of null.
    joinedAt: { type: Date, default: null },
    // Per-employee morning follow-up deadline ("HH:mm", IST) — overrides the
    // org-wide default (see utils/attendanceConfig.js) for people whose
    // shift genuinely starts at a different time. null means "use the org
    // default". Set only by hr/admin, via PATCH /api/attendance/deadline/:userId.
    morningDeadline: { type: String, default: null },
    isActive: { type: Boolean, default: true },
    // Set the first time a matching account signs in via Google. Unique +
    // sparse so multiple users can each have no googleId without violating
    // the unique index — no `default` here on purpose: a sparse index only
    // excludes documents where the field is truly absent, not where it's
    // explicitly null, so defaulting to null would defeat the sparseness
    // after the second such user is created.
    googleId: { type: String, unique: true, sparse: true },
    refreshToken: { type: String, default: null, select: false },
    // Grace-period slot: keeps the previous refresh token valid for a short
    // window after rotation so a raced/duplicate refresh (2nd tab, retried
    // request) doesn't force-logout a still-valid session.
    previousRefreshToken: { type: String, default: null, select: false },
    previousRefreshTokenExpiresAt: { type: Date, default: null, select: false },
    icsToken: { type: String, default: null, select: false },
  },
  { timestamps: true }
);

userSchema.pre("save", function setDefaultJoinedAt() {
  if (this.isNew && !this.joinedAt) this.joinedAt = new Date();
});

export default mongoose.model("User", userSchema);
