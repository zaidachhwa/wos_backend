import { isWorkingDayIST } from "./istTime.js";

// 1 hour grace period after shift start (late mark) / shift end (leave),
// per the exact business rule the user specified.
const GRACE_MS = 60 * 60 * 1000;

// A real UTC instant for "HH:MM" IST wall-clock time on the given calendar
// day, via the same "+05:30" ISO-offset trick used elsewhere in this app
// (see followUpController.js's dayBoundsFor / istTime.js).
const istInstant = (dateStr, hhmm) => new Date(`${dateStr}T${hhmm}:00+05:30`);

const pad = (n) => String(n).padStart(2, "0");

const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

// ponytail: shiftStart/shiftEnd are read from the user's *current* profile
// setting, not a per-day history — re-evaluating a past month uses today's
// shift time. Upgrade path: a shift-history collection, if shift times ever
// change mid-flight and that retroactive drift matters.
export const monthlyAttendanceForUser = ({ shiftStart, shiftEnd, monthStart, followUpsByDate }) => {
  if (!shiftStart || !shiftEnd) return { lateMarks: 0, leaves: 0 };

  const now = new Date();
  const year = monthStart.getUTCFullYear();
  const monthIndex = monthStart.getUTCMonth();
  const total = daysInMonth(year, monthIndex);

  let lateMarks = 0;
  let leaves = 0;

  for (let day = 1; day <= total; day += 1) {
    const dateStr = `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
    const d = new Date(Date.UTC(year, monthIndex, day));
    if (!isWorkingDayIST(d)) continue;

    const entry = followUpsByDate.get(dateStr) || { morning: null, evening: null };

    const lateCutoff = new Date(istInstant(dateStr, shiftStart).getTime() + GRACE_MS);
    if (now >= lateCutoff && (!entry.morning || entry.morning > lateCutoff)) {
      lateMarks += 1;
    }

    const leaveCutoff = new Date(istInstant(dateStr, shiftEnd).getTime() + GRACE_MS);
    const morningMissed = !entry.morning || entry.morning > leaveCutoff;
    const eveningMissed = !entry.evening || entry.evening > leaveCutoff;
    if (now >= leaveCutoff && morningMissed && eveningMissed) {
      leaves += 1;
    }
  }

  return { lateMarks, leaves };
};
