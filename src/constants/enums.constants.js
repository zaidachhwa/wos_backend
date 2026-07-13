export const PRIORITIES = ["low", "medium", "high", "critical"];

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed", "cancelled"];

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "testing",
  "completed",
  "blocked",
];

export const FOLLOWUP_TYPES = ["morning", "evening"];

export const FOLLOWUP_STATUSES = ["draft", "submitted", "reviewed"];

export const TIMEBLOCK_CATEGORIES = [
  "meeting",
  "deep_work",
  "personal",
  "followup",
  "project_work",
  "break",
];

export const NOTIFICATION_TYPES = [
  "task_assigned",
  "task_updated",
  "comment_added",
  "status_changed",
  "deadline_reminder",
  "followup_reminder",
  "followup_submitted",
  "followup_reviewed",
  "project_updated",
];

export const ACTIVITY_ENTITY_TYPES = ["project", "module", "task", "followup", "timeblock", "user"];
