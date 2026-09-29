import { toIST } from "../../utils/istTime.js";

// All appraisal month math is Asia/Kolkata (fixed +05:30, no DST) — never
// the server process's timezone and never plain UTC month bounds.
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, "0");

export const isValidMonth = (month) => typeof month === "string" && MONTH_RE.test(month);

export const istMonthOf = (d = new Date()) => {
  const ist = toIST(d);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}`;
};

export const shiftMonth = (month, delta) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
};

// September 2026 -> start 2026-09-01T00:00:00+05:30, end 2026-09-30T23:59:59.999+05:30,
// emailDueAt 2026-10-01T00:01:00+05:30. Day-string bounds are for fields
// stored as "YYYY-MM-DD" (BugReport.date).
export const monthPeriod = (month) => {
  if (!isValidMonth(month)) throw new Error(`Invalid appraisal month "${month}" (expected YYYY-MM)`);
  const next = shiftMonth(month, 1);
  const startAt = new Date(`${month}-01T00:00:00.000+05:30`);
  const nextStart = new Date(`${next}-01T00:00:00.000+05:30`);
  const endAt = new Date(nextStart.getTime() - 1);
  const emailDueAt = new Date(`${next}-01T00:01:00.000+05:30`);
  const [y, m] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { month, startAt, endAt, emailDueAt, dayStart: `${month}-01`, dayEnd: `${month}-${pad(lastDay)}` };
};

export const hasMonthEnded = (month, now = new Date()) => now > monthPeriod(month).endAt;

// The month whose emails/close are due at `now`: the previous IST month,
// but only once 00:01 IST on the 1st has passed. Returns null in the first
// minute of a month (00:00–00:00:59) so nothing fires before 00:01.
export const monthDueForClose = (now = new Date()) => {
  const previous = shiftMonth(istMonthOf(now), -1);
  return now >= monthPeriod(previous).emailDueAt ? previous : null;
};

export const monthLabel = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
};
