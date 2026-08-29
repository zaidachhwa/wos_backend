import AppraisalConfig from "../models/AppraisalConfig.js";

// Same in-memory-cache-over-a-singleton-doc shape as pointsConfig.js /
// attendanceConfig.js — kept synchronous for the appraisal controller's
// per-row scoring loop, refreshed on boot and on every admin/hr update.
const DEFAULTS = { minTasksNew: 3, minTasksMid: 5, minTasksSenior: 8 };
let current = { ...DEFAULTS };

export const getTenureThresholds = () => current;

export const loadAppraisalConfig = async () => {
  const doc = await AppraisalConfig.findOne();
  if (doc) {
    current = {
      minTasksNew: doc.minTasksNew,
      minTasksMid: doc.minTasksMid,
      minTasksSenior: doc.minTasksSenior,
    };
  }
};

export const setTenureThresholds = async (values) => {
  const next = { ...current, ...values };
  await AppraisalConfig.findOneAndUpdate({}, next, { upsert: true, runValidators: true });
  current = next;
  return current;
};
