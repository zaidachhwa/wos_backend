import { CRITERION_TYPES, METRICS, SCORING_METHODS, EVALUATION_FREQUENCIES } from "../../constants/appraisal.constants.js";
import { clamp, roundDisplay, roundStore, roundTo, toHundredths } from "./appraisalMath.js";
import { getExpectedPeriodsForMonth } from "./performancePeriod.js";

// The centralized, configuration-driven appraisal calculator. Pure: no DB,
// no clock — it takes criteria + settings + collected metrics + HR input and
// returns every criterion's score *with the steps that produced it*. The
// only place a score is ever computed; controllers, the month-close job and
// tests all call computeAppraisal.

const fmt = (n) => (n === null || n === undefined ? "—" : String(roundDisplay(n)));
const pctStr = (n) => `${fmt(n)}%`;

// ---------------------------------------------------------------- metrics

// Maps a metric key onto the collected metrics bundle
// (services/appraisal/appraisalMetrics.js). value === null means "nothing
// to measure" (e.g. no tasks), which the criterion's noDataPct handles.
export const resolveMetric = (metricKey, metrics) => {
  const t = metrics?.tasks || {};
  const p = metrics?.projects || {};
  const b = metrics?.bugs || {};
  const c = metrics?.clientChanges || {};
  const hr = metrics?.hr || {};

  switch (metricKey) {
    case "task_completion_rate":
      return {
        value: t.total ? t.completed / t.total : null,
        source: "WOS tasks",
        details: { total: t.total || 0, completed: t.completed || 0, pending: t.pending || 0, overdue: t.overdue || 0 },
        steps: [`Tasks in period: ${t.total || 0}`, `Completed: ${t.completed || 0}`, `Pending: ${t.pending || 0}`],
      };
    case "task_on_time_rate": {
      const denominator = (t.completed || 0) + (t.overdue || 0);
      return {
        value: denominator ? (t.completedOnTime || 0) / denominator : null,
        source: "WOS tasks (deadline vs completion time)",
        details: {
          total: t.total || 0,
          completedOnTime: t.completedOnTime || 0,
          completedLate: t.completedLate || 0,
          overdue: t.overdue || 0,
          overduePct: t.total ? roundStore(((t.overdue || 0) / t.total) * 100) : 0,
        },
        steps: [
          `Completed on time: ${t.completedOnTime || 0}`,
          `Completed late: ${t.completedLate || 0}`,
          `Still overdue at period end: ${t.overdue || 0}`,
          `On-time rate = on time ÷ (completed + overdue) = ${t.completedOnTime || 0} ÷ ${denominator}`,
        ],
      };
    }
    case "task_overdue_count":
      return {
        value: t.overdue || 0,
        source: "WOS tasks",
        details: { overdue: t.overdue || 0, completedLate: t.completedLate || 0 },
        steps: [`Overdue tasks at period end: ${t.overdue || 0}`],
      };
    case "project_weighted_completion":
    case "project_weighted_load": {
      const list = p.list || [];
      const lines = list.map(
        (x) => `${x.name}: weight ${fmt(x.effectiveWeight)} × completion ${pctStr((x.completionRate ?? 0) * 100)}`
      );
      const isLoad = metricKey === "project_weighted_load";
      return {
        value: list.length ? (isLoad ? p.weightedLoad : p.weightedCompletion) : null,
        source: "WOS projects (Project.weightage) + tasks",
        details: {
          projects: list.length,
          completedProjects: p.completedProjects || 0,
          ongoingProjects: p.ongoingProjects || 0,
          delayedProjects: p.delayedProjects || 0,
          weightFallback: Boolean(p.weightFallback),
        },
        steps: [
          ...lines,
          ...(p.weightFallback ? ["No project weightage configured — every project weighted equally"] : []),
          isLoad
            ? `Σ weight × completion = ${fmt(p.weightedLoad)}`
            : `Weighted completion = Σ(weight × completion) ÷ Σ weight = ${pctStr((p.weightedCompletion ?? 0) * 100)}`,
        ],
      };
    }
    case "bug_penalty_points":
    case "bug_count": {
      const rows = Object.values(b.bySeverity || {});
      const lines = rows.map((r) => `${r.label}: ${r.count} × ${fmt(r.penalty)} = ${fmt(r.subtotal)}`);
      const isCount = metricKey === "bug_count";
      return {
        value: isCount ? b.counted || 0 : b.penaltyPoints || 0,
        source: "Bug reports (Team Lead / HR)",
        details: { counted: b.counted || 0, total: b.total || 0, penaltyPoints: b.penaltyPoints || 0 },
        steps: isCount
          ? [`Bugs counted: ${b.counted || 0}`]
          : [...lines, `Total penalty = ${fmt(b.penaltyPoints || 0)}`],
      };
    }
    case "client_change_penalized_count":
      return {
        value: c.penalized || 0,
        source: "WOS tasks flagged as client change",
        details: { total: c.total || 0, penalized: c.penalized || 0, uncategorized: c.uncategorized || 0 },
        steps: [
          `Client changes in period: ${c.total || 0}`,
          `Counted against employee (by category): ${c.penalized || 0}`,
          ...(c.uncategorized ? [`Not yet categorized: ${c.uncategorized}`] : []),
        ],
      };
    case "hr_leaves":
      return {
        value: hr.leaves ?? null,
        missing: hr.leaves === null || hr.leaves === undefined,
        source: "HR entered",
        details: { leaves: hr.leaves ?? null },
        steps: [`HR entered leaves: ${hr.leaves ?? "not entered"}`],
      };
    case "hr_late_marks":
      return {
        value: hr.lateMarks ?? null,
        missing: hr.lateMarks === null || hr.lateMarks === undefined,
        source: "HR entered",
        details: { lateMarks: hr.lateMarks ?? null },
        steps: [`HR entered late marks: ${hr.lateMarks ?? "not entered"}`],
      };
    default:
      return { value: null, source: "unknown metric", details: null, steps: [`Unknown metric "${metricKey}"`] };
  }
};

