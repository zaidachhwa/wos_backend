import PerformanceEvaluation from "../../models/PerformanceEvaluation.js";
import AppraisalCriterion from "../../models/AppraisalCriterion.js";
import User from "../../models/User.js";
import { getSettings } from "./appraisalConfig.js";
import { canManage, canViewAll, managedIdSet } from "./appraisalAccess.js";
import { audit } from "./appraisalAudit.js";
import { getPeriodBounds, getExpectedPeriodsForMonth, getMonthBounds } from "./performancePeriod.js";
import { appliesToEmployee, effectiveWeightage } from "./appraisalEngine.js";
import { roundStore, roundDisplay } from "./appraisalMath.js";
import { istDayStr } from "../../utils/istTime.js";

// Service for recording and tracking multi-frequency performance evaluations (daily, weekly, biweekly, monthly)
// with Poor, Average, Good ratings and transparent monthly aggregation.

const checkEvaluatorAccess = async (actor, targetEmployeeId) => {
  if (canManage(actor)) return true; // admin, hr
  const managed = await managedIdSet(actor);
  return managed.has(String(targetEmployeeId));
};

export const recordEvaluation = async ({ employeeId, criterionId, date, rating, comment = "", user }) => {
  const targetUser = await User.findById(employeeId).select("_id name department team designation isActive role");
  if (!targetUser || !targetUser.isActive) {
    throw new Error("Employee not found or inactive");
  }

  if (!(await checkEvaluatorAccess(user, employeeId))) {
    throw new Error("You do not have permission to evaluate this employee");
  }

  const criterion = await AppraisalCriterion.findById(criterionId);
  if (!criterion || !criterion.isActive) {
    throw new Error("Criterion not found or inactive");
  }

  // Validate department, team & position assignment
  if (!appliesToEmployee(criterion, targetUser)) {
    throw new Error(`This criterion does not apply to the employee's department, team or position (${targetUser.role})`);
  }

  const validRatings = ["poor", "average", "good"];
  if (!validRatings.includes(String(rating).toLowerCase())) {
    throw new Error(`Rating must be one of: ${validRatings.join(", ")}`);
  }
  const cleanRating = String(rating).toLowerCase();

  const dayStr = date || istDayStr();
  const period = getPeriodBounds(criterion.frequency || "monthly", dayStr);

  const settings = await getSettings();
  const scoringScale = settings.scoringScale || { poor: 25, average: 50, good: 100 };
  const numericScore = scoringScale[cleanRating] ?? 50;

  let evaluation = await PerformanceEvaluation.findOne({
    employee: employeeId,
    criterion: criterionId,
    "period.startDate": period.startDate,
    "period.endDate": period.endDate,
  });

  const isUpdate = Boolean(evaluation);

  if (isUpdate) {
    const before = { rating: evaluation.rating, numericScore: evaluation.numericScore, comment: evaluation.comment };
    evaluation.rating = cleanRating;
    evaluation.numericScore = numericScore;
    evaluation.comment = String(comment).slice(0, 2000);
    evaluation.evaluator = user._id;
    evaluation.updatedBy = user._id;
    evaluation.recordedAt = new Date();
    await evaluation.save();

    await audit({
      actor: user,
      action: "performance_evaluation_updated",
      entityType: "criterion",
      entityId: criterion._id,
      subject: employeeId,
      month: period.month,
      before,
      after: { rating: cleanRating, numericScore, comment: evaluation.comment },
    });
  } else {
    evaluation = await PerformanceEvaluation.create({
      employee: employeeId,
      criterion: criterionId,
      evaluator: user._id,
      period,
      rating: cleanRating,
      numericScore,
      comment: String(comment).slice(0, 2000),
      recordedAt: new Date(),
      createdBy: user._id,
    });

    await audit({
      actor: user,
      action: "performance_evaluation_recorded",
      entityType: "criterion",
      entityId: criterion._id,
      subject: employeeId,
      month: period.month,
      after: { rating: cleanRating, numericScore, period: evaluation.period },
    });
  }

  return PerformanceEvaluation.findById(evaluation._id)
    .populate("employee", "name designation department")
    .populate("criterion", "name weightage frequency parentCriterion")
    .populate("evaluator", "name role");
};

