import { AUTO_AWARD_RATIO, OVERDUE_PENALTY } from "../constants/points.constants.js";
import { getPointsByPriority } from "./pointsConfig.js";
import { combineDeadlineAndTime, endOfDayLocal } from "./taskDates.js";

export const taskPointCeiling = (priority) => {
  const points = getPointsByPriority();
  return points[priority] ?? points.medium;
};

export const maxBonusFor = (priority) =>
  taskPointCeiling(priority) - Math.round(taskPointCeiling(priority) * AUTO_AWARD_RATIO);

export const wasCompletedLate = (task, completedAt) => {
  if (!task.deadline) return false;
  const cutoff = task.endTime ? combineDeadlineAndTime(task.deadline, task.endTime) : endOfDayLocal(task.deadline);
  return completedAt > cutoff;
};

export const pointsForCompletedTask = (task, completedAt) => {
  const ceiling = taskPointCeiling(task.priority);
  const auto = Math.round(ceiling * AUTO_AWARD_RATIO);
  const bonus = Math.min(task.bonusPoints || 0, maxBonusFor(task.priority));
  const penalty = wasCompletedLate(task, completedAt) ? OVERDUE_PENALTY : 0;
  return Math.max(0, auto + bonus - penalty);
};