// ---------------------------------------------------------------- methods

export const applyScoringMethod = (method, value, params = {}) => {
  switch (method) {
    case "ratio":
      return { pct: clamp(value * 100, 0, 100), step: `Performance = ${pctStr(value * 100)}` };
    case "target": {
      const target = Number(params.target);
      const pct = clamp((value / target) * 100, 0, 100);
      return { pct, step: `Performance = ${fmt(value)} ÷ target ${fmt(target)} = ${pctStr(pct)} (capped at 100%)` };
    }
    case "deduction": {
      const unitPct = Number(params.unitPct || 0);
      const free = Number(params.freeUnits || 0);
      const floor = Number(params.floorPct || 0);
      const counted = Math.max(0, value - free);
      const raw = 100 - counted * unitPct;
      const pct = clamp(Math.max(floor, raw), 0, 100);
      return {
        pct,
        step:
          `Performance = 100% − ${fmt(counted)}${free ? ` (after ${fmt(free)} free)` : ""} × ${fmt(unitPct)}%` +
          ` = ${pctStr(raw)}${pct !== raw ? ` → ${pctStr(pct)} (minimum ${pctStr(floor)})` : ""}`,
      };
    }
    case "bands": {
      const bands = params.bands || [];
      const band = bands.find((x) => value >= Number(x.min) && (x.max === null || x.max === undefined || x.max === "" || value <= Number(x.max)));
      const pct = clamp(band ? Number(band.pct) : Number(params.defaultPct || 0), 0, 100);
      return {
        pct,
        step: band
          ? `${fmt(value)} falls in band ${fmt(band.min)}–${band.max ?? "∞"} → ${pctStr(pct)}`
          : `${fmt(value)} matches no band → default ${pctStr(pct)}`,
      };
    }
    default:
      throw new Error(`Unsupported scoring method "${method}"`);
  }
};

// ---------------------------------------------------------------- criterion

// Manual criteria rated more often than monthly (daily/weekly/biweekly) get
// one rating per period of the appraisal month; their performance is the
// average of the rated periods.
export const PERIODIC_FREQUENCIES = ["daily", "weekly", "biweekly"];
export const isPeriodic = (criterion) => criterion?.type === "manual" && PERIODIC_FREQUENCIES.includes(criterion?.frequency);

