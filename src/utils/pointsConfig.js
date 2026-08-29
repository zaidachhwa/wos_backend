import LeaderboardConfig from "../models/LeaderboardConfig.js";
import { POINTS_BY_PRIORITY as DEFAULT_POINTS, PENALTIES as DEFAULT_PENALTIES } from "../constants/points.constants.js";

const DEFAULT_MONTHLY_PENALTIES = { leave: 1, lateMark: 1, clientChange: 1, bug: 1 };
const DEFAULT_OFFICE_LOCATION = { lat: null, lng: null, radiusMeters: null };

// In-memory cache so points.js can stay synchronous — refreshed on boot and
// on every admin update. Small/rare writes, so no cache-invalidation edge cases.
let currentPoints = { ...DEFAULT_POINTS };
let currentPenalties = { ...DEFAULT_PENALTIES };
let currentMonthlyPenalties = { ...DEFAULT_MONTHLY_PENALTIES };
let currentOfficeLocation = { ...DEFAULT_OFFICE_LOCATION };

export const getPointsByPriority = () => currentPoints;
export const getPenalties = () => currentPenalties;
export const getMonthlyPenalties = () => currentMonthlyPenalties;
export const getOfficeLocation = () => currentOfficeLocation;

export const loadPointsConfig = async () => {
  const doc = await LeaderboardConfig.findOne();
  if (doc) {
    const obj = doc.toObject();
    currentPoints = { ...DEFAULT_POINTS, ...obj.pointsByPriority };
    currentPenalties = { ...DEFAULT_PENALTIES, ...obj.penalties };
    currentMonthlyPenalties = { ...DEFAULT_MONTHLY_PENALTIES, ...obj.monthlyPenalties };
    currentOfficeLocation = { ...DEFAULT_OFFICE_LOCATION, ...obj.officeLocation };
  }
};

// $set with every field group's *current* in-memory value (not just the one
// being changed) — findOneAndUpdate with a bare object replaces the whole
// document, which would otherwise wipe sibling groups; this also keeps
// pointsByPriority/penalties' required fields satisfied on the very first
// write, whichever setter is called first.
const persist = async (overrides) =>
  LeaderboardConfig.findOneAndUpdate(
    {},
    {
      $set: {
        pointsByPriority: currentPoints,
        penalties: currentPenalties,
        monthlyPenalties: currentMonthlyPenalties,
        officeLocation: currentOfficeLocation,
        ...overrides,
      },
    },
    { upsert: true, runValidators: true }
  );

export const setPointsByPriority = async (values) => {
  const next = { ...values };
  await persist({ pointsByPriority: next });
  currentPoints = next;
  return currentPoints;
};

export const setPenalties = async (values) => {
  const next = { ...values };
  await persist({ penalties: next });
  currentPenalties = next;
  return currentPenalties;
};

export const setMonthlyPenalties = async (values) => {
  const next = { ...values };
  await persist({ monthlyPenalties: next });
  currentMonthlyPenalties = next;
  return currentMonthlyPenalties;
};

export const setOfficeLocation = async (values) => {
  const next = { ...values };
  await persist({ officeLocation: next });
  currentOfficeLocation = next;
  return currentOfficeLocation;
};
