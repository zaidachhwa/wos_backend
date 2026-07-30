// Only these statuses count toward "total working time" — backlog/todo are
// idle waiting states, blocked is external, client_review is the client's
// clock, not ours. See 2026-07-30-task-accountability-design.md.
const WORKING_STATUSES = ["in_progress", "review", "testing"];

// Reconstructs time-in-status entirely from the status-change Activity log
// updateTask already writes — no separate tracking table. `activities` must
// be every Activity for this task, ascending by createdAt is NOT required
// (this function sorts internally).
export const computeStatusDurations = (task, activities) => {
  const statusChanges = activities
    .filter((a) => a.meta?.statusTo)
    .slice()
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  const durationsMs = {};
  const add = (status, ms) => {
    if (ms <= 0) return;
    durationsMs[status] = (durationsMs[status] || 0) + ms;
  };

  let segmentStart = new Date(task.createdAt);
  let currentStatus = statusChanges[0]?.meta.statusFrom || task.status;

  for (const change of statusChanges) {
    const changedAt = new Date(change.createdAt);
    add(currentStatus, changedAt - segmentStart);
    segmentStart = changedAt;
    currentStatus = change.meta.statusTo;
  }

  if (currentStatus !== "completed") {
    add(currentStatus, new Date() - segmentStart);
  }

  const totalWorkingMs = WORKING_STATUSES.reduce((sum, status) => sum + (durationsMs[status] || 0), 0);
  return { durationsMs, totalWorkingMs };
};