const scorePeriodicRating = (criterion, evaluation, month, base) => {
  const weight = base.weightage;
  const optionByKey = new Map((criterion.ratingOptions || []).map((o) => [o.key, o]));
  const ratedByStart = new Map((evaluation?.periodRatings || []).map((r) => [r.startDate, r]));
  base.source = "HR evaluation";
  base.frequency = criterion.frequency;
  base.periods = getExpectedPeriodsForMonth(criterion.frequency, month).map((p) => {
    const option = optionByKey.get(ratedByStart.get(p.startDate)?.ratingKey);
    return {
      startDate: p.startDate,
      endDate: p.endDate,
      label: p.label,
      ratingKey: option?.key || null,
      ratingLabel: option?.label || null,
      pct: option ? roundStore(clamp(Number(option.pct), 0, 100)) : null,
    };
  });
  const rated = base.periods.filter((p) => p.pct !== null);
  for (const p of base.periods) base.steps.push(`${p.label}: ${p.ratingLabel ? `${p.ratingLabel} = ${pctStr(p.pct)}` : "not rated"}`);
  base.complete = rated.length === base.periods.length && rated.length > 0;
  if (!rated.length) {
    base.steps.push("Not rated yet");
    return base;
  }
  base.performancePct = roundStore(rated.reduce((s, p) => s + p.pct, 0) / rated.length);
  base.ratingLabel = `${rated.length}/${base.periods.length} rated`;
  base.score = roundStore((weight * base.performancePct) / 100);
  base.steps.push(
    `Average = (${rated.map((p) => fmt(p.pct)).join(" + ")}) / ${rated.length} = ${pctStr(base.performancePct)}`,
    `Score = ${fmt(weight)} × ${pctStr(base.performancePct)} = ${fmt(base.score)} / ${fmt(weight)}`
  );
  return base;
};

export const scoreCriterion = (criterion, metrics, evaluation = null, { month } = {}) => {
  const weight = Number(criterion.weightage);
  const base = {
    criterionKey: criterion.key,
    name: criterion.name,
    type: criterion.type,
    group: criterion.group || "automatic",
    weightage: weight,
    metric: criterion.metric || null,
    scoringMethod: criterion.scoringMethod,
    params: criterion.params || {},
    metricValue: null,
    metricDetails: null,
    systemPct: null,
    ratingKey: null,
    ratingLabel: null,
    overridePct: null,
    overrideReason: "",
    comment: evaluation?.comment || "",
    performancePct: null,
    score: 0,
    maxScore: weight,
    complete: true,
    noData: false,
    source: "",
    steps: [`Weightage: ${fmt(weight)}%`],
  };

  if (criterion.scoringMethod === "rating" && month && isPeriodic(criterion)) return scorePeriodicRating(criterion, evaluation, month, base);

  if (criterion.scoringMethod === "rating") {
    const option = (criterion.ratingOptions || []).find((o) => o.key === evaluation?.ratingKey);
    base.source = "HR evaluation";
    if (!option) {
      base.complete = false;
      base.steps.push("Not rated yet");
      return base;
    }
    base.ratingKey = option.key;
    base.ratingLabel = option.label;
    base.performancePct = roundStore(clamp(Number(option.pct), 0, 100));
    base.score = roundStore((weight * base.performancePct) / 100);
    base.steps.push(`Rating: ${option.label} = ${pctStr(option.pct)}`, `Score = ${fmt(weight)} × ${pctStr(option.pct)} = ${fmt(base.score)} / ${fmt(weight)}`);
    return base;
  }

  const metric = resolveMetric(criterion.metric, metrics);
  base.source = metric.source;
  base.metricDetails = metric.details;
  base.steps.push(...metric.steps);

  let systemPct;
  if (metric.missing) {
    base.complete = false;
    base.steps.push("Required HR input not entered yet");
    systemPct = null;
  } else if (metric.value === null || metric.value === undefined) {
    base.noData = true;
    systemPct = clamp(Number(criterion.params?.noDataPct ?? 0), 0, 100);
    base.steps.push(`No data for this period → ${pctStr(systemPct)} (configured)`);
  } else {
    base.metricValue = roundStore(metric.value);
    const result = applyScoringMethod(criterion.scoringMethod, metric.value, criterion.params);
    systemPct = result.pct;
    base.steps.push(result.step);
  }
  base.systemPct = systemPct === null ? null : roundStore(systemPct);

  let pct = base.systemPct;
  if (criterion.type === "hybrid" && evaluation?.overridePct !== null && evaluation?.overridePct !== undefined) {
    base.overridePct = roundStore(clamp(Number(evaluation.overridePct), 0, 100));
    base.overrideReason = evaluation.overrideReason || "";
    pct = base.overridePct;
    base.complete = true;
    base.steps.push(`HR adjusted: ${pctStr(base.systemPct)} → ${pctStr(pct)}${base.overrideReason ? ` (${base.overrideReason})` : ""}`);
  }

  if (pct === null) return base;
  base.performancePct = pct;
  base.score = roundStore((weight * pct) / 100);
  base.steps.push(`Score = ${fmt(weight)} × ${pctStr(pct)} = ${fmt(base.score)} / ${fmt(weight)}`);
  return base;
};

