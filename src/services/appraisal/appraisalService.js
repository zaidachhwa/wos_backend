import AppraisalCriterion from "../../models/AppraisalCriterion.js";
import EmployeeAppraisal from "../../models/EmployeeAppraisal.js";
import User from "../../models/User.js";
import Project from "../../models/Project.js";
import { EDITABLE_STATUSES, LEADER_ROLES } from "../../constants/appraisal.constants.js";
import { buildConfigSnapshot, getActiveCriteria, getSettings } from "./appraisalConfig.js";
import {
  appliesToEmployee,
  classify,
  composeFinalScore,
  computeAppraisal,
  criteriaForEmployee,
  incrementFor,
  validateWeightage,
} from "./appraisalEngine.js";
import { collectMetrics } from "./appraisalMetrics.js";
import { hasMonthEnded, monthPeriod } from "./appraisalPeriod.js";
import { roundStore } from "./appraisalMath.js";
import { audit } from "./appraisalAudit.js";

// Orchestration around the pure engine: draft lifecycle, HR input,
// finalization snapshots and reopen. Controllers and the month-close job
// both go through here, so the rules (locking, completeness, audit) can't
// drift between the HTTP path and the scheduled path.

export class AppraisalError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

const EMPLOYEE_FIELDS = "name email role designation department team isActive";
export const DIRECTOR_INPUT_LABEL = "Director's assessment (out of 20)";

export const appraisedUserFilter = (settings, extra = {}) => ({
  isActive: true,
  role: { $in: settings.appraisedRoles || [] },
  ...extra,
});

// Idempotent: upserts on the unique (user, month) key, so two concurrent
// callers (dashboard load + month-close job) can't create duplicates.
export const ensureDrafts = async (users, month) => {
  if (!users.length) return;
  const { startAt, endAt } = monthPeriod(month);
  try {
    await EmployeeAppraisal.bulkWrite(
      users.map((u) => ({
        updateOne: {
          filter: { user: u._id, month },
          update: { $setOnInsert: { user: u._id, month, periodStart: startAt, periodEnd: endAt, status: "draft", department: u.department || null } },
          upsert: true,
        },
      })),
      { ordered: false }
    );
  } catch (error) {
    if (error.code !== 11000 && !error.writeErrors?.every((e) => e.code === 11000)) throw error;
  }
};

export const getOrCreateDraft = async (userId, month) => {
  const user = await User.findById(userId).select(EMPLOYEE_FIELDS);
  if (!user) throw new AppraisalError("Employee not found", 404);
  monthPeriod(month); // validates
  await ensureDrafts([user], month);
  return EmployeeAppraisal.findOne({ user: userId, month });
};

const deriveStatus = (doc, result, now) => {
  if (["finalized", "reopened"].includes(doc.status)) return doc.status;
  if (doc.status === "submitted") return result.complete ? "submitted" : "in_progress";
  const touched = doc.hrInputs?.updatedAt || (doc.evaluations || []).length;
  if (result.complete) return "ready_for_review";
  if (hasMonthEnded(doc.month, now)) return "pending_hr_input";
  return touched ? "in_progress" : "draft";
};

const hrInputsMap = (docs) =>
  new Map(docs.map((d) => [String(d.user), { leaves: d.hrInputs?.leaves ?? null, lateMarks: d.hrInputs?.lateMarks ?? null }]));

// A reopened appraisal keeps the configuration it was finalized under
// (that month's weightages, penalties, bands) — reopening corrects the
// inputs, it doesn't silently re-score history against today's rules.
const snapshotConfig = (doc) => {
  const snap = doc.configSnapshot;
  if (doc.status !== "reopened" || !snap) return null;
  return { settings: { ...snap, version: snap.settingsVersion }, criteria: snap.criteria };
};