export const listEvaluations = async ({
  employee,
  criterion,
  department,
  position,
  month,
  frequency,
  startDate,
  endDate,
  user,
}) => {
  const filter = {};

  if (employee) filter.employee = employee;
  if (criterion) filter.criterion = criterion;
  if (month) filter["period.month"] = month;
  if (frequency) filter["period.frequency"] = frequency;

  if (startDate || endDate) {
    if (startDate && endDate) {
      filter["period.startDate"] = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      filter["period.startDate"] = { $gte: startDate };
    } else {
      filter["period.endDate"] = { $lte: endDate };
    }
  }

  // Role permissions
  if (!canViewAll(user)) {
    if (user.role === "member") {
      // Employees can only view their own evaluations
      filter.employee = user._id;
    } else {
      // Leads/managers can view managed users or themselves
      const managed = [...(await managedIdSet(user))];
      filter.employee = { $in: [...managed, user._id] };
      if (employee && !managed.includes(String(employee)) && String(employee) !== String(user._id)) {
        return [];
      }
    }
  }

  // Department or position filtering
  if (department || position) {
    const userQuery = { isActive: true };
    if (department) userQuery.department = department;
    if (position) {
      const pos = position.trim();
      const re = new RegExp(`^${pos.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      userQuery.$or = [{ role: pos.toLowerCase() }, { designation: re }];
    }
    const matchingUserIds = await User.find(userQuery).distinct("_id");
    filter.employee = filter.employee ? { $in: matchingUserIds.filter((id) => String(id) === String(filter.employee)) } : { $in: matchingUserIds };
  }

  return PerformanceEvaluation.find(filter)
    .populate("employee", "name designation department")
    .populate("criterion", "name weightage frequency parentCriterion positions")
    .populate("evaluator", "name role")
    .sort({ "period.startDate": -1, createdAt: -1 })
    .lean();
};

export const calculateMonthlyPerformance = async ({ employeeId, month }) => {
  const monthStr = month || istDayStr().slice(0, 7);

  const employee = await User.findById(employeeId)
    .select("_id name designation department team role isActive")
    .populate("department", "name")
    .populate("team", "name")
    .lean();

  if (!employee) throw new Error("Employee not found");

  const settings = await getSettings();
  const scoringScale = settings.scoringScale || { poor: 25, average: 50, good: 100 };

  // Fetch all active criteria
  const allActiveCriteria = await AppraisalCriterion.find({ isActive: true })
    .sort({ sortOrder: 1, createdAt: 1 })
    .lean();

  // Filter criteria applicable to employee's department, team and position
  const applicableCriteria = allActiveCriteria
    .filter((c) => appliesToEmployee(c, employee))
    .map((c) => ({ ...c, effectiveWeight: effectiveWeightage(c, employee.department?._id) }));

  // Separate top-level criteria and sub-criteria
  const topLevelCriteria = applicableCriteria.filter((c) => !c.parentCriterion);
  const subCriteriaByParent = new Map();
  for (const c of applicableCriteria) {
    if (c.parentCriterion) {
      const pid = String(c.parentCriterion);
      if (!subCriteriaByParent.has(pid)) subCriteriaByParent.set(pid, []);
      subCriteriaByParent.get(pid).push(c);
    }
  }

  // Fetch all evaluation entries recorded for this employee in this month
  const evaluations = await PerformanceEvaluation.find({
    employee: employeeId,
    "period.month": monthStr,
  })
    .populate("criterion", "name weightage frequency parentCriterion")
    .populate("evaluator", "name role")
    .lean();

  const evalsByCriterion = new Map();
  for (const ev of evaluations) {
    const cid = String(ev.criterion?._id || ev.criterion);
    if (!evalsByCriterion.has(cid)) evalsByCriterion.set(cid, []);
    evalsByCriterion.get(cid).push(ev);
  }

  const missingEvaluations = [];
  let totalScore = 0;
  let totalWeightage = 0;

  const scoreIndividualCriterion = (crit) => {
    const freq = crit.frequency || "monthly";
    const expected = getExpectedPeriodsForMonth(freq, monthStr);
    const recorded = evalsByCriterion.get(String(crit._id)) || [];

    const recordedStartDates = new Set(recorded.map((r) => r.period.startDate));
    const incomplete = expected.filter((p) => !recordedStartDates.has(p.startDate));
    // One slot per expected period (e.g. each week of a monthly criterion),
    // carrying the mark recorded for it, or null when not yet marked.
    const periods = expected.map((p) => ({ ...p, evaluation: recorded.find((r) => r.period.startDate === p.startDate) || null }));

    if (incomplete.length > 0) {
      missingEvaluations.push({
        criterionId: crit._id,
        criterionName: crit.name,
        frequency: freq,
        missingPeriods: incomplete.map((p) => ({ startDate: p.startDate, endDate: p.endDate, label: p.label })),
      });
    }

    // The month's score is the average of the marked slots (e.g. the weekly
    // marks of a monthly criterion). Records that match no slot — saved under
    // older period rules — are only used when no slot is marked at all.
    const slotMarks = periods.filter((p) => p.evaluation).map((p) => p.evaluation);
    const scored = slotMarks.length ? slotMarks : recorded;
    const ratingsCount = { poor: 0, average: 0, good: 0 };
    let sumScore = 0;
    for (const r of scored) {
      ratingsCount[r.rating] = (ratingsCount[r.rating] || 0) + 1;
      sumScore += (r.numericScore ?? scoringScale[r.rating] ?? 50);
    }

    const avgNumericScore = scored.length ? roundStore(sumScore / scored.length) : null;
    const averageCalc = scored.length
      ? `Average of ${scored.length} mark(s): (${scored.map((r) => roundDisplay(r.numericScore ?? scoringScale[r.rating] ?? 50)).join(" + ")}) / ${scored.length} = ${roundDisplay(avgNumericScore)}%`
      : "No marks recorded yet";
    const isComplete = incomplete.length === 0 && recorded.length > 0;

    return {
      _id: crit._id,
      name: crit.name,
      description: crit.description || "",
      frequency: freq,
      weightage: crit.effectiveWeight ?? crit.weightage,
      expectedCount: expected.length,
      recordedCount: recorded.length,
      incompleteCount: incomplete.length,
      incompletePeriods: incomplete,
      periods,
      isComplete,
      ratingsCount,
      evaluations: recorded,
      avgNumericScore,
      averageCalc,
    };
  };

  const breakdown = topLevelCriteria.map((main) => {
    const subs = subCriteriaByParent.get(String(main._id)) || [];
    const hasSubs = subs.length > 0;
    const weight = Number(main.effectiveWeight ?? main.weightage);
    totalWeightage += weight;

    if (hasSubs && main.scoreFromSubCriteria !== false) {
      const subBreakdowns = subs.map(scoreIndividualCriterion);
      const allSubsComplete = subBreakdowns.every((s) => s.isComplete);

      // Weighted score from sub-criteria (normalized by sub-criteria weights)
      let weightedSubSum = 0;
      let totalSubWeight = 0;
      for (const s of subBreakdowns) {
        totalSubWeight += Number(s.weightage);
        if (s.avgNumericScore !== null) {
          weightedSubSum += (s.avgNumericScore * Number(s.weightage));
        }
      }

      const mainAvgScore = totalSubWeight > 0 ? roundStore(weightedSubSum / totalSubWeight) : null;
      const criterionScore = mainAvgScore !== null ? roundStore((mainAvgScore * weight) / 100) : 0;
      totalScore += criterionScore;

      return {
        _id: main._id,
        name: main.name,
        description: main.description || "",
        frequency: main.frequency || "monthly",
        weightage: weight,
        scoreFromSubCriteria: true,
        hasSubCriteria: true,
        subCriteria: subBreakdowns,
        avgNumericScore: mainAvgScore,
        score: criterionScore,
        maxScore: weight,
        isComplete: allSubsComplete,
        calculation: `${mainAvgScore !== null ? roundDisplay(mainAvgScore) : "0"}% × ${weight}% weight = ${roundDisplay(criterionScore)} / ${weight}`,
      };
    }

    const scored = scoreIndividualCriterion(main);
    const criterionScore = scored.avgNumericScore !== null ? roundStore((scored.avgNumericScore * weight) / 100) : 0;
    totalScore += criterionScore;

    return {
      ...scored,
      hasSubCriteria: false,
      subCriteria: [],
      score: criterionScore,
      maxScore: weight,
      calculation: `${scored.avgNumericScore !== null ? roundDisplay(scored.avgNumericScore) : "0"}% × ${weight}% weight = ${roundDisplay(criterionScore)} / ${weight}`,
    };
  });

  const finalTotalScore = roundStore(Math.min(100, Math.max(0, totalScore)));
  const isFullyComplete = missingEvaluations.length === 0 && breakdown.every((b) => b.isComplete);

  return {
    employee: {
      _id: employee._id,
      name: employee.name,
      designation: employee.designation,
      role: employee.role,
      department: employee.department ? { _id: employee.department._id, name: employee.department.name } : null,
      team: employee.team ? { _id: employee.team._id, name: employee.team.name } : null,
    },
    month: monthStr,
    monthBounds: getMonthBounds(monthStr),
    scoringScale,
    totalWeightage: roundStore(totalWeightage),
    totalScore: finalTotalScore,
    isComplete: isFullyComplete,
    missingEvaluations,
    criteriaBreakdown: breakdown,
  };
};

export const deleteEvaluation = async (evaluationId, actor) => {
  const evaluation = await PerformanceEvaluation.findById(evaluationId);
  if (!evaluation) throw new Error("Evaluation not found");

  if (!canManage(actor) && String(evaluation.evaluator) !== String(actor._id)) {
    throw new Error("Only HR or the evaluator can remove this evaluation");
  }

  await PerformanceEvaluation.findByIdAndDelete(evaluationId);

  await audit({
    actor,
    action: "performance_evaluation_deleted",
    entityType: "criterion",
    entityId: evaluation.criterion,
    subject: evaluation.employee,
    month: evaluation.period?.month,
    before: { rating: evaluation.rating, period: evaluation.period },
  });

  return true;
};