// ---------------------------------------------------------------- totals

export const classify = (score, classifications = [], decimals = 0) => {
  const rounded = roundTo(score, decimals);
  const band = classifications.find((c) => rounded >= Number(c.min) && rounded <= Number(c.max));
  return band
    ? {
        key: band.key,
        label: band.label,
        tone: band.tone || "muted",
        employeeIncrementPct: Number(band.employeeIncrementPct || 0),
        leaderIncrementPct: Number(band.leaderIncrementPct || 0),
      }
    : { key: null, label: null, tone: null, employeeIncrementPct: 0, leaderIncrementPct: 0 };
};

// The increment an appraisal earns: the band's leader rate for the leader
// group, otherwise its employee rate.
export const incrementFor = (classification, isLeader) => ({
  group: isLeader ? "leader" : "member",
  pct: Number((isLeader ? classification?.leaderIncrementPct : classification?.employeeIncrementPct) || 0),
});

// Weak criteria for the improvement-areas list: anything under the
// configured performance threshold, weakest first, capped at maxItems —
// never "every criterion".
export const identifyImprovementAreas = (entries, rule = {}) => {
  const threshold = Number(rule.thresholdPct ?? 60);
  const maxItems = Number(rule.maxItems ?? 3);
  return entries
    .filter((e) => e.weightage > 0 && e.performancePct !== null && e.performancePct < threshold)
    .sort((a, b) => a.performancePct - b.performancePct || b.weightage - a.weightage)
    .slice(0, maxItems)
    .map((e) => ({
      criterionKey: e.criterionKey,
      name: e.name,
      score: e.score,
      maxScore: e.maxScore,
      performancePct: e.performancePct,
    }));
};

const idStr = (v) => (v === null || v === undefined ? "" : String(v?._id || v));

// A main criterion whose score comes from its sub-criteria: its sub-criteria
// share the main criterion's points in proportion to their weightages, and
// the main criterion's score is the sum of theirs.
//   e.g. main 15 pts, 4 subs of equal weightage → 3.75 pts each; ratings
//   Poor/Good/Good/Good → 0.94 + 3.75 + 3.75 + 3.75 = 12.19 / 15
const scoreWithSubCriteria = (main, subs, metrics, evalByKey, opts) => {
  const weight = Number(main.weightage);
  const subTotal = subs.reduce((s, c) => s + Number(c.weightage || 0), 0);
  const subEntries = subs.map((c) => {
    const share = subTotal > 0 ? (weight * Number(c.weightage || 0)) / subTotal : weight / subs.length;
    const entry = scoreCriterion({ ...c, weightage: roundStore(share) }, metrics, evalByKey.get(c.key), opts);
    return { ...entry, group: main.group || entry.group, parentKey: main.key };
  });
  const score = roundStore(subEntries.reduce((s, e) => s + (e.score || 0), 0));
  const complete = subEntries.every((e) => e.complete);
  return [
    {
      ...scoreCriterion({ ...main, scoringMethod: "rating", ratingOptions: [] }, metrics, null),
      source: "Sum of sub-criteria",
      hasSubCriteria: true,
      score,
      maxScore: weight,
      performancePct: complete && weight > 0 ? roundStore((score / weight) * 100) : null,
      complete,
      steps: [
        `Weightage: ${fmt(weight)}% — shared by ${subEntries.length} sub-criteria`,
        ...subEntries.map((e) => `${e.name}: ${fmt(e.score)} / ${fmt(e.maxScore)}${e.ratingLabel ? ` (${e.ratingLabel})` : e.complete ? "" : " (not rated)"}`),
        `Score = ${subEntries.map((e) => fmt(e.score)).join(" + ")} = ${fmt(score)} / ${fmt(weight)}`,
      ],
    },
    ...subEntries,
  ];
};

