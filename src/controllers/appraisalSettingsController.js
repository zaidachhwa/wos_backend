import AppraisalCriterion from "../models/AppraisalCriterion.js";
import AppraisalSettings from "../models/AppraisalSettings.js";
import { BUG_STATUSES, CRITERION_TYPES, METRICS, SCORING_METHODS } from "../constants/appraisal.constants.js";
import { ROLES } from "../constants/roles.constants.js";
import { getAllCriteria, getSettings } from "../services/appraisal/appraisalConfig.js";
import {
  validateClassifications,
  validateCriterion,
  validateSeverities,
  validateWeightage,
} from "../services/appraisal/appraisalEngine.js";
import { audit, diffFields } from "../services/appraisal/appraisalAudit.js";

const fail = (res, status, message, extra = {}) => res.status(status).json({ success: false, message, ...extra });
const serverError = (res, error) => {
  console.error(error);
  return fail(res, 500, "Something went wrong");
};

const CRITERION_FIELDS = ["name", "description", "type", "group", "weightage", "metric", "scoringMethod", "params", "ratingOptions", "isActive"];

const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);

const bumpVersion = (actor) => AppraisalSettings.updateOne({}, { $inc: { version: 1 }, $set: { updatedBy: actor._id } });

// Normalizes a client payload into a criterion definition — only known
// fields, numbers coerced, group derived from type/metric when not given.
const normalizeCriterion = (body, existing = {}) => {
  const c = { ...existing };
  for (const f of CRITERION_FIELDS) if (body[f] !== undefined) c[f] = body[f];
  c.weightage = Number(c.weightage);
  c.params = c.params && typeof c.params === "object" ? c.params : {};
  for (const k of ["target", "unitPct", "freeUnits", "floorPct", "noDataPct", "defaultPct"]) {
    if (c.params[k] === "" || c.params[k] === null) delete c.params[k];
    else if (c.params[k] !== undefined) c.params[k] = Number(c.params[k]);
  }
  if (c.type === "manual") {
    c.metric = null;
    c.scoringMethod = "rating";
    c.ratingOptions = (c.ratingOptions || []).map((o) => ({ key: slugify(o.key || o.label), label: String(o.label || "").trim(), pct: Number(o.pct) }));
    c.group = "hr_evaluation";
  } else {
    c.ratingOptions = [];
    if (!body.group) c.group = String(c.metric || "").startsWith("hr_") ? "hr_metric" : "automatic";
  }
  c.isActive = c.isActive !== false;
  return c;
};

// Every criteria write must leave the ACTIVE set at exactly 100% —
// otherwise nothing could be finalized. Rebalancing several at once goes
// through updateAllocation below.
const activeTotalAfter = async (changedId, next) => {
  const all = await AppraisalCriterion.find().lean();
  const active = all
    .map((c) => (String(c._id) === String(changedId) ? { ...c, ...next } : c))
    .concat(changedId ? [] : [next])
    .filter((c) => c.isActive);
  return validateWeightage(active);
};

export const getConfig = async (req, res) => {
  try {
    const [criteria, settings] = await Promise.all([getAllCriteria(), getSettings()]);
    return res.json({
      success: true,
      message: "Appraisal configuration fetched",
      data: {
        criteria,
        settings,
        weightage: validateWeightage(criteria.filter((c) => c.isActive)),
        catalog: { metrics: METRICS, scoringMethods: SCORING_METHODS, types: CRITERION_TYPES, bugStatuses: BUG_STATUSES, roles: ROLES },
      },
    });
  } catch (error) {
    return serverError(res, error);
  }
};

