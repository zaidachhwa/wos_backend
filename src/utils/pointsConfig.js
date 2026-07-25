import LeaderboardConfig from "../models/LeaderboardConfig.js";
import { POINTS_BY_PRIORITY as DEFAULTS } from "../constants/points.constants.js";

// In-memory cache so points.js can stay synchronous — refreshed on boot and
// on every admin update. Small/rare writes, so no cache-invalidation edge cases.
let current = { ...DEFAULTS };

export const getPointsByPriority = () => current;

export const loadPointsConfig = async () => {
  const doc = await LeaderboardConfig.findOne();
  if (doc) current = { ...DEFAULTS, ...doc.toObject().pointsByPriority };
};

export const setPointsByPriority = async (values) => {
  const next = { ...values };
  await LeaderboardConfig.findOneAndUpdate(
    {},
    { pointsByPriority: next },
    { upsert: true, runValidators: true }
  );
  current = next;
  return current;
};
