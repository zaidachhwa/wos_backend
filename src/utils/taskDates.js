// Combines a deadline's UTC date with an "HH:mm" time-of-day into an
// absolute instant. Uses UTC consistently because `deadline` itself is
// stored from a plain <input type="date"> (parsed as UTC midnight) — this
// keeps the combination deterministic regardless of server timezone.
export const combineDeadlineAndTime = (deadline, timeStr) => {
  if (!deadline || !timeStr) return null;
  const d = new Date(deadline);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm));
};

const endOfDayUTC = (deadline) => {
  const d = new Date(deadline);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
};

export const isTaskOverdue = (task, now = new Date()) => {
  if (!task.deadline || task.status === "completed") return false;
  const cutoff = task.endTime ? combineDeadlineAndTime(task.deadline, task.endTime) : endOfDayUTC(task.deadline);
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
