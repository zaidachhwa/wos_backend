// Fixed vocabulary of the configurable appraisal engine. Everything HR tunes
// (criteria, weightages, penalties, bands) lives in the DB — see
// models/AppraisalCriterion.js and models/AppraisalSettings.js — these are
// only the *kinds* of things the engine knows how to evaluate.

export const APPRAISAL_TIMEZONE = "Asia/Kolkata";

export const CRITERION_TYPES = ["automatic", "manual", "hybrid"];

// How a criterion turns its metric into a 0–100% performance:
//   ratio      metric is already a 0..1 ratio (e.g. completion rate)
//   target     metric / params.target, capped at 100%
//   deduction  100% − max(0, units − params.freeUnits) × params.unitPct, floored at params.floorPct
//   bands      first params.bands[{ min, max, pct }] whose [min, max] contains the metric
//   rating     manual rating option pct (MANUAL criteria only)
export const SCORING_METHODS = ["ratio", "target", "deduction", "bands", "rating"];

// Automatic data sources a criterion can read. Leaves/late marks are the
// HR-entered monthly numbers on EmployeeAppraisal.hrInputs — deliberately
// NOT Attendance/FollowUp (see services/appraisal/appraisalMetrics.js).
export const METRICS = {
  task_completion_rate: { label: "Task completion rate", unit: "ratio" },
  task_on_time_rate: { label: "Task timeliness (on-time rate)", unit: "ratio" },
  task_overdue_count: { label: "Overdue tasks (count)", unit: "count" },
  project_weighted_completion: { label: "Project-weightage-weighted completion", unit: "ratio" },
  project_weighted_load: { label: "Project weightage load (Σ weightage × completion)", unit: "points" },
  bug_penalty_points: { label: "Bug penalty points (Σ severity penalty)", unit: "points" },
  bug_count: { label: "Bugs (count)", unit: "count" },
  client_change_penalized_count: { label: "Client changes counted against employee", unit: "count" },
  hr_leaves: { label: "Leaves (HR entered)", unit: "count" },
  hr_late_marks: { label: "Late marks (HR entered)", unit: "count" },
};

export const APPRAISAL_STATUSES = [
  "draft",
  "in_progress",
  "pending_hr_input",
  "ready_for_review",
  "submitted",
  "finalized",
  "reopened",
];

// Statuses in which inputs/ratings may still change.
export const EDITABLE_STATUSES = ["draft", "in_progress", "pending_hr_input", "ready_for_review", "submitted", "reopened"];

export const BUG_STATUSES = ["reported", "confirmed", "rejected", "resolved"];

export const EMAIL_STATUSES = ["pending", "processing", "sent", "failed", "retrying"];

// Role groups — mapped onto the existing WOS roles (roles.constants.js).
export const APPRAISAL_MANAGE_ROLES = ["admin", "hr"];
export const APPRAISAL_VIEW_ALL_ROLES = ["admin", "hr", "director"];
export const TEAM_LEAD_ROLES = ["manager", "sublead", "subadmin"];
export const BUG_REPORTER_ROLES = ["admin", "hr", "manager", "sublead", "subadmin", "qa"];

export const AUDIT_ACTIONS = [
  "criterion_created",
  "criterion_updated",
  "criterion_deactivated",
  "criterion_activated",
  "criteria_reordered",
  "weightage_changed",
  "settings_updated",
  "bug_penalty_changed",
  "rating_config_changed",
  "classification_changed",
  "leaves_entered",
  "leaves_changed",
  "late_marks_entered",
  "late_marks_changed",
  "rating_set",
  "override_set",
  "bug_created",
  "bug_updated",
  "bug_severity_changed",
  "bug_status_changed",
  "client_change_categorized",
  "appraisal_created",
  "appraisal_submitted",
  "appraisal_finalized",
  "appraisal_reopened",
  "appraisal_modified_after_reopen",
  "period_closed",
  "email_sent",
  "email_failed",
  "email_retried",
];