export const createCriterion = async (req, res) => {
  try {
    const c = normalizeCriterion({ isActive: false, ...req.body });
    c.key = slugify(req.body.key || c.name);
    if (await AppraisalCriterion.exists({ key: c.key })) return fail(res, 409, `A criterion with key "${c.key}" already exists`);
    const errors = validateCriterion(c);
    if (errors.length) return fail(res, 400, errors[0], { errors });
    if (c.isActive) {
      const total = await activeTotalAfter(null, c);
      if (!total.valid) {
        return fail(res, 422, `${total.message} Save it as inactive, then adjust the weightage allocation.`, { weightage: total });
      }
    }
    const max = await AppraisalCriterion.findOne().sort({ sortOrder: -1 }).select("sortOrder").lean();
    const created = await AppraisalCriterion.create({ ...c, sortOrder: (max?.sortOrder ?? -1) + 1, createdBy: req.user._id, updatedBy: req.user._id });
    await bumpVersion(req.user);
    await audit({ actor: req.user, action: "criterion_created", entityType: "criterion", entityId: created._id, after: c });
    return res.status(201).json({ success: true, message: "Criterion created", data: { criterion: created } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const updateCriterion = async (req, res) => {
  try {
    const existing = await AppraisalCriterion.findById(req.params.id).lean();
    if (!existing) return fail(res, 404, "Criterion not found");
    const next = normalizeCriterion(req.body, existing);
    const errors = validateCriterion(next);
    if (errors.length) return fail(res, 400, errors[0], { errors });
    if (next.isActive !== existing.isActive || next.weightage !== existing.weightage) {
      const total = await activeTotalAfter(existing._id, next);
      if (!total.valid) return fail(res, 422, `${total.message} Use "Adjust weightage" to rebalance.`, { weightage: total });
    }
    const changes = diffFields(existing, next, CRITERION_FIELDS);
    if (!changes) return res.json({ success: true, message: "No changes", data: { criterion: existing } });

    const updated = await AppraisalCriterion.findByIdAndUpdate(
      existing._id,
      { $set: { ...Object.fromEntries(CRITERION_FIELDS.map((f) => [f, next[f]])), updatedBy: req.user._id } },
      { returnDocument: "after", runValidators: true }
    );
    await bumpVersion(req.user);
    const common = { actor: req.user, entityType: "criterion", entityId: existing._id, meta: { key: existing.key } };
    await audit({ ...common, action: "criterion_updated", ...changes });
    if ("weightage" in changes.after) await audit({ ...common, action: "weightage_changed", before: { weightage: existing.weightage }, after: { weightage: next.weightage } });
    if ("ratingOptions" in changes.after) await audit({ ...common, action: "rating_config_changed", before: { ratingOptions: existing.ratingOptions }, after: { ratingOptions: next.ratingOptions } });
    if ("isActive" in changes.after) await audit({ ...common, action: next.isActive ? "criterion_activated" : "criterion_deactivated" });
    return res.json({ success: true, message: "Criterion updated", data: { criterion: updated } });
  } catch (error) {
    return serverError(res, error);
  }
};

// Bulk weightage/activation rebalance — the way to add, remove or re-weight
// criteria while keeping the active total at exactly 100%.
export const updateAllocation = async (req, res) => {
  try {
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const all = await AppraisalCriterion.find().lean();
    const byId = new Map(items.map((i) => [String(i.id), i]));
    if ([...byId.keys()].some((id) => !all.some((c) => String(c._id) === id))) return fail(res, 400, "Unknown criterion in allocation");

    const next = all.map((c) => {
      const i = byId.get(String(c._id));
      return i ? { ...c, weightage: Number(i.weightage), isActive: i.isActive !== false } : c;
    });
    for (const c of next) {
      if (!Number.isFinite(c.weightage) || c.weightage < 0 || c.weightage > 100) return fail(res, 400, `Invalid weightage for "${c.name}"`);
    }
    const total = validateWeightage(next.filter((c) => c.isActive));
    if (!total.valid) return fail(res, 422, total.message, { weightage: total });

    const changed = next.filter((c) => {
      const old = all.find((o) => String(o._id) === String(c._id));
      return old.weightage !== c.weightage || old.isActive !== c.isActive;
    });
    if (!changed.length) return res.json({ success: true, message: "No changes", data: { weightage: total } });

    await AppraisalCriterion.bulkWrite(
      changed.map((c) => ({ updateOne: { filter: { _id: c._id }, update: { $set: { weightage: c.weightage, isActive: c.isActive, updatedBy: req.user._id } } } }))
    );
    await bumpVersion(req.user);
    for (const c of changed) {
      const old = all.find((o) => String(o._id) === String(c._id));
      const common = { actor: req.user, entityType: "criterion", entityId: c._id, meta: { key: c.key } };
      if (old.weightage !== c.weightage) await audit({ ...common, action: "weightage_changed", before: { weightage: old.weightage }, after: { weightage: c.weightage } });
      if (old.isActive !== c.isActive) await audit({ ...common, action: c.isActive ? "criterion_activated" : "criterion_deactivated" });
    }
    return res.json({ success: true, message: "Weightage allocation saved", data: { weightage: total } });
  } catch (error) {
    return serverError(res, error);
  }
};

export const reorderCriteria = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return fail(res, 400, "ids are required");
    await AppraisalCriterion.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { sortOrder: i } } } })));
    await audit({ actor: req.user, action: "criteria_reordered", entityType: "criterion", after: { ids } });
    return res.json({ success: true, message: "Order saved" });
  } catch (error) {
    return serverError(res, error);
  }
};

// Permanent delete only for a criterion that never shaped a finalized
// appraisal and is already inactive; everything else is deactivate-only.
export const deleteCriterion = async (req, res) => {
  try {
    const c = await AppraisalCriterion.findById(req.params.id);
    if (!c) return fail(res, 404, "Criterion not found");
    if (c.usedInFinalized) return fail(res, 409, "This criterion is part of finalized appraisals and can only be deactivated");
    if (c.isActive) return fail(res, 409, "Deactivate the criterion (and rebalance weightage) before deleting it");
    await c.deleteOne();
    await bumpVersion(req.user);
    await audit({ actor: req.user, action: "criterion_deactivated", entityType: "criterion", entityId: c._id, before: c.toObject(), meta: { deleted: true } });
    return res.json({ success: true, message: "Criterion deleted" });
  } catch (error) {
    return serverError(res, error);
  }
};