// Scores every criterion. Sub-criteria never add to the total on their own:
// under a main criterion that scores from them they roll up into it (see
// scoreWithSubCriteria) and the entries carry `parentKey`; otherwise (main
// rated directly, inactive or not applicable) they are left out.
export const computeAppraisal = ({ criteria, settings, metrics, evaluations = [], month = null }) => {
  const opts = { month };
  const evalByKey = new Map(evaluations.map((e) => [e.criterionKey, e]));
  const subsByParent = new Map();
  for (const c of criteria) {
    if (!c.parentCriterion) continue;
    const pid = idStr(c.parentCriterion);
    if (!subsByParent.has(pid)) subsByParent.set(pid, []);
    subsByParent.get(pid).push(c);
  }
  const entries = [];
  for (const c of criteria) {
    if (c.parentCriterion) continue;
    const subs = subsByParent.get(idStr(c._id)) || [];
    if (subs.length && c.scoreFromSubCriteria !== false) entries.push(...scoreWithSubCriteria(c, subs, metrics, evalByKey, opts));
    else entries.push(scoreCriterion(c, metrics, evalByKey.get(c.key), opts));
  }
  const topLevel = entries.filter((e) => !e.parentKey);
  const rawTotal = topLevel.reduce((sum, e) => sum + (e.score || 0), 0);
  const totalScore = roundStore(clamp(rawTotal, 0, 100));
  // Name the sub-criteria still to rate, not the main criterion they roll into.
  const missingInputs = entries.filter((e) => !e.complete && !e.hasSubCriteria).map((e) => e.name);
  return {
    entries,
    totalScore,
    classification: classify(totalScore, settings?.classifications, settings?.classificationDecimals ?? 0),
    improvementAreas: identifyImprovementAreas(entries.filter((e) => !e.hasSubCriteria), settings?.improvementRule),
    missingInputs,
    complete: missingInputs.length === 0,
  };
};

// Final score = (criteria score out of 100 + Director's 0–20) ÷ 120 × 100,
// then + Special Bonus % as points (may exceed 100). The classification band
// is looked up on the final score capped at 100.
//   e.g. base 98, director 15, bonus 5 → (98 + 15) ÷ 120 × 100 = 94.17 → 99.17
export const DIRECTOR_MAX = 20;
export const composeFinalScore = ({ baseScore, directorScore, bonusPct = 0 }) => {
  const director = directorScore === null || directorScore === undefined ? 0 : clamp(Number(directorScore), 0, DIRECTOR_MAX);
  const convertedScore = roundStore(((Number(baseScore) + director) / (100 + DIRECTOR_MAX)) * 100);
  const totalScore = roundStore(convertedScore + Math.max(0, Number(bonusPct) || 0));
  return { convertedScore, totalScore, classificationScore: Math.min(100, totalScore) };
};

// ---------------------------------------------------------------- validation

