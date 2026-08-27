import mongoose from "mongoose";

// Singleton: one document holds the org-wide morning follow-up deadline
// HR/admin set — the cutoff the attendance sweep judges "late" against.
const attendanceConfigSchema = new mongoose.Schema(
  {
    morningDeadline: { type: String, required: true, default: "10:00" }, // "HH:mm", IST
    // Office geofence — follow-up submissions are only accepted within
    // officeRadiusMeters of this point (see utils/geo.js). null lat/lng
    // means the geofence isn't set up yet, so it's skipped entirely.
    officeLat: { type: Number, default: null },
    officeLng: { type: Number, default: null },
    officeRadiusMeters: { type: Number, default: 300 },
  },
  { timestamps: true }
);

export default mongoose.model("AttendanceConfig", attendanceConfigSchema);
