// India Standard Time has no DST, so a fixed +5:30 offset from UTC always
// holds. There's no per-user/org timezone setting in this app (single-org
// internal tool, same assumption as taskDates.js) — this is the one shared
// conversion every "what day/hour is it right now, for the org" decision
// should route through, instead of the server process's own (unreliable)
// local timezone.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// A Date whose UTC-read components (getUTCHours, getUTCDay, getUTCDate...)
// equal IST wall-clock time for the given instant. Always read it with
// getUTC*/setUTC* methods — local get*/set* methods depend on the server
// process's own timezone, which is what caused this bug in the first place.
export const toIST = (d = new Date()) => new Date(d.getTime() + IST_OFFSET_MS);

export const istDayStr = (d = new Date()) => {
  const ist = toIST(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
};

export const istClock = (d = new Date()) => {
  const ist = toIST(d);
  return { hours: ist.getUTCHours(), minutes: ist.getUTCMinutes(), dayOfWeek: ist.getUTCDay() };
};

// Sunday is the only official holiday for attendance purposes — Saturday is
// a regular working day.
export const isWorkingDayIST = (d = new Date()) => istClock(d).dayOfWeek !== 0;
