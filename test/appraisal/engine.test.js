import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  applyScoringMethod,
  classify,
  computeAppraisal,
  criteriaForDepartment,
  identifyImprovementAreas,
  validateDepartmentWeightage,
  scoreCriterion,
  validateClassifications,
  validateCriterion,
  validateWeightage,
} from "../../src/services/appraisal/appraisalEngine.js";
import { DEFAULT_CRITERIA, DEFAULT_SETTINGS } from "../../src/services/appraisal/appraisalDefaults.js";
import { monthDueForClose, monthPeriod, istMonthOf } from "../../src/services/appraisal/appraisalPeriod.js";
import { roundDisplay, roundTo } from "../../src/services/appraisal/appraisalMath.js";

const settings = DEFAULT_SETTINGS;
const byKey = (key) => DEFAULT_CRITERIA.find((c) => c.key === key);
const rate = (key, ratingKey) => scoreCriterion(byKey(key), {}, { criterionKey: key, ratingKey });

// A metrics bundle in the shape services/appraisal/appraisalMetrics.js returns.
const metrics = (over = {}) => ({
  tasks: { total: 100, completed: 90, pending: 10, overdue: 10, completedOnTime: 85, completedLate: 5, ...over.tasks },
  projects: {
    list: [
      { name: "Navy", weightage: 40, effectiveWeight: 40, completionRate: 1 },
      { name: "WOS", weightage: 15, effectiveWeight: 15, completionRate: 0.5 },
    ],
    weightedCompletion: (40 * 1 + 15 * 0.5) / 55,
    weightedLoad: 47.5,
    ...over.projects,
  },
  bugs: {
    counted: 6,
    penaltyPoints: 14,
    bySeverity: {
      critical: { label: "Critical", count: 1, penalty: 5, subtotal: 5 },
      major: { label: "Major", count: 2, penalty: 3, subtotal: 6 },
      minor: { label: "Minor", count: 3, penalty: 1, subtotal: 3 },
    },
    ...over.bugs,
  },
  clientChanges: { total: 2, penalized: 0, uncategorized: 2, ...over.clientChanges },
  hr: { leaves: 2, lateMarks: 4, ...over.hr },
});

describe("weightage validation", () => {
  test("default criteria total exactly 100%", () => {
    assert.equal(validateWeightage(DEFAULT_CRITERIA).valid, true);
  });
  test("total below 100 is rejected", () => {
    const r = validateWeightage([{ weightage: 60 }, { weightage: 39.99 }]);
    assert.equal(r.valid, false);
    assert.match(r.message, /short/);
  });
  test("total above 100 is rejected", () => {
    const r = validateWeightage([{ weightage: 60 }, { weightage: 40.01 }]);
    assert.equal(r.valid, false);
    assert.match(r.message, /over/);
  });
  test("decimal weightages that sum to 100 are accepted without float drift", () => {
    assert.equal(validateWeightage([{ weightage: 33.33 }, { weightage: 33.33 }, { weightage: 33.34 }]).valid, true);
  });
});

