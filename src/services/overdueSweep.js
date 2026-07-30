import Task from "../models/Task.js";
import { OVERDUE_EXEMPT_STATUSES } from "../constants/enums.constants.js";
import { isTaskOverdue } from "../utils/taskDates.js";
import { getPenalties } from "../utils/pointsConfig.js";
import { recordActivity, notify } from "../utils/record.js";

// Live, one-time "went overdue while still open" penalty — distinct from
// the completed-late penalty in utils/points.js, which only fires once a
// task is eventually finished. See 2026-07-30-task-accountability-design.md.
export const applyOverduePenalties = async (now = new Date()) => {
  const candidates = await Task.find({
    deadline: { $ne: null },
    status: { $nin: OVERDUE_EXEMPT_STATUSES },
    approvalStatus: { $nin: ["pending", "rejected"] },
    overduePenaltyApplied: { $ne: true },
  });

  const overduePenalty = getPenalties().overdue;
  let processed = 0;

  for (const task of candidates) {
    if (!isTaskOverdue(task, now)) continue;

    // Atomic claim: only proceed if this call is the one that actually
    // flips overduePenaltyApplied false -> true. Guards against two
    // concurrent sweeps (manual trigger + setInterval tick, or overlapping
    // ticks) both reading the same not-yet-applied task and double-penalizing.
    const updated = await Task.findOneAndUpdate(
      { _id: task._id, overduePenaltyApplied: { $ne: true } },
      { $set: { overduePenaltyApplied: true } }
    );
    if (!updated) continue; // another concurrent sweep already claimed this task

    recordActivity({
      actor: null,
      action: "overdue_penalized",
      entityType: "task",
      entityId: task._id,
      project: task.project,
      meta: { title: task.title, points: -overduePenalty, users: task.assignees.map(String) },
    });
    for (const userId of task.assignees) {
      notify({
        user: userId,
        type: "points_awarded",
        title: `-${overduePenalty} pts: "${task.title}" went overdue`,
        link: `/tasks/${task._id}`,
      });
    }
    processed += 1;
  }

  return { processed };
};
