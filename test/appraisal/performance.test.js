import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  getPeriodBounds,
  getExpectedPeriodsForMonth,
  daysInMonth,
  getMonthBounds,
} from "../../src/services/appraisal/performancePeriod.js";
import {
  appliesToPosition,
  appliesToDepartmentAndPosition,
  appliesToEmployee,
  criteriaForEmployee,
  validateDepartmentWeightage,
  validateWeightage,
  validateSubCriteriaWeightage,
} from "../../src/services/appraisal/appraisalEngine.js";

describe("performance evaluation periods", () => {
  test("days in month handles leap years and different month lengths", () => {
    assert.equal(daysInMonth(2026, 2), 28);
    assert.equal(daysInMonth(2024, 2), 29); // leap year
    assert.equal(daysInMonth(2026, 9), 30);
    assert.equal(daysInMonth(2026, 10), 31);
  });

  test("daily period bounds", () => {
    const p = getPeriodBounds("daily", "2026-10-17");
    assert.equal(p.frequency, "daily");
    assert.equal(p.startDate, "2026-10-17");
    assert.equal(p.endDate, "2026-10-17");
    assert.equal(p.month, "2026-10");
  });

  test("weekly period bounds run Monday to Saturday", () => {
    // 2026-10-17 is Saturday
    const p = getPeriodBounds("weekly", "2026-10-17");
    assert.equal(p.frequency, "weekly");
    assert.equal(p.startDate, "2026-10-12"); // Monday
    assert.equal(p.endDate, "2026-10-17"); // Saturday

    // Sunday belongs to the week before it
    const sun = getPeriodBounds("weekly", "2026-10-18");
    assert.equal(sun.startDate, "2026-10-12");
    assert.equal(sun.endDate, "2026-10-17");
  });

  test("weeks belong to the month their Monday falls in", () => {
    // 2026-10-01 is Thursday — its week started Monday 2026-09-28
    const p = getPeriodBounds("weekly", "2026-10-01");
    assert.equal(p.startDate, "2026-09-28");
    assert.equal(p.endDate, "2026-10-03");
    assert.equal(p.month, "2026-09");
  });

  test("biweekly periods run 1st Monday to 2nd Saturday, then 3rd Monday onwards", () => {
    // October 2026 Mondays: 5, 12, 19, 26
    const p1 = getPeriodBounds("biweekly", "2026-10-10");
    assert.equal(p1.startDate, "2026-10-05");
    assert.equal(p1.endDate, "2026-10-17");
    assert.equal(p1.month, "2026-10");

    const p2 = getPeriodBounds("biweekly", "2026-10-20");
    assert.equal(p2.startDate, "2026-10-19");
    assert.equal(p2.endDate, "2026-10-31");

    // 2026-10-02 (Friday) is in the week of Monday 2026-09-28 — September's 5th
    // week, which joins September's second period (3rd Monday 2026-09-21).
    const prev = getPeriodBounds("biweekly", "2026-10-02");
    assert.equal(prev.month, "2026-09");
    assert.equal(prev.startDate, "2026-09-21");
    assert.equal(prev.endDate, "2026-10-03");
  });

  test("monthly criteria are marked once per week of the month", () => {
    const p = getPeriodBounds("monthly", "2026-09-16");
    assert.equal(p.frequency, "monthly");
    assert.equal(p.startDate, "2026-09-14");
    assert.equal(p.endDate, "2026-09-19");
    assert.equal(p.month, "2026-09");
    assert.equal(p.label, "Week 2 (2026-09-14 to 2026-09-19)");

    const m = getMonthBounds("2026-09");
    assert.equal(m.startDate, "2026-09-01");
    assert.equal(m.endDate, "2026-09-30");
  });

  test("expected periods for month", () => {
    const dailyPeriods = getExpectedPeriodsForMonth("daily", "2026-10");
    assert.equal(dailyPeriods.length, 31);

    const weeklyPeriods = getExpectedPeriodsForMonth("weekly", "2026-10");
    assert.deepEqual(
      weeklyPeriods.map((p) => [p.startDate, p.endDate]),
      [
        ["2026-10-05", "2026-10-10"],
        ["2026-10-12", "2026-10-17"],
        ["2026-10-19", "2026-10-24"],
        ["2026-10-26", "2026-10-31"],
      ]
    );

    const biweeklyPeriods = getExpectedPeriodsForMonth("biweekly", "2026-10");
    assert.equal(biweeklyPeriods.length, 2);
    assert.equal(biweeklyPeriods[0].startDate, "2026-10-05");
    assert.equal(biweeklyPeriods[0].endDate, "2026-10-17");
    assert.equal(biweeklyPeriods[1].startDate, "2026-10-19");
    assert.equal(biweeklyPeriods[1].endDate, "2026-10-31");

    // Every recorded period lands on an expected period of its own month
    for (const d of ["2026-11-02", "2026-11-14", "2026-11-16", "2026-11-30", "2026-12-05"]) {
      const b = getPeriodBounds("biweekly", d);
      assert.ok(getExpectedPeriodsForMonth("biweekly", b.month).some((p) => p.startDate === b.startDate), d);
      const w = getPeriodBounds("weekly", d);
      assert.ok(getExpectedPeriodsForMonth("weekly", w.month).some((p) => p.startDate === w.startDate), d);
    }

    const monthlyPeriods = getExpectedPeriodsForMonth("monthly", "2026-10");
    assert.equal(monthlyPeriods.length, 4); // one mark per week
    assert.equal(monthlyPeriods[0].startDate, "2026-10-05");
    assert.equal(monthlyPeriods[3].endDate, "2026-10-31");
    assert.ok(monthlyPeriods.every((p) => p.frequency === "monthly" && p.month === "2026-10"));
  });
});

