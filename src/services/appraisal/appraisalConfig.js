import AppraisalCriterion from "../../models/AppraisalCriterion.js";
import AppraisalSettings from "../../models/AppraisalSettings.js";
import Department from "../../models/Department.js";
import User from "../../models/User.js";
import { DEFAULT_CRITERIA, DEFAULT_SETTINGS, INCREMENT_SLABS, LEGACY_CLASSIFICATION_KEYS } from "./appraisalDefaults.js";
import { validateDepartmentWeightage } from "./appraisalEngine.js";
import { audit } from "./appraisalAudit.js";

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
  await upgradeLegacyClassifications();
};

// One-time move from the original 3 bands to the rating + increment slabs.
// Only when the stored bands are still exactly the untouched originals —
// anything HR customised is left alone. Finalized appraisals keep the bands
// they were finalized under (configSnapshot); drafts re-rate on recalculation.
const signature = (list) => (list || []).map((c) => `${c.key}:${c.min}-${c.max}`).join("|");
export const upgradeLegacyClassifications = async () => {
  const legacy = LEGACY_CLASSIFICATION_KEYS.join("|");
  const doc = await AppraisalSettings.findOne().select("classifications").lean();
  if (!doc || signature(doc.classifications) !== legacy) return false;
  const r = await AppraisalSettings.updateOne(
    { _id: doc._id, "classifications.2.key": "excellent", "classifications.3": { $exists: false } },
    { $set: { classifications: INCREMENT_SLABS, classificationDecimals: 0 }, $inc: { version: 1 } }
  );
  if (r.modifiedCount) {
    await audit({
      action: "classification_changed",
      entityType: "settings",
      entityId: doc._id,
      before: { classifications: doc.classifications },
      after: { classifications: INCREMENT_SLABS },
      meta: { reason: "Upgraded to rating + increment slabs" },
    });
  }
  return r.modifiedCount === 1;
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
  const [departments, unassigned, people] = await Promise.all([
    Department.find().select("name").sort("name").lean(),
    User.exists({ isActive: true, role: { $in: cfg.appraisedRoles || [] }, department: null }),
    User.find({ isActive: true, role: { $in: cfg.appraisedRoles || [] } }).select("department team role").populate("team", "name").lean(),
  ]);
  // Distinct (role, team) combinations per department, for team/position-targeted criteria.
  const profiles = {};
  for (const u of people) {
    const dept = u.department ? String(u.department) : "";
    const team = u.team?._id ? String(u.team._id) : null;
    const list = (profiles[dept] ||= []);
    if (!list.some((p) => p.role === u.role && p.team === team)) list.push({ role: u.role, team, teamName: u.team?.name || "" });
  }
  return validateDepartmentWeightage(activeCriteria, departments, { includeUnassigned: Boolean(unassigned), profiles });
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
    teams: (c.teams || []).map(String),
    positions: c.positions || [],
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
