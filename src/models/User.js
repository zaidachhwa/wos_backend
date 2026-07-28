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
    // managed teams are resolved dynamically from this (see subadminScope.js),
    // not stored, so a team added to the department later is covered
    // automatically without re-assigning the sub-admin.
    managedDepartment: { type: mongoose.Schema.Types.ObjectId, ref: "Department", default: null },
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
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

export default mongoose.model("User", userSchema);