describe("department-specific criteria", () => {
  const eng = { _id: "d-eng", name: "Engineering" };
  const ops = { _id: "d-ops", name: "Operations" };
  const all = [
    { key: "a", weightage: 90, departments: [] },
    { key: "eng_only", weightage: 10, departments: ["d-eng"] },
    { key: "ops_only", weightage: 10, departments: ["d-ops"] },
  ];

  test("no departments = applies everywhere; listed = only there", () => {
    assert.deepEqual(criteriaForDepartment(all, "d-eng").map((c) => c.key), ["a", "eng_only"]);
    assert.deepEqual(criteriaForDepartment(all, "d-ops").map((c) => c.key), ["a", "ops_only"]);
    assert.deepEqual(criteriaForDepartment(all, null).map((c) => c.key), ["a"]);
  });

  test("each department must total exactly 100%", () => {
    assert.equal(validateDepartmentWeightage(all, [eng, ops]).valid, true);
    const r = validateDepartmentWeightage(all.slice(0, 2), [eng, ops]);
    assert.equal(r.valid, false);
    assert.match(r.message, /^Operations:/);
    assert.equal(r.byDepartment.find((d) => d.name === "Engineering").valid, true);
  });

  test("employees without a department are checked only when they exist", () => {
    assert.equal(validateDepartmentWeightage(all, [eng, ops]).byDepartment.length, 2);
    const r = validateDepartmentWeightage(all, [eng, ops], { includeUnassigned: true });
    assert.equal(r.valid, false); // "No department" only gets the 90% all-department criteria
    assert.match(r.message, /No department/);
  });

  test("per-department weightage overrides the default only in that department", () => {
    const shared = [
      { key: "tasks", weightage: 60, departmentWeightages: [{ department: "d-ops", weightage: 70 }], departments: [] },
      { key: "discipline", weightage: 40, departmentWeightages: [{ department: "d-ops", weightage: 30 }], departments: [] },
    ];
    assert.deepEqual(criteriaForDepartment(shared, "d-eng").map((c) => c.weightage), [60, 40]);
    assert.deepEqual(criteriaForDepartment(shared, "d-ops").map((c) => c.weightage), [70, 30]);
    assert.equal(validateDepartmentWeightage(shared, [eng, ops]).valid, true);
    const broken = [{ ...shared[0] }, { ...shared[1], departmentWeightages: [] }]; // Ops: 70 + 40
    const r = validateDepartmentWeightage(broken, [eng, ops]);
    assert.equal(r.valid, false);
    assert.equal(r.byDepartment.find((d) => d.name === "Operations").total, 110);
  });

  test("an employee is scored only on their department's criteria", () => {
    const criteria = [
      { ...byKey("discipline"), weightage: 50, departments: [] },
      { ...byKey("professionalism"), key: "eng_quality", name: "Code Quality", weightage: 50, departments: ["d-eng"] },
      { ...byKey("professionalism"), key: "ops_sla", name: "SLA Adherence", weightage: 50, departments: ["d-ops"] },
    ];
    const evaluations = ["discipline", "eng_quality", "ops_sla"].map((k) => ({ criterionKey: k, ratingKey: "excellent" }));
    const r = computeAppraisal({ criteria: criteriaForDepartment(criteria, "d-ops"), settings, metrics: {}, evaluations });
    assert.deepEqual(r.entries.map((e) => e.criterionKey), ["discipline", "ops_sla"]);
    assert.equal(r.totalScore, 100);
  });
});

describe("manual rating", () => {
  test("Excellent = 5 / 5", () => {
    const e = rate("professionalism", "excellent");
    assert.equal(e.score, 5);
    assert.equal(e.ratingLabel, "Excellent");
  });
  test("Average = 3.33 / 5", () => {
    assert.equal(roundDisplay(rate("professionalism", "average").score), 3.33);
  });
  test("Poor = 1.67 / 5", () => {
    assert.equal(roundDisplay(rate("professionalism", "poor").score), 1.67);
  });
  test("unrated manual criterion is incomplete and scores 0", () => {
    const e = rate("discipline", undefined);
    assert.equal(e.complete, false);
    assert.equal(e.score, 0);
  });
  test("rating percentages come from configuration, not code", () => {
    const custom = { ...byKey("discipline"), ratingOptions: [{ key: "good", label: "Good", pct: 80 }, { key: "bad", label: "Bad", pct: 10 }] };
    assert.equal(scoreCriterion(custom, {}, { ratingKey: "good" }).score, 4);
  });
});

