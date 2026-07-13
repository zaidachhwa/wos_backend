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
    team: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    isActive: { type: Boolean, default: true },
    refreshToken: { type: String, default: null, select: false },
    icsToken: { type: String, default: null, select: false },
  },
  { timestamps: true }
);

export default mongoose.model("User", userSchema);