export const validateWeightage = (activeCriteria) => {
  // Only top-level criteria sum to 100%
  const topLevel = activeCriteria.filter((c) => !c.parentCriterion);
  const hundredths = topLevel.reduce((sum, c) => sum + toHundredths(c.weightage), 0);
  const total = hundredths / 100;
  if (hundredths < 10000) {
    return { valid: false, total, message: `Active criteria weightage totals ${total}% — it must be exactly 100% (${roundDisplay(100 - total)}% short).` };
  }
  if (hundredths > 10000) {
    return { valid: false, total, message: `Active criteria weightage totals ${total}% — it must be exactly 100% (${roundDisplay(total - 100)}% over).` };
  }
  return { valid: true, total, message: "Weightage totals 100%." };
};

export const validateSubCriteriaWeightage = (subCriteria) => {
  if (!subCriteria || !subCriteria.length) return { valid: true, total: 100, message: "No sub-criteria." };
  const hundredths = subCriteria.reduce((sum, c) => sum + toHundredths(c.weightage), 0);
  const total = hundredths / 100;
  if (hundredths < 10000) {
    return { valid: false, total, message: `Sub-criteria weightage totals ${total}% — it must be exactly 100% (${roundDisplay(100 - total)}% short).` };
  }
  if (hundredths > 10000) {
    return { valid: false, total, message: `Sub-criteria weightage totals ${total}% — it must be exactly 100% (${roundDisplay(total - 100)}% over).` };
  }
  return { valid: true, total, message: "Sub-criteria weightage totals 100%." };
};

// A criterion with no departments applies to every department (and to
// employees with none); otherwise only to the listed departments.
export const appliesToDepartment = (criterion, departmentId) => {
  const list = criterion.departments || [];
  if (!list.length) return true;
  return Boolean(departmentId) && list.some((d) => String(d?._id || d) === String(departmentId));
};

// A criterion with no positions applies to everyone; otherwise to anyone whose
// position matches. `position` may be a list — callers pass the employee's
// base role plus their designation, so criteria saved before positions became
// roles keep matching.
export const appliesToPosition = (criterion, position) => {
  const list = criterion.positions || [];
  if (!list.length) return true;
  const mine = (Array.isArray(position) ? position : [position])
    .filter(Boolean)
    .map((p) => String(p).trim().toLowerCase());
  return list.some((p) => mine.includes(String(p).trim().toLowerCase()));
};

export const appliesToDepartmentAndPosition = (criterion, departmentId, position) =>
  appliesToDepartment(criterion, departmentId) && appliesToPosition(criterion, position);

// A department's own weightage for a criterion (departmentWeightages
// override), falling back to the criterion's default weightage.
export const effectiveWeightage = (criterion, departmentId) => {
  const override = departmentId
    ? (criterion.departmentWeightages || []).find((o) => String(o.department?._id || o.department) === String(departmentId))
    : null;
  return override ? Number(override.weightage) : Number(criterion.weightage);
};

// The criteria that apply to a department, each carrying that department's
// effective weightage — the exact set (and numbers) the engine scores and a
// finalized appraisal snapshots.
export const criteriaForDepartment = (criteria, departmentId) =>
  criteria.filter((c) => appliesToDepartment(c, departmentId)).map((c) => ({ ...c, weightage: effectiveWeightage(c, departmentId) }));

export const criteriaForDepartmentAndPosition = (criteria, departmentId, position) =>
  criteria
    .filter((c) => appliesToDepartmentAndPosition(c, departmentId, position))
    .map((c) => ({ ...c, weightage: effectiveWeightage(c, departmentId) }));

// A criterion with no teams applies to every team (and to employees with
// none); otherwise only to members of the listed teams.
export const appliesToTeam = (criterion, teamId) => {
  const list = criterion.teams || [];
  if (!list.length) return true;
  return Boolean(teamId) && list.some((t) => String(t?._id || t) === String(teamId));
};

const idOf = (v) => (v && typeof v === "object" && v._id ? v._id : v) || null;

// Full targeting for one employee: department, team and position (base role,
// with designation as a fallback for criteria saved before positions were
// roles). `employee` = { department, team, role, designation }, ids or
// populated docs.
export const appliesToEmployee = (criterion, employee = {}) =>
  appliesToDepartment(criterion, idOf(employee.department)) &&
  appliesToTeam(criterion, idOf(employee.team)) &&
  appliesToPosition(criterion, [employee.role, employee.designation]);