describe("position and sub-criteria criteria matching", () => {
  test("empty positions applies to all positions", () => {
    const criterion = { positions: [] };
    assert.ok(appliesToPosition(criterion, "Developer"));
    assert.ok(appliesToPosition(criterion, "Team Lead"));
    assert.ok(appliesToPosition(criterion, ""));
  });

  test("matching is case-insensitive and trims whitespace", () => {
    const criterion = { positions: ["Team Lead", "Project Manager"] };
    assert.ok(appliesToPosition(criterion, "team lead"));
    assert.ok(appliesToPosition(criterion, "  Project Manager  "));
    assert.ok(!appliesToPosition(criterion, "Developer"));
  });

  test("appliesToDepartmentAndPosition matches both department and position", () => {
    const criterion = { departments: ["dept123"], positions: ["Developer"] };
    assert.ok(appliesToDepartmentAndPosition(criterion, "dept123", "developer"));
    assert.ok(!appliesToDepartmentAndPosition(criterion, "dept999", "developer"));
    assert.ok(!appliesToDepartmentAndPosition(criterion, "dept123", "Team Lead"));
  });

  test("role positions match the employee's base role or designation", () => {
    const criterion = { positions: ["qa", "sublead"] };
    assert.ok(appliesToPosition(criterion, ["qa", "Senior Tester"]));
    assert.ok(appliesToPosition(criterion, ["member", "sublead"])); // legacy designation match
    assert.ok(!appliesToPosition(criterion, ["member", "Developer"]));
    assert.ok(!appliesToPosition(criterion, [null, ""]));
  });

  test("appliesToEmployee combines department, team and position", () => {
    const memberOnly = { positions: ["member"] };
    assert.ok(appliesToEmployee(memberOnly, { role: "member" }));
    assert.ok(!appliesToEmployee(memberOnly, { role: "manager" }));

    const teamOnly = { departments: ["d1"], teams: ["t1"] };
    assert.ok(appliesToEmployee(teamOnly, { department: "d1", team: { _id: "t1" }, role: "qa" }));
    assert.ok(!appliesToEmployee(teamOnly, { department: "d1", team: "t2", role: "qa" }));
    assert.ok(!appliesToEmployee(teamOnly, { department: "d1", team: null, role: "qa" }));
  });

  test("criteriaForEmployee only returns the employee's own criteria", () => {
    const all = [
      { key: "common", weightage: 50 },
      { key: "member_only", weightage: 50, positions: ["member"] },
      { key: "manager_only", weightage: 50, positions: ["manager"] },
    ];
    assert.deepEqual(criteriaForEmployee(all, { role: "member" }).map((c) => c.key), ["common", "member_only"]);
    assert.deepEqual(criteriaForEmployee(all, { role: "manager" }).map((c) => c.key), ["common", "manager_only"]);
  });

  test("department weightage is checked per role when criteria target positions", () => {
    const all = [
      { key: "common", weightage: 50 },
      { key: "member_only", weightage: 50, positions: ["member"] },
      { key: "manager_only", weightage: 40, positions: ["manager"] },
    ];
    const departments = [{ _id: "d1", name: "Dev" }];
    const ok = validateDepartmentWeightage(all, departments, { profiles: { d1: [{ role: "member", team: null }] } });
    assert.ok(ok.valid);
    const bad = validateDepartmentWeightage(all, departments, {
      profiles: { d1: [{ role: "member", team: null }, { role: "manager", team: null }] },
    });
    assert.ok(!bad.valid);
    assert.match(bad.message, /manager/);
  });

  test("weightage validation isolates sub-criteria from top-level criteria", () => {
    const active = [
      { key: "crit1", weightage: 50, parentCriterion: null },
      { key: "crit2", weightage: 50, parentCriterion: null },
      { key: "sub1", weightage: 60, parentCriterion: "crit1" },
      { key: "sub2", weightage: 40, parentCriterion: "crit1" },
    ];
    // Top level sums to 100%
    const res = validateWeightage(active);
    assert.ok(res.valid);
    assert.equal(res.total, 100);

    // Sub criteria under crit1 sums to 100%
    const subRes = validateSubCriteriaWeightage([active[2], active[3]]);
    assert.ok(subRes.valid);
    assert.equal(subRes.total, 100);
  });
});
