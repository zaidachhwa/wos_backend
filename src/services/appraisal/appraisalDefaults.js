// Seed configuration, written to the DB once (first boot with an empty
// AppraisalCriterion collection) and HR-editable from then on. Nothing
// below is read at scoring time — the engine only ever sees the DB copy.

const PAR = [
  { key: "poor", label: "Poor", pct: 33.33 },
  { key: "average", label: "Average", pct: 66.67 },
  { key: "excellent", label: "Excellent", pct: 100 },
];

export const DEFAULT_CRITERIA = [
  {
    key: "project_contribution",
    name: "Project Contribution",
    description: "Completion of assigned work weighted by each project's configured weightage — higher-weightage projects count more.",
    type: "automatic",
    group: "automatic",
    weightage: 15,
    metric: "project_weighted_completion",
    scoringMethod: "ratio",
    params: { noDataPct: 0 },
  },
  {
    key: "task_completion",
    name: "Task Completion",
    description: "Completed ÷ total tasks due or worked in the month.",
    type: "automatic",
    group: "automatic",
    weightage: 20,
    metric: "task_completion_rate",
    scoringMethod: "ratio",
    params: { noDataPct: 0 },
  },
  {
    key: "task_timeliness",
    name: "Task Timeliness",
    description: "Tasks completed on or before their deadline ÷ (completed + still overdue).",
    type: "automatic",
    group: "automatic",
    weightage: 15,
    metric: "task_on_time_rate",
    scoringMethod: "ratio",
    params: { noDataPct: 0 },
  },
  {
    key: "bug_management",
    name: "Bug Management",
    description: "Penalty points from confirmed bug reports (severity penalties are configurable).",
    type: "automatic",
    group: "automatic",
    weightage: 10,
    metric: "bug_penalty_points",
    scoringMethod: "deduction",
    params: { unitPct: 2, freeUnits: 0, floorPct: 0 },
  },
  {
    key: "client_changes",
    name: "Client Changes / Rework",
    description: "Client changes whose category counts against the employee (e.g. employee error).",
    type: "automatic",
    group: "automatic",
    weightage: 5,
    metric: "client_change_penalized_count",
    scoringMethod: "deduction",
    params: { unitPct: 20, freeUnits: 0, floorPct: 0 },
  },
  {
    key: "leaves",
    name: "Leaves",
    description: "HR-entered number of leaves for the month.",
    type: "automatic",
    group: "hr_metric",
    weightage: 5,
    metric: "hr_leaves",
    scoringMethod: "deduction",
    params: { unitPct: 10, freeUnits: 0, floorPct: 0 },
  },
  {
    key: "late_marks",
    name: "Late Marks",
    description: "HR-entered number of late marks for the month.",
    type: "automatic",
    group: "hr_metric",
    weightage: 5,
    metric: "hr_late_marks",
    scoringMethod: "deduction",
    params: { unitPct: 5, freeUnits: 0, floorPct: 0 },
  },
  {
    key: "discipline",
    name: "Discipline",
    description: "Workplace discipline, punctuality, following instructions, reporting discipline, general conduct.",
    type: "manual",
    group: "hr_evaluation",
    weightage: 5,
    scoringMethod: "rating",
    ratingOptions: PAR,
  },
  {
    key: "policy_compliance",
    name: "Policy Compliance",
    description: "Leave, attendance and follow-up/reporting policy; company, security and other procedures.",
    type: "manual",
    group: "hr_evaluation",
    weightage: 5,
    scoringMethod: "rating",
    ratingOptions: PAR,
  },
  {
    key: "helping_nature",
    name: "Helping Nature",
    description: "Helping colleagues, supporting the team, knowledge sharing, collaboration, assisting during urgent work.",
    type: "manual",
    group: "hr_evaluation",
    weightage: 5,
    scoringMethod: "rating",
    ratingOptions: PAR,
  },
  {
    key: "professionalism",
    name: "Professionalism",
    description: "Communication, ownership, responsibility, work attitude, meeting commitments.",
    type: "manual",
    group: "hr_evaluation",
    weightage: 5,
    scoringMethod: "rating",
    ratingOptions: PAR,
  },
  {
    key: "critical_behaviour",
    name: "Behaviour in Critical Situations",
    description: "Client escalations, urgent deadlines, critical bugs, production incidents, high-pressure and emergency work.",
    type: "manual",
    group: "hr_evaluation",
    weightage: 5,
    scoringMethod: "rating",
    ratingOptions: PAR,
  },
];