// Recomputes every non-finalized appraisal in `docs` (all same month) from
// live data. Finalized ones are skipped outright — history is never
// re-derived. The write is conditioned on status != finalized so a finalize
// racing this recalculation always wins.
export const recalculate = async (docs, { now = new Date(), settings, criteria } = {}) => {
  const live = docs.filter((d) => d.status !== "finalized");
  if (!live.length) return docs;
  const liveCfg = settings || (await getSettings());
  const liveCrit = criteria || (await getActiveCriteria());

  const regular = [];
  for (const doc of live) {
    const snap = snapshotConfig(doc);
    // A snapshot already holds exactly the criteria that applied to this
    // employee when it was finalized — don't re-filter by today's department.
    if (snap) await recalcGroup([doc], snap.settings, snap.criteria, now, { byDepartment: false });
    else regular.push(doc);
  }
  if (regular.length) await recalcGroup(regular, liveCfg, liveCrit, now, { byDepartment: true });
  return docs;
};

const recalcGroup = async (live, cfg, crit, now, { byDepartment }) => {
  const month = live[0].month;
  const metricsByUser = await collectMetrics({
    userIds: live.map((d) => d.user._id || d.user),
    month,
    settings: cfg,
    hrInputsByUser: hrInputsMap(live),
    now,
  });

  const userIds = live.map((d) => d.user._id || d.user);
  const users = await User.find({ _id: { $in: userIds } }).select("department team role designation");
  const userById = new Map(users.map((u) => [String(u._id), u]));
  // Increment group: leader roles, or anyone currently managing a project.
  const projectManagers = new Set(
    (await Project.find({ manager: { $in: userIds }, status: { $nin: ["completed", "cancelled"] } }).distinct("manager")).map(String)
  );
  const isLeader = new Map(users.map((u) => [String(u._id), LEADER_ROLES.includes(u.role) || projectManagers.has(String(u._id))]));

  const ops = [];
  for (const doc of live) {
    const key = String(doc.user._id || doc.user);
    const metrics = metricsByUser.get(key);
    const applicable = byDepartment ? criteriaForEmployee(crit, userById.get(key) || {}) : crit;
    const result = computeAppraisal({ criteria: applicable, settings: cfg, metrics, evaluations: doc.evaluations || [] });
    // Criteria (out of 100) + Director (out of 20) → out of 100, + bonus.
    const directorScore = doc.directorAssessment?.score ?? null;
    const final = composeFinalScore({ baseScore: result.totalScore, directorScore, bonusPct: doc.specialBonus?.pct ?? 0 });
    if (directorScore === null) {
      result.missingInputs.push(DIRECTOR_INPUT_LABEL);
      result.complete = false;
    }
    const classification = classify(final.classificationScore, cfg.classifications, cfg.classificationDecimals ?? 0);
    const update = {
      entries: result.entries,
      baseScore: result.totalScore,
      convertedScore: final.convertedScore,
      totalScore: final.totalScore,
      classification,
      increment: incrementFor(classification, isLeader.get(key)),
      improvementAreas: result.improvementAreas,
      missingInputs: result.missingInputs,
      metricsSnapshot: metrics,
      calculatedAt: now,
      status: deriveStatus(doc, result, now),
      department: userById.get(key)?.department ?? doc.department,
    };
    Object.assign(doc, update);
    doc._complete = result.complete;
    ops.push({ updateOne: { filter: { _id: doc._id, status: { $ne: "finalized" } }, update: { $set: update } } });
  }
  if (ops.length) await EmployeeAppraisal.bulkWrite(ops, { ordered: false });
};

export const recalculateOne = async (doc, opts) => (await recalculate([doc], opts))[0];

const assertEditable = (doc) => {
  if (doc.status === "finalized") {
    throw new AppraisalError("This appraisal is finalized and locked. Reopen it to make changes.", 409);
  }
  if (!EDITABLE_STATUSES.includes(doc.status)) throw new AppraisalError("This appraisal can't be edited in its current status", 409);
};

