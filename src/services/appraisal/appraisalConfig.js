import AppraisalCriterion from "../../models/AppraisalCriterion.js";
import AppraisalSettings from "../../models/AppraisalSettings.js";
import Department from "../../models/Department.js";
import User from "../../models/User.js";
import { DEFAULT_CRITERIA, DEFAULT_SETTINGS } from "./appraisalDefaults.js";
import { validateDepartmentWeightage } from "./appraisalEngine.js";

// Seeds the default criteria/settings the first time the module runs
// against a database, then never again — after that the DB copy is the
// only configuration. Upserts by key/singleton, so concurrent boots can't
// double-insert.
export const ensureAppraisalConfig = async () => {
  if (!(await AppraisalCriterion.exists({}))) {
    await Promise.all(
      DEFAULT_CRITERIA.map((c, i) =>
        AppraisalCriterion.updateOne({ key: c.key }, { $setOnInsert: { ...c, sortOrder: i, isActive: true } }, { upsert: true })
      )
    );
  }
  await AppraisalSettings.updateOne({}, { $setOnInsert: { ...DEFAULT_SETTINGS, version: 1 } }, { upsert: true });
};

export const getSettings = async () => {
  let doc = await AppraisalSettings.findOne().lean();
  if (!doc) {
    await ensureAppraisalConfig();
    doc = await AppraisalSettings.findOne().lean();
  }
  return doc;
};

export const getActiveCriteria = () => AppraisalCriterion.find({ isActive: true }).sort({ sortOrder: 1, createdAt: 1 }).lean();

export const getAllCriteria = () => AppraisalCriterion.find().sort({ sortOrder: 1, createdAt: 1 }).lean();

// Per-department 100% check against the live departments. The "No
// department" scope is only checked when appraised employees without a
// department actually exist.
export const weightageStatus = async (activeCriteria, settings) => {
  const cfg = settings || (await getSettings());
  const [departments, unassigned] = await Promise.all([
    Department.find().select("name").sort("name").lean(),
    User.exists({ isActive: true, role: { $in: cfg.appraisedRoles || [] }, department: null }),
  ]);
  return validateDepartmentWeightage(activeCriteria, departments, { includeUnassigned: Boolean(unassigned) });
};

// A frozen copy of everything that shaped a score — stored on each
// finalized appraisal so later config edits can never rewrite history.
export const buildConfigSnapshot = (criteria, settings) => ({
  settingsVersion: settings.version,
  capturedAt: new Date(),
  criteria: criteria.map((c) => ({
    key: c.key,
    name: c.name,
    description: c.description,
    type: c.type,
    group: c.group,
    weightage: c.weightage,
    metric: c.metric,
    scoringMethod: c.scoringMethod,
    params: c.params,
    ratingOptions: c.ratingOptions,
    departments: (c.departments || []).map(String),
    sortOrder: c.sortOrder,
  })),
  bugSeverities: settings.bugSeverities,
  bugCountableStatuses: settings.bugCountableStatuses,
  clientChangeCategories: settings.clientChangeCategories,
  uncategorizedClientChangeCounts: settings.uncategorizedClientChangeCounts,
  classifications: settings.classifications,
  classificationDecimals: settings.classificationDecimals,
  improvementRule: settings.improvementRule,
});
