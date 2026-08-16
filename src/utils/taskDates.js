import { OVERDUE_EXEMPT_STATUSES } from "../constants/enums.constants.js";

// Combines a deadline's calendar date with an "HH:mm" wall-clock time into
// an absolute instant. The date portion is read from `deadline`'s UTC ISO
// components (timezone-safe, since `deadline` is stored from a date-only
// input at UTC midnight); the time-of-day is then interpreted as IST via an
// explicit "+05:30" offset in the constructed ISO string, so this is correct
// regardless of what timezone the server process itself happens to run in.
// ponytail: there's no per-user/org timezone setting in this app, so this
// assumes the org operates in IST — good enough for a single-org internal
// tool, add a timezone field if that stops holding. Calendar DISPLAY (the
// /calendar page) does this same combination in the browser instead, since
// that's where the viewer's real timezone actually lives — this backend
// copy is only for contexts with no browser to defer to (dashboard/AI
// overdue calculations).
export const combineDeadlineAndTime = (deadline, timeStr) => {
  if (!deadline || !timeStr) return null;
  const dateStr = new Date(deadline).toISOString().slice(0, 10);
  return new Date(`${dateStr}T${timeStr}:00+05:30`);
};

export const endOfDayLocal = (deadline) => {
  const dateStr = new Date(deadline).toISOString().slice(0, 10);
  return new Date(`${dateStr}T23:59:59.999+05:30`);
};

export const isTaskOverdue = (task, now = new Date()) => {
  if (!task.deadline || OVERDUE_EXEMPT_STATUSES.includes(task.status)) return false;
  const cutoff = task.endTime ? combineDeadlineAndTime(task.deadline, task.endTime) : endOfDayLocal(task.deadline);
  return cutoff < now;
};

// Cross-field validation shared by createTask/updateTask: both-or-neither,
// end after start, and a time slot requires a deadline to anchor to.
export const validateTimeSlot = ({ deadline, startTime, endTime }) => {
  if (!startTime && !endTime) return null;
  if (!startTime || !endTime) return "startTime and endTime must both be set together";
  if (!deadline) return "A deadline is required to set a time slot";
  if (endTime <= startTime) return "endTime must be after startTime";
  return null;
};