// Rating + salary increment slabs (company policy table). The final score is
// rounded to whole numbers before matching, so 69.4 → 69 (Needs improvement)
// and 69.5 → 70 (Developing). Scores above 100 (special bonus) use 98–100.
const slab = (key, label, min, max, tone, employeeIncrementPct, leaderIncrementPct, emailMessage, showImprovementAreas) => ({
  key,
  label,
  min,
  max,
  tone,
  employeeIncrementPct,
  leaderIncrementPct,
  emailMessage,
  showImprovementAreas,
});

export const INCREMENT_SLABS = [
  slab("unsatisfactory", "Unsatisfactory", 0, 59, "danger", 0, 0, "Your performance this month is below the expected standard. Please focus on the areas below and discuss a plan with your Team Lead.", true),
  slab("needs_improvement", "Needs improvement", 60, 69, "danger", 3, 3, "Please focus on improving the areas below during the upcoming month.", true),
  slab("developing", "Developing", 70, 79, "warning", 5, 6, "You are making progress. Keep working on the areas below to move to the next rating.", true),
  slab("good", "Good", 80, 84, "info", 7, 10, "Good work this month. Keep it up.", false),
  slab("very_good", "Very good", 85, 89, "info", 9, 14, "Very good performance this month. Thank you for your contribution.", false),
  slab("excellent", "Excellent", 90, 94, "success", 12, 18, "Excellent performance this month. Thank you for your contribution and professionalism.", false),
  slab("exceptional", "Exceptional", 95, 97, "success", 14, 22, "Exceptional performance this month — thank you for going above and beyond.", false),
  slab("outstanding", "Outstanding", 98, 100, "success", 15, 25, "Outstanding performance this month — thank you for setting the standard.", false),
];

// The three bands the module originally shipped with; replaced by
// INCREMENT_SLABS on boot if HR never customised them (appraisalConfig.js).
export const LEGACY_CLASSIFICATION_KEYS = ["needs_improvement:0-35", "consistent:36-75", "excellent:76-100"];

export const DEFAULT_SETTINGS = {
  bugSeverities: [
    { key: "critical", label: "Critical", penalty: 5, isActive: true },
    { key: "major", label: "Major", penalty: 3, isActive: true },
    { key: "minor", label: "Minor", penalty: 1, isActive: true },
  ],
  bugCountableStatuses: ["confirmed", "resolved"],
  clientChangeCategories: [
    { key: "requirement_change", label: "Requirement Change", countsAgainstEmployee: false },
    { key: "scope_change", label: "Scope Change", countsAgainstEmployee: false },
    { key: "client_preference", label: "Client Preference", countsAgainstEmployee: false },
    { key: "employee_error", label: "Employee Error", countsAgainstEmployee: true },
    { key: "bug_fix", label: "Bug Fix", countsAgainstEmployee: true },
    { key: "other", label: "Other", countsAgainstEmployee: false },
  ],
  uncategorizedClientChangeCounts: false,
  classifications: INCREMENT_SLABS,
  classificationDecimals: 0,
  improvementRule: { thresholdPct: 60, maxItems: 3 },
  scoringScale: { poor: 25, average: 50, good: 100 },
  appraisedRoles: ["manager", "sublead", "member", "qa"],
  automation: { autoFinalizeMode: "complete", emailsEnabled: true, maxEmailAttempts: 3 },
};
