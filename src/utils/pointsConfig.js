import LeaderboardConfig from "../models/LeaderboardConfig.js";
import { POINTS_BY_PRIORITY as DEFAULT_POINTS, PENALTIES as DEFAULT_PENALTIES } from "../constants/points.constants.js";

// In-memory cache so points.js can stay synchronous — refreshed on boot and
// on every admin update. Small/rare writes, so no cache-invalidation edge cases.
let currentPoints = { ...DEFAULT_POINTS };
let currentPenalties = { ...DEFAULT_PENALTIES };

export const getPointsByPriority = () => currentPoints;
export const getPenalties = () => currentPenalties;

export const loadPointsConfig = async () => {
  const doc = await LeaderboardConfig.findOne();
  if (doc) {
    const obj = doc.toObject();
    currentPoints = { ...DEFAULT_POINTS, ...obj.pointsByPriority };
    currentPenalties = { ...DEFAULT_PENALTIES, ...obj.penalties };
  }
};

export const setPointsByPriority = async (values) => {
  const next = { ...values };
  await LeaderboardConfig.findOneAndUpdate(
    {},
    { pointsByPriority: next, penalties: currentPenalties },
    { upsert: true, runValidators: true }
  );
  currentPoints = next;
  return currentPoints;
};

export const setPenalties = async (values) => {
  const next = { ...values };
  await LeaderboardConfig.findOneAndUpdate(
    {},
    { pointsByPriority: currentPoints, penalties: next },
    { upsert: true, runValidators: true }
  );
  currentPenalties = next;
  return currentPenalties;
};