const validCount = (value, label) => {
  if (value === null) return null;
  const n = Number(value);
  // Half days allowed (0.5 steps); a month never has more than 31 of either.
  if (!Number.isFinite(n) || n < 0 || n > 31 || Math.round(n * 2) !== n * 2) {
    throw new AppraisalError(`${label} must be a number between 0 and 31 (half days allowed)`);
  }
  return n;
};

// Parse a date-only string ("YYYY-MM-DD") as IST noon so that UTC storage
// and ISO serialization both round-trip to the same calendar date.
// Without this, new Date("2026-10-01") = 2026-09-30T18:30Z in UTC,
// which serialises back as 2026-09-30 — one day early.
const parseIstDate = (s) => {
  if (!s) return null;
  // If it's already a Date or non-string, return as-is.
  if (typeof s !== "string") return new Date(s);
  // "YYYY-MM-DD" → treat as IST noon (UTC 06:30) so .toISOString() stays same day.
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, y, m, d] = match.map(Number);
    // IST noon = UTC 06:30
    return new Date(Date.UTC(y, m - 1, d, 6, 30));
  }
  return new Date(s);
};

export const updateHrInputs = async (doc, { leaves, lateMarks, notes, scoreFrom, scoreTo }, actor) => {
  assertEditable(doc);
  const before = { leaves: doc.hrInputs?.leaves ?? null, lateMarks: doc.hrInputs?.lateMarks ?? null };
  const next = { ...before };
  if (leaves !== undefined) next.leaves = validCount(leaves, "Leaves");
  if (lateMarks !== undefined) next.lateMarks = validCount(lateMarks, "Late marks");

  // Validate optional score period dates
  const parsedScoreFrom = scoreFrom ? parseIstDate(scoreFrom) : (doc.hrInputs?.scoreFrom ?? null);
  const parsedScoreTo = scoreTo ? parseIstDate(scoreTo) : (doc.hrInputs?.scoreTo ?? null);
  if (parsedScoreFrom && isNaN(parsedScoreFrom.getTime())) throw new AppraisalError("scoreFrom must be a valid date");
  if (parsedScoreTo && isNaN(parsedScoreTo.getTime())) throw new AppraisalError("scoreTo must be a valid date");
  if (parsedScoreFrom && parsedScoreTo && parsedScoreFrom > parsedScoreTo) {
    throw new AppraisalError("scoreFrom must be before or equal to scoreTo");
  }
  if (doc.month) {
    const period = monthPeriod(doc.month);
    if (parsedScoreFrom && (parsedScoreFrom < period.startAt || parsedScoreFrom > period.endAt)) {
      throw new AppraisalError(`scoreFrom must fall within ${doc.month}`);
    }
    if (parsedScoreTo && (parsedScoreTo < period.startAt || parsedScoreTo > period.endAt)) {
      throw new AppraisalError(`scoreTo must fall within ${doc.month}`);
    }
  }

  doc.hrInputs = {
    leaves: next.leaves,
    lateMarks: next.lateMarks,
    notes: notes !== undefined ? String(notes).slice(0, 2000) : doc.hrInputs?.notes || "",
    scoreFrom: scoreFrom === "" ? null : parsedScoreFrom,
    scoreTo: scoreTo === "" ? null : parsedScoreTo,
    updatedBy: actor._id,
    updatedAt: new Date(),
  };
  doc.evaluator = actor._id;
  await doc.save();

  const common = { actor, entityType: "appraisal", entityId: doc._id, subject: doc.user, month: doc.month };
  if (next.leaves !== before.leaves) {
    await audit({ ...common, action: before.leaves === null ? "leaves_entered" : "leaves_changed", before: { leaves: before.leaves }, after: { leaves: next.leaves } });
  }
  if (next.lateMarks !== before.lateMarks) {
    await audit({
      ...common,
      action: before.lateMarks === null ? "late_marks_entered" : "late_marks_changed",
      before: { lateMarks: before.lateMarks },
      after: { lateMarks: next.lateMarks },
    });
  }
  if (doc.status === "reopened" && (next.leaves !== before.leaves || next.lateMarks !== before.lateMarks)) {
    await audit({ ...common, action: "appraisal_modified_after_reopen", before, after: next });
  }
  return doc;
};