describe("automatic criteria", () => {
  test("task completion 90/100 at 15% weight = 13.5", () => {
    const e = scoreCriterion({ ...byKey("task_completion"), weightage: 15 }, metrics());
    assert.equal(e.score, 13.5);
    assert.equal(e.performancePct, 90);
  });
  test("timeliness = on time ÷ (completed + overdue)", () => {
    const e = scoreCriterion({ ...byKey("task_timeliness"), weightage: 10 }, metrics());
    assert.equal(roundDisplay(e.performancePct), roundDisplay((85 / 100) * 100));
    assert.equal(roundDisplay(e.score), 8.5);
  });
  test("bug penalty 1×5 + 2×3 + 3×1 = 14, deducted per configured %", () => {
    const e = scoreCriterion(byKey("bug_management"), metrics());
    assert.equal(e.metricValue, 14);
    assert.equal(e.performancePct, 72); // 100 − 14 × 2%
    assert.equal(e.score, 7.2);
  });
  test("changing bug penalties changes the score (configurable, not hard-coded)", () => {
    const heavier = metrics({ bugs: { penaltyPoints: 1 * 10 + 2 * 5 + 3 * 2 } });
    assert.equal(scoreCriterion(byKey("bug_management"), heavier).performancePct, 48);
  });
  test("a penalty criterion never goes negative", () => {
    const e = scoreCriterion(byKey("bug_management"), metrics({ bugs: { penaltyPoints: 500 } }));
    assert.equal(e.score, 0);
    assert.equal(e.performancePct, 0);
  });
  test("floorPct keeps a configured minimum", () => {
    const c = { ...byKey("bug_management"), params: { unitPct: 2, floorPct: 20 } };
    assert.equal(scoreCriterion(c, metrics({ bugs: { penaltyPoints: 500 } })).performancePct, 20);
  });
  test("leaves = HR entered 2 → 80% → 4 / 5", () => {
    const e = scoreCriterion(byKey("leaves"), metrics());
    assert.equal(e.performancePct, 80);
    assert.equal(e.score, 4);
    assert.equal(e.source, "HR entered");
  });
  test("late marks = HR entered 4 → 80% → 4 / 5", () => {
    const e = scoreCriterion(byKey("late_marks"), metrics());
    assert.equal(e.performancePct, 80);
    assert.equal(e.score, 4);
  });
  test("leaves not entered by HR blocks completeness rather than defaulting", () => {
    const e = scoreCriterion(byKey("leaves"), metrics({ hr: { leaves: null } }));
    assert.equal(e.complete, false);
    assert.equal(e.performancePct, null);
  });
  test("project contribution weights completion by project weightage", () => {
    const e = scoreCriterion(byKey("project_contribution"), metrics());
    assert.equal(roundDisplay(e.performancePct), roundDisplay((47.5 / 55) * 100));
  });
  test("no tasks → configured noDataPct, flagged", () => {
    const e = scoreCriterion(byKey("task_completion"), metrics({ tasks: { total: 0, completed: 0, overdue: 0, completedOnTime: 0 } }));
    assert.equal(e.noData, true);
    assert.equal(e.performancePct, 0);
  });
  test("hybrid override replaces the system percentage and records the reason", () => {
    const c = { ...byKey("task_completion"), type: "hybrid", weightage: 20 };
    const e = scoreCriterion(c, metrics(), { overridePct: 100, overrideReason: "Tasks blocked by client" });
    assert.equal(e.systemPct, 90);
    assert.equal(e.score, 20);
    assert.ok(e.steps.some((s) => s.includes("HR adjusted")));
  });
  test("automatic criteria ignore an override", () => {
    const e = scoreCriterion(byKey("task_completion"), metrics(), { overridePct: 100, overrideReason: "x" });
    assert.equal(e.performancePct, 90);
  });
  test("target and bands methods", () => {
    assert.equal(applyScoringMethod("target", 30, { target: 40 }).pct, 75);
    assert.equal(applyScoringMethod("target", 80, { target: 40 }).pct, 100);
    const bands = { bands: [{ min: 0, max: 1, pct: 100 }, { min: 2, max: 3, pct: 60 }, { min: 4, max: null, pct: 0 }] };
    assert.equal(applyScoringMethod("bands", 3, bands).pct, 60);
    assert.equal(applyScoringMethod("bands", 9, bands).pct, 0);
  });
});

describe("classification", () => {
  const c = settings.classifications;
  test("0–35 → Needs Improvement", () => {
    assert.equal(classify(0, c).key, "needs_improvement");
    assert.equal(classify(35, c).key, "needs_improvement");
    assert.equal(classify(35.4, c).key, "needs_improvement");
  });
  test("36–75 → Consistent Performance but Under the Acceptance Criteria", () => {
    assert.equal(classify(36, c).label, "Consistent Performance but Under the Acceptance Criteria");
    assert.equal(classify(74.16, c).key, "consistent");
    assert.equal(classify(75, c).key, "consistent");
  });
  test("76–100 → Excellent Performance", () => {
    assert.equal(classify(76, c).label, "Excellent Performance");
    assert.equal(classify(100, c).key, "excellent");
  });
  test("thresholds are configurable and validated for overlap/gaps/coverage", () => {
    assert.deepEqual(validateClassifications(c, 0), []);
    assert.ok(validateClassifications([{ key: "a", label: "A", min: 0, max: 50 }, { key: "b", label: "B", min: 50, max: 100 }]).some((e) => /overlaps/.test(e)));
    assert.ok(validateClassifications([{ key: "a", label: "A", min: 0, max: 40 }, { key: "b", label: "B", min: 45, max: 100 }]).some((e) => /Gap/.test(e)));
    assert.ok(validateClassifications([{ key: "a", label: "A", min: 5, max: 100 }]).some((e) => /start at 0/.test(e)));
    const custom = [{ key: "low", label: "Low", min: 0, max: 49 }, { key: "high", label: "High", min: 50, max: 100 }];
    assert.equal(classify(49, custom).key, "low");
  });
});