export const updateSettings = async (req, res) => {
  try {
    const current = await getSettings();
    const body = req.body || {};
    const next = {};

    if (body.bugSeverities !== undefined) {
      const severities = (body.bugSeverities || []).map((s) => ({
        key: slugify(s.key || s.label),
        label: String(s.label || "").trim(),
        penalty: Number(s.penalty),
        isActive: s.isActive !== false,
      }));
      const errors = validateSeverities(severities);
      if (errors.length) return fail(res, 400, errors[0], { errors });
      // Removing a severity would orphan existing bug reports; deactivate instead.
      const removed = (current.bugSeverities || []).filter((s) => !severities.some((n) => n.key === s.key));
      if (removed.length) return fail(res, 409, `Severity "${removed[0].label}" can't be removed — deactivate it instead`);
      next.bugSeverities = severities;
    }
    if (body.bugCountableStatuses !== undefined) {
      const statuses = (body.bugCountableStatuses || []).filter((s) => BUG_STATUSES.includes(s));
      next.bugCountableStatuses = statuses;
    }
    if (body.clientChangeCategories !== undefined) {
      const cats = (body.clientChangeCategories || []).map((c) => ({
        key: slugify(c.key || c.label),
        label: String(c.label || "").trim(),
        countsAgainstEmployee: Boolean(c.countsAgainstEmployee),
      }));
      if (cats.some((c) => !c.key || !c.label)) return fail(res, 400, "Every client-change category needs a label");
      if (new Set(cats.map((c) => c.key)).size !== cats.length) return fail(res, 400, "Duplicate client-change category");
      next.clientChangeCategories = cats;
    }
    if (body.uncategorizedClientChangeCounts !== undefined) next.uncategorizedClientChangeCounts = Boolean(body.uncategorizedClientChangeCounts);
    if (body.classifications !== undefined || body.classificationDecimals !== undefined) {
      const decimals = body.classificationDecimals !== undefined ? Number(body.classificationDecimals) : current.classificationDecimals;
      if (![0, 1, 2].includes(decimals)) return fail(res, 400, "Classification precision must be 0, 1 or 2 decimals");
      const list = (body.classifications ?? current.classifications).map((c) => ({
        key: slugify(c.key || c.label),
        label: String(c.label || "").trim(),
        min: Number(c.min),
        max: Number(c.max),
        tone: c.tone || "muted",
        emailMessage: String(c.emailMessage || "").slice(0, 2000),
        showImprovementAreas: Boolean(c.showImprovementAreas),
      }));
      const errors = validateClassifications(list, decimals);
      if (errors.length) return fail(res, 400, errors[0], { errors });
      next.classifications = list.sort((a, b) => a.min - b.min);
      next.classificationDecimals = decimals;
    }
    if (body.improvementRule !== undefined) {
      const thresholdPct = Number(body.improvementRule.thresholdPct);
      const maxItems = Number(body.improvementRule.maxItems);
      if (!(thresholdPct >= 0 && thresholdPct <= 100) || !(Number.isInteger(maxItems) && maxItems >= 1 && maxItems <= 10)) {
        return fail(res, 400, "Improvement threshold must be 0–100 and max items 1–10");
      }
      next.improvementRule = { thresholdPct, maxItems };
    }
    if (body.appraisedRoles !== undefined) {
      const roles = (body.appraisedRoles || []).filter((r) => ROLES.includes(r));
      if (!roles.length) return fail(res, 400, "Select at least one appraised role");
      next.appraisedRoles = roles;
    }
    if (body.automation !== undefined) {
      const a = body.automation;
      const mode = a.autoFinalizeMode ?? current.automation?.autoFinalizeMode;
      if (!["complete", "submitted", "off"].includes(mode)) return fail(res, 400, "Invalid auto-finalize mode");
      const maxEmailAttempts = Number(a.maxEmailAttempts ?? current.automation?.maxEmailAttempts ?? 3);
      if (!(Number.isInteger(maxEmailAttempts) && maxEmailAttempts >= 1 && maxEmailAttempts <= 10)) return fail(res, 400, "Email attempts must be 1–10");
      next.automation = { autoFinalizeMode: mode, emailsEnabled: a.emailsEnabled ?? current.automation?.emailsEnabled ?? true, maxEmailAttempts };
    }

    const changes = diffFields(current, { ...current, ...next }, Object.keys(next));
    if (!changes) return res.json({ success: true, message: "No changes", data: { settings: current } });

    const updated = await AppraisalSettings.findOneAndUpdate({}, { $set: { ...next, updatedBy: req.user._id }, $inc: { version: 1 } }, { returnDocument: "after", runValidators: true });
    const common = { actor: req.user, entityType: "settings", entityId: updated._id };
    if (changes.after.bugSeverities) await audit({ ...common, action: "bug_penalty_changed", before: { bugSeverities: changes.before.bugSeverities }, after: { bugSeverities: changes.after.bugSeverities } });
    if (changes.after.classifications || changes.after.classificationDecimals !== undefined) {
      await audit({ ...common, action: "classification_changed", before: { classifications: current.classifications }, after: { classifications: updated.classifications } });
    }
    await audit({ ...common, action: "settings_updated", ...changes });
    return res.json({ success: true, message: "Settings saved", data: { settings: updated } });
  } catch (error) {
    return serverError(res, error);
  }
};