// The criteria that apply to one employee, each carrying their department's
// effective weightage: what the engine scores and a finalized appraisal
// snapshots.
export const criteriaForEmployee = (criteria, employee = {}) =>
  criteria
    .filter((c) => appliesToEmployee(c, employee))
    .map((c) => ({ ...c, weightage: effectiveWeightage(c, idOf(employee.department)) }));

// The 100% rule, per department: every department's applicable active
// criteria must total exactly 100%. `departments` = [{ _id, name }]; pass
// includeUnassigned when some appraised employees have no department (they
// only get the all-department criteria).
//
// When criteria are also targeted by team or position, one department total
// means nothing, so each department is checked once per employee profile
// ({ role, team, teamName }) found in it; `profiles` maps departmentId
// ("" for none) to that list. A department without profiles gets one
// untargeted check, as before.
export const validateDepartmentWeightage = (activeCriteria, departments = [], { includeUnassigned = false, profiles = {} } = {}) => {
  const scopes = departments.map((d) => ({ departmentId: String(d._id), name: d.name }));
  if (includeUnassigned || !scopes.length) scopes.push({ departmentId: null, name: departments.length ? "No department" : "All departments" });
  const targeted = activeCriteria.some((c) => (c.positions || []).length || (c.teams || []).length);
  const byDepartment = scopes.map((s) => {
    const own = targeted ? profiles[s.departmentId || ""] || [] : [];
    if (!own.length) {
      const r = validateWeightage(criteriaForDepartment(activeCriteria, s.departmentId));
      return { ...s, total: r.total, valid: r.valid, message: r.message };
    }
    const checks = own.map((p) => ({
      p,
      r: validateWeightage(criteriaForEmployee(activeCriteria, { department: s.departmentId, team: p.team, role: p.role })),
    }));
    const bad = checks.filter((c) => !c.r.valid);
    const shown = (bad[0] || checks[0]).r;
    const who = (p) => [p.role, p.teamName].filter(Boolean).join(" / ") || "no role";
    return {
      ...s,
      total: shown.total,
      valid: bad.length === 0,
      message: bad.length ? bad.map((c) => `(${who(c.p)}) ${c.r.message}`).join(" ") : checks[0].r.message,
    };
  });
  const invalid = byDepartment.filter((d) => !d.valid);
  return {
    valid: invalid.length === 0,
    total: validateWeightage(activeCriteria.filter((c) => !(c.departments || []).length)).total,
    byDepartment,
    message: invalid.length
      ? invalid.map((d) => `${d.name}: ${d.message}`).join(" ")
      : "Weightage totals 100% for every department.",
  };
};

