// The one rounding policy for the appraisal module. Everything is stored at
// STORE_DECIMALS (13.333333) and displayed at DISPLAY_DECIMALS (13.33);
// the frontend only formats what the backend returns, it never re-derives.
export const STORE_DECIMALS = 6;
export const DISPLAY_DECIMALS = 2;

// Half-away-from-zero rounding that isn't fooled by binary float error
// (1.005 -> 1.01, not 1.00).
export const roundTo = (value, decimals) => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
  const factor = 10 ** decimals;
  const n = Number(value);
  return (Math.sign(n) * Math.round(Math.abs(n) * factor + Number.EPSILON * factor)) / factor;
};

export const roundStore = (value) => roundTo(value, STORE_DECIMALS);
export const roundDisplay = (value) => roundTo(value, DISPLAY_DECIMALS);

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// Weightages are compared in integer hundredths so 33.33 + 33.33 + 33.34
// is exactly 100, with no float drift.
export const toHundredths = (value) => Math.round(Number(value || 0) * 100);
