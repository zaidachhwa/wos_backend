export const PRIORITIES = ["low", "medium", "high", "critical"];

export const PROJECT_STATUSES = ["planning", "active", "review", "on_hold", "completed", "cancelled"];

export const PROJECT_TYPES = ["internal", "client", "product"];

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "testing",
  "client_review",
  "completed",
  "blocked",
];

// A task in any of these statuses is never "overdue" — completed work is
// done, and client_review means the ball is in the client's court, not ours.
export const OVERDUE_EXEMPT_STATUSES = ["completed", "client_review"];

// A member-created task starts "pending" until its reportingManager (or an
// admin) approves it; admin/manager/sublead-created tasks skip approval
// entirely ("not_required").
export const TASK_APPROVAL_STATUSES = ["not_required", "pending", "approved", "rejected"];

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
  "points_awarded",
];

export const ACTIVITY_ENTITY_TYPES = ["project", "module", "task", "followup", "timeblock", "user"];