export const validateCriterion = (c) => {
  const errors = [];
  if (!c.name || !String(c.name).trim()) errors.push("Name is required");
  if (!c.key || !/^[a-z0-9_]+$/.test(c.key)) errors.push("Key must be lowercase letters, digits or underscores");
  if (!CRITERION_TYPES.includes(c.type)) errors.push(`Type must be one of ${CRITERION_TYPES.join(", ")}`);
  if (c.frequency && !EVALUATION_FREQUENCIES.includes(c.frequency)) {
    errors.push(`Frequency must be one of: ${EVALUATION_FREQUENCIES.join(", ")}`);
  }
  const w = Number(c.weightage);
  if (!Number.isFinite(w) || w < 0 || w > 100) errors.push("Weightage must be between 0 and 100");
  else if (toHundredths(w) !== roundTo(w * 100, 6)) errors.push("Weightage allows at most 2 decimals");
  if (!SCORING_METHODS.includes(c.scoringMethod)) errors.push(`Scoring method must be one of ${SCORING_METHODS.join(", ")}`);

  if (c.type === "manual") {
    if (c.scoringMethod !== "rating") errors.push("Manual criteria use the rating scoring method");
    if (!c.scoreFromSubCriteria) {
      const options = c.ratingOptions || [];
      if (options.length < 2) errors.push("Manual criteria need at least 2 rating options");
      const keys = new Set();
      for (const o of options) {
        if (!o.key || !o.label) errors.push("Every rating option needs a key and label");
        if (keys.has(o.key)) errors.push(`Duplicate rating option "${o.key}"`);
        keys.add(o.key);
        const pct = Number(o.pct);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) errors.push(`Rating "${o.label}" percentage must be 0–100`);
      }
    }
  } else {
    if (c.scoringMethod === "rating") errors.push("Only manual criteria can use the rating method");
    if (!METRICS[c.metric]) errors.push("Automatic/hybrid criteria need a valid data source metric");
    const p = c.params || {};
    if (c.scoringMethod === "ratio" && METRICS[c.metric] && METRICS[c.metric].unit !== "ratio") {
      errors.push(`The ratio method needs a ratio metric; "${METRICS[c.metric].label}" is a ${METRICS[c.metric].unit}`);
    }
    if (c.scoringMethod === "target" && !(Number(p.target) > 0)) errors.push("Target method needs a target greater than 0");
    if (c.scoringMethod === "deduction") {
      if (!(Number(p.unitPct) >= 0)) errors.push("Deduction method needs a non-negative percentage per unit");
      if (p.freeUnits !== undefined && !(Number(p.freeUnits) >= 0)) errors.push("Free units must be 0 or more");
      if (p.floorPct !== undefined && !(Number(p.floorPct) >= 0 && Number(p.floorPct) <= 100)) errors.push("Minimum percentage must be 0–100");
    }
    if (c.scoringMethod === "bands") {
      const bands = p.bands || [];
      if (!bands.length) errors.push("Bands method needs at least one band");
      for (const b of bands) {
        if (!Number.isFinite(Number(b.min))) errors.push("Every band needs a numeric minimum");
        if (!(Number(b.pct) >= 0 && Number(b.pct) <= 100)) errors.push("Band percentages must be 0–100");
      }
    }
    if (p.noDataPct !== undefined && !(Number(p.noDataPct) >= 0 && Number(p.noDataPct) <= 100)) {
      errors.push("No-data percentage must be 0–100");
    }
  }
  return errors;
};

// Bands must not overlap and must tile 0–100 in steps of the classification
// precision (whole numbers by default: 0–35, 36–75, 76–100).
export const validateClassifications = (classifications, decimals = 0) => {
  const errors = [];
  if (!classifications?.length) return ["At least one classification is required"];
  const step = 1 / 10 ** decimals;
  const sorted = [...classifications].sort((a, b) => Number(a.min) - Number(b.min));
  const keys = new Set();
  sorted.forEach((c, i) => {
    if (!c.key || !c.label) errors.push("Every classification needs a key and label");
    if (keys.has(c.key)) errors.push(`Duplicate classification "${c.key}"`);
    keys.add(c.key);
    if (Number(c.min) > Number(c.max)) errors.push(`"${c.label}" minimum is above its maximum`);
    if (i === 0 && Number(c.min) !== 0) errors.push("The lowest classification must start at 0");
    if (i === sorted.length - 1 && Number(c.max) !== 100) errors.push("The highest classification must end at 100");
    if (i > 0) {
      const expected = roundTo(Number(sorted[i - 1].max) + step, decimals);
      if (Number(c.min) < expected) errors.push(`"${c.label}" overlaps "${sorted[i - 1].label}"`);
      else if (Number(c.min) > expected) errors.push(`Gap between "${sorted[i - 1].label}" and "${c.label}"`);
    }
  });
  return errors;
};

export const validateSeverities = (severities) => {
  const errors = [];
  const keys = new Set();
  for (const s of severities || []) {
    if (!s.key || !/^[a-z0-9_]+$/.test(s.key)) errors.push("Severity keys must be lowercase letters, digits or underscores");
    if (!s.label) errors.push("Every severity needs a label");
    if (keys.has(s.key)) errors.push(`Duplicate severity "${s.key}"`);
    keys.add(s.key);
    const penalty = Number(s.penalty);
    if (!Number.isFinite(penalty) || penalty < 0) errors.push(`Penalty for "${s.label || s.key}" must be a non-negative number`);
  }
  if (!(severities || []).some((s) => s.isActive !== false)) errors.push("At least one severity must be active");
  return errors;
};