describe("final score", () => {
  test("sums every criterion, stays within 0–100, and is fully explainable", () => {
    const evaluations = ["discipline", "policy_compliance", "helping_nature", "professionalism", "critical_behaviour"].map((k) => ({
      criterionKey: k,
      ratingKey: "average",
    }));
    const r = computeAppraisal({ criteria: DEFAULT_CRITERIA, settings, metrics: metrics(), evaluations });
    const manualSum = r.entries.filter((e) => e.type === "manual").reduce((s, e) => s + e.score, 0);
    const expected = (15 * 47.5) / 55 + 20 * 0.9 + 15 * 0.85 + 10 * 0.72 + 5 * 1 + 5 * 0.8 + 5 * 0.8 + manualSum;
    assert.equal(roundDisplay(r.totalScore), roundDisplay(expected));
    assert.equal(r.complete, true);
    assert.ok(r.entries.every((e) => e.steps.length > 1 && e.source));
    assert.ok(r.totalScore >= 0 && r.totalScore <= 100);
  });
  test("missing HR input is reported, not silently scored", () => {
    const r = computeAppraisal({ criteria: DEFAULT_CRITERIA, settings, metrics: metrics({ hr: { leaves: null, lateMarks: null } }), evaluations: [] });
    assert.equal(r.complete, false);
    assert.ok(r.missingInputs.includes("Leaves"));
    assert.ok(r.missingInputs.includes("Late Marks"));
    assert.ok(r.missingInputs.includes("Discipline"));
  });
});

describe("improvement areas", () => {
  test("lists only weak criteria, weakest first, capped", () => {
    const entries = [
      { criterionKey: "a", name: "A", weightage: 10, performancePct: 30, score: 3, maxScore: 10 },
      { criterionKey: "b", name: "B", weightage: 10, performancePct: 90, score: 9, maxScore: 10 },
      { criterionKey: "c", name: "C", weightage: 5, performancePct: 20, score: 1, maxScore: 5 },
      { criterionKey: "d", name: "D", weightage: 5, performancePct: 50, score: 2.5, maxScore: 5 },
    ];
    const areas = identifyImprovementAreas(entries, { thresholdPct: 60, maxItems: 2 });
    assert.deepEqual(areas.map((a) => a.criterionKey), ["c", "a"]);
  });
});

describe("criterion validation", () => {
  test("default criteria are valid", () => {
    for (const c of DEFAULT_CRITERIA) assert.deepEqual(validateCriterion(c), [], c.key);
  });
  test("manual criterion needs rating options; automatic needs a metric", () => {
    assert.ok(validateCriterion({ ...byKey("discipline"), ratingOptions: [] }).length);
    assert.ok(validateCriterion({ ...byKey("task_completion"), metric: "nope" }).length);
    assert.ok(validateCriterion({ ...byKey("leaves"), scoringMethod: "ratio" }).length, "ratio on a count metric");
  });
});

describe("IST periods and scheduler timing", () => {
  test("September 2026 covers exactly 01-Sep 00:00 IST → 30-Sep 23:59:59.999 IST", () => {
    const p = monthPeriod("2026-09");
    assert.equal(p.startAt.toISOString(), "2026-08-31T18:30:00.000Z");
    assert.equal(p.endAt.toISOString(), "2026-09-30T18:29:59.999Z");
    assert.equal(p.dayEnd, "2026-09-30");
  });
  test("September email is due 01-Oct-2026 00:01 IST", () => {
    assert.equal(monthPeriod("2026-09").emailDueAt.toISOString(), "2026-09-30T18:31:00.000Z");
    assert.equal(monthPeriod("2026-10").emailDueAt.toISOString(), "2026-10-31T18:31:00.000Z"); // 01-Nov 00:01 IST
    assert.equal(monthPeriod("2026-11").emailDueAt.toISOString(), "2026-11-30T18:31:00.000Z"); // 01-Dec 00:01 IST
  });
  test("month close fires at 00:01 IST on the 1st, not before, not on UTC", () => {
    assert.equal(monthDueForClose(new Date("2026-09-30T18:30:30.000Z")), null); // 01-Oct 00:00:30 IST
    assert.equal(monthDueForClose(new Date("2026-09-30T18:31:00.000Z")), "2026-09"); // 01-Oct 00:01 IST
    assert.equal(istMonthOf(new Date("2026-09-30T19:00:00.000Z")), "2026-10"); // already October in IST, still Sept in UTC
  });
  test("December → January rolls the year", () => {
    assert.equal(monthDueForClose(new Date("2026-12-31T18:31:00.000Z")), "2026-12");
    assert.equal(monthPeriod("2026-12").emailDueAt.toISOString(), "2026-12-31T18:31:00.000Z");
  });
});

describe("precision", () => {
  test("central rounding is half-up and float-safe", () => {
    assert.equal(roundTo(1.005, 2), 1.01);
    assert.equal(roundDisplay(13.333333), 13.33);
    assert.equal(roundDisplay(86.665), 86.67);
  });
});