const twoDecimals = (n) => Math.round(n * 100) === Math.round(n * 100 * 1e6) / 1e6;

// Director's separate 0–20 assessment (director / admin only — enforced by
// the route). null clears it.
export const setDirectorAssessment = async (doc, { score, comment }, actor) => {
  assertEditable(doc);
  const before = { score: doc.directorAssessment?.score ?? null, comment: doc.directorAssessment?.comment || "" };
  let next = before.score;
  if (score !== undefined) {
    if (score === null || score === "") next = null;
    else {
      const n = Number(score);
      if (!Number.isFinite(n) || n < 0 || n > 20 || !twoDecimals(n)) throw new AppraisalError("Director's assessment must be between 0 and 20 (up to 2 decimals)");
      next = n;
    }
  }
  doc.directorAssessment = {
    score: next,
    comment: comment !== undefined ? String(comment || "").slice(0, 2000) : before.comment,
    updatedBy: actor._id,
    updatedAt: new Date(),
  };
  await doc.save();
  await audit({
    actor,
    action: "director_assessment_set",
    entityType: "appraisal",
    entityId: doc._id,
    subject: doc.user,
    month: doc.month,
    before,
    after: { score: next, comment: doc.directorAssessment.comment },
  });
  return doc;
};

// Optional Special Bonus % (HR / director / admin — enforced by the route).
export const setSpecialBonus = async (doc, { pct, reason }, actor) => {
  assertEditable(doc);
  const before = { pct: doc.specialBonus?.pct ?? 0, reason: doc.specialBonus?.reason || "" };
  let next = before.pct;
  if (pct !== undefined) {
    const n = pct === null || pct === "" ? 0 : Number(pct);
    if (!Number.isFinite(n) || n < 0 || n > 100 || !twoDecimals(n)) throw new AppraisalError("Special bonus must be between 0 and 100% (up to 2 decimals)");
    next = n;
  }
  const nextReason = reason !== undefined ? String(reason || "").trim().slice(0, 2000) : before.reason;
  if (next > 0 && nextReason.length < 3) throw new AppraisalError("Please give a short reason for the special bonus");
  doc.specialBonus = { pct: next, reason: next > 0 ? nextReason : "", updatedBy: actor._id, updatedAt: new Date() };
  await doc.save();
  await audit({
    actor,
    action: "special_bonus_set",
    entityType: "appraisal",
    entityId: doc._id,
    subject: doc.user,
    month: doc.month,
    before,
    after: { pct: next, reason: doc.specialBonus.reason },
  });
  return doc;
};

