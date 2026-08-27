import AttendanceConfig from "../models/AttendanceConfig.js";

// Same in-memory-cache-over-a-singleton-doc shape as pointsConfig.js — kept
// synchronous for the sweep's inner loop and the follow-up submit path,
// refreshed on boot and on every admin/hr update.
const DEFAULT_DEADLINE = "10:00";
const DEFAULT_RADIUS = 300;
let currentDeadline = DEFAULT_DEADLINE;
let currentOffice = { lat: null, lng: null, radiusMeters: DEFAULT_RADIUS };

export const getMorningDeadline = () => currentDeadline;
// null lat/lng means the geofence hasn't been set up yet — callers treat a
// null return as "skip the check", not "reject everything".
export const getOfficeLocation = () =>
  currentOffice.lat === null || currentOffice.lng === null ? null : currentOffice;

export const loadAttendanceConfig = async () => {
  const doc = await AttendanceConfig.findOne();
  if (doc) {
    currentDeadline = doc.morningDeadline;
    currentOffice = { lat: doc.officeLat, lng: doc.officeLng, radiusMeters: doc.officeRadiusMeters };
  }
};

export const setMorningDeadline = async (value) => {
  await AttendanceConfig.findOneAndUpdate({}, { morningDeadline: value }, { upsert: true, runValidators: true });
  currentDeadline = value;
  return currentDeadline;
};

export const setOfficeLocation = async ({ lat, lng, radiusMeters }) => {
  const next = {
    lat,
    lng,
    radiusMeters: radiusMeters ?? currentOffice.radiusMeters ?? DEFAULT_RADIUS,
  };
  await AttendanceConfig.findOneAndUpdate(
    {},
    { officeLat: next.lat, officeLng: next.lng, officeRadiusMeters: next.radiusMeters },
    { upsert: true, runValidators: true }
  );
  currentOffice = next;
  return currentOffice;
};
