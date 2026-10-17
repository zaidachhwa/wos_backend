import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  getPeriodBounds,
  getExpectedPeriodsForMonth,
  daysInMonth,
} from "../../src/services/appraisal/performancePeriod.js";
import {
  appliesToPosition,
  appliesToDepartmentAndPosition,
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

  test("weekly period bounds start on Monday and end on Sunday", () => {
    // 2026-10-17 is Saturday
    const p = getPeriodBounds("weekly", "2026-10-17");
    assert.equal(p.frequency, "weekly");
    assert.equal(p.startDate, "2026-10-12"); // Monday
    assert.equal(p.endDate, "2026-10-18"); // Sunday
  });

  test("biweekly period bounds split month at day 14/15", () => {
    const p1 = getPeriodBounds("biweekly", "2026-10-10");
    assert.equal(p1.startDate, "2026-10-01");
    assert.equal(p1.endDate, "2026-10-14");

    const p2 = getPeriodBounds("biweekly", "2026-10-20");
    assert.equal(p2.startDate, "2026-10-15");
    assert.equal(p2.endDate, "2026-10-31");
  });

  test("monthly period bounds span the whole calendar month", () => {
    const p = getPeriodBounds("monthly", "2026-09-15");
    assert.equal(p.startDate, "2026-09-01");
    assert.equal(p.endDate, "2026-09-30");
  });

  test("expected periods for month", () => {
    const dailyPeriods = getExpectedPeriodsForMonth("daily", "2026-10");
    assert.equal(dailyPeriods.length, 31);

    const biweeklyPeriods = getExpectedPeriodsForMonth("biweekly", "2026-10");
    assert.equal(biweeklyPeriods.length, 2);
    assert.equal(biweeklyPeriods[0].startDate, "2026-10-01");
    assert.equal(biweeklyPeriods[1].endDate, "2026-10-31");

    const monthlyPeriods = getExpectedPeriodsForMonth("monthly", "2026-10");
    assert.equal(monthlyPeriods.length, 1);
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