export const setEvaluation = async (doc, criterionKey, input, actor) => {
  assertEditable(doc);
  const snap = snapshotConfig(doc);
  const criterion = snap
    ? snap.criteria.find((c) => c.key === criterionKey)
    : await AppraisalCriterion.findOne({ key: criterionKey, isActive: true }).lean();
  if (!criterion) throw new AppraisalError("Criterion not found or inactive", 404);
  if (!snap) {
    const employee = await User.findById(doc.user).select("department team role designation").lean();
    if (!appliesToEmployee(criterion, employee || {})) {
      throw new AppraisalError("This criterion doesn't apply to this employee's department, team or position");
    }
  }
  if (criterion.type === "automatic") throw new AppraisalError("Automatic criteria are calculated by the system and can't be rated");

  const existing = (doc.evaluations || []).find((e) => e.criterionKey === criterionKey);
  const before = existing ? { ratingKey: existing.ratingKey, overridePct: existing.overridePct, comment: existing.comment } : null;
  const entry = existing || { criterionKey };

  if (criterion.type === "manual") {
    if (input.ratingKey !== undefined) {
      if (input.ratingKey !== null && !(criterion.ratingOptions || []).some((o) => o.key === input.ratingKey)) {
        throw new AppraisalError("Invalid rating option for this criterion");
      }
      entry.ratingKey = input.ratingKey;
    }
  }
  if (criterion.type === "hybrid" && input.overridePct !== undefined) {
    if (input.overridePct === null) {
      entry.overridePct = null;
      entry.overrideReason = "";
    } else {
      const pct = Number(input.overridePct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new AppraisalError("Adjusted performance must be between 0 and 100");
      const reason = String(input.overrideReason || "").trim();
      if (reason.length < 5) throw new AppraisalError("A reason is required when adjusting a system-calculated score");
      entry.overridePct = roundStore(pct);
      entry.overrideReason = reason.slice(0, 1000);
    }
  }
  if (input.comment !== undefined) entry.comment = String(input.comment || "").slice(0, 2000);
  entry.updatedBy = actor._id;
  entry.updatedAt = new Date();

  if (!existing) doc.evaluations.push(entry);
  doc.evaluator = actor._id;
  doc.markModified("evaluations");
  await doc.save();

  const after = { ratingKey: entry.ratingKey ?? null, overridePct: entry.overridePct ?? null, comment: entry.comment || "" };
  await audit({
    actor,
    action: criterion.type === "hybrid" && input.overridePct !== undefined ? "override_set" : "rating_set",
    entityType: "appraisal",
    entityId: doc._id,
    subject: doc.user,
    month: doc.month,
    before,
    after,
    meta: { criterionKey },
  });
  if (doc.status === "reopened") {
    await audit({ actor, action: "appraisal_modified_after_reopen", entityType: "appraisal", entityId: doc._id, subject: doc.user, month: doc.month, before, after, meta: { criterionKey } });
  }
  return doc;
};

export const submitAppraisal = async (doc, actor) => {
  assertEditable(doc);
  await recalculateOne(doc);
  if (!doc._complete) throw new AppraisalError(`Missing inputs: ${doc.missingInputs.join(", ")}`, 422);
  doc.status = "submitted";
  doc.submittedBy = actor._id;
  doc.submittedAt = new Date();
  await doc.save();
  await audit({ actor, action: "appraisal_submitted", entityType: "appraisal", entityId: doc._id, subject: doc.user, month: doc.month, after: { totalScore: doc.totalScore } });
  return doc;
};

const entryScores = (entries) => Object.fromEntries((entries || []).map((e) => [e.criterionKey, { score: e.score, performancePct: e.performancePct, rating: e.ratingLabel }]));

// Locks the appraisal as an immutable snapshot: fresh calculation against
// the live config, then the config itself, the metrics and the employee's
// identity are all copied onto the document. `actor` null = month-close job.
export const finalizeAppraisal = async (doc, actor, { now = new Date(), settings, criteria, auto = false } = {}) => {
  assertEditable(doc);
  if (!hasMonthEnded(doc.month, now)) {
    throw new AppraisalError("An appraisal can only be finalized after its month has ended (IST)", 409);
  }
  const employee = await User.findById(doc.user).select(EMPLOYEE_FIELDS).populate("department", "name").populate("team", "name");
  const snap = snapshotConfig(doc);
  const cfg = snap?.settings || settings || (await getSettings());
  // Only the criteria that apply to this employee's department, team and
  // position: that set must total 100%, and it's exactly what gets snapshotted.
  const crit = snap?.criteria || criteriaForEmployee(criteria || (await getActiveCriteria()), employee || {});
  const weight = validateWeightage(crit);
  if (!weight.valid) {
    throw new AppraisalError(`${employee?.department?.name || "No department"}: ${weight.message}`, 422);
  }

  await recalculateOne(doc, { now, settings: cfg, criteria: crit });
  if (!doc._complete) throw new AppraisalError(`Missing inputs: ${doc.missingInputs.join(", ")}`, 422);

  const wasReopened = doc.status === "reopened";
  const set = {
    status: "finalized",
    finalizedBy: actor?._id || null,
    finalizedAt: now,
    autoFinalized: auto,
    configSnapshot: buildConfigSnapshot(crit, cfg),
    employeeSnapshot: {
      name: employee?.name,
      email: employee?.email,
      role: employee?.role,
      designation: employee?.designation || "",
      departmentId: employee?.department?._id || null,
      departmentName: employee?.department?.name || "Unassigned",
      teamName: employee?.team?.name || "",
    },
  };
  if (wasReopened && doc.reopenHistory.length) {
    const last = doc.reopenHistory[doc.reopenHistory.length - 1];
    const beforeScores = last.changes?.beforeScores || {};
    const afterScores = entryScores(doc.entries);
    const criteriaChanged = Object.keys({ ...beforeScores, ...afterScores }).filter(
      (k) => JSON.stringify(beforeScores[k]) !== JSON.stringify(afterScores[k])
    );
    last.newScore = doc.totalScore;
    last.newClassification = doc.classification?.label || null;
    last.refinalizedAt = now;
    last.changes = {
      ...last.changes,
      afterScores,
      criteriaChanged,
      hrInputsAfter: { leaves: doc.hrInputs?.leaves ?? null, lateMarks: doc.hrInputs?.lateMarks ?? null },
    };
    set.reopenHistory = doc.reopenHistory;
  }

  const updated = await EmployeeAppraisal.findOneAndUpdate(
    { _id: doc._id, status: { $ne: "finalized" } },
    { $set: set },
    { returnDocument: "after" }
  );
  if (!updated) throw new AppraisalError("This appraisal was already finalized", 409);

  await AppraisalCriterion.updateMany({ key: { $in: crit.map((c) => c.key) }, usedInFinalized: false }, { $set: { usedInFinalized: true } });
  await audit({
    actor,
    action: "appraisal_finalized",
    entityType: "appraisal",
    entityId: doc._id,
    subject: doc.user,
    month: doc.month,
    after: { totalScore: updated.totalScore, classification: updated.classification?.label, settingsVersion: cfg.version },
    meta: { auto, refinalizedAfterReopen: wasReopened },
  });
  return updated;
};

export const reopenAppraisal = async (doc, actor, reason) => {
  const text = String(reason || "").trim();
  if (text.length < 10) throw new AppraisalError("Please give a reason for reopening (at least 10 characters)");
  if (doc.status !== "finalized") throw new AppraisalError("Only finalized appraisals can be reopened", 409);

  const entry = {
    by: actor._id,
    at: new Date(),
    reason: text.slice(0, 2000),
    oldScore: doc.totalScore,
    oldClassification: doc.classification?.label || null,
    changes: {
      beforeScores: entryScores(doc.entries),
      hrInputsBefore: { leaves: doc.hrInputs?.leaves ?? null, lateMarks: doc.hrInputs?.lateMarks ?? null },
      configVersionBefore: doc.configSnapshot?.settingsVersion ?? null,
    },
  };
  const updated = await EmployeeAppraisal.findOneAndUpdate(
    { _id: doc._id, status: "finalized" },
    { $set: { status: "reopened" }, $push: { reopenHistory: entry } },
    { returnDocument: "after" }
  );
  if (!updated) throw new AppraisalError("This appraisal is no longer finalized", 409);
  await audit({
    actor,
    action: "appraisal_reopened",
    entityType: "appraisal",
    entityId: doc._id,
    subject: doc.user,
    month: doc.month,
    before: { status: "finalized", totalScore: doc.totalScore },
    after: { status: "reopened" },
    meta: { reason: entry.reason },
  });
  return updated;
};
