import {
  recordEvaluation,
  listEvaluations,
  calculateMonthlyPerformance,
  deleteEvaluation,
} from "../services/appraisal/performanceEvalService.js";
import { canManage, canViewAll, managedIdSet } from "../services/appraisal/appraisalAccess.js";
import User from "../models/User.js";

const fail = (res, status, message) => res.status(status).json({ success: false, message });
const serverError = (res, error) => {
  console.error(error);
  return fail(res, 500, error.message || "Something went wrong");
};

export const recordPerformanceEvaluation = async (req, res) => {
  try {
    const { employeeId, criterionId, date, rating, comment } = req.body || {};
    if (!employeeId || !criterionId || !rating) {
      return fail(res, 400, "employeeId, criterionId, and rating are required");
    }

    const evaluation = await recordEvaluation({
      employeeId,
      criterionId,
      date,
      rating,
      comment,
      user: req.user,
    });

    return res.status(201).json({
      success: true,
      message: "Evaluation recorded successfully",
      data: { evaluation },
    });
  } catch (error) {
    if (error.message.includes("permission") || error.message.includes("does not apply")) {
      return fail(res, 403, error.message);
    }
    if (error.message.includes("not found") || error.message.includes("must be one of")) {
      return fail(res, 400, error.message);
    }
    return serverError(res, error);
  }
};

export const getPerformanceEvaluations = async (req, res) => {
  try {
    const { employee, criterion, department, position, month, frequency, startDate, endDate } = req.query;

    const evaluations = await listEvaluations({
      employee,
      criterion,
      department,
      position,
      month,
      frequency,
      startDate,
      endDate,
      user: req.user,
    });

    return res.json({
      success: true,
      message: "Evaluations fetched",
      data: { evaluations },
    });
  } catch (error) {
    return serverError(res, error);
  }
};

export const getMonthlyPerformanceBreakdown = async (req, res) => {
  try {
    const { employeeId } = req.params;
    const { month } = req.query;

    if (!employeeId) return fail(res, 400, "employeeId is required");

    // Check view permissions
    if (!canViewAll(req.user)) {
      if (req.user.role === "member") {
        if (String(req.user._id) !== String(employeeId)) {
          return fail(res, 403, "You can only view your own performance breakdown");
        }
      } else {
        const managed = await managedIdSet(req.user);
        if (!managed.has(String(employeeId)) && String(req.user._id) !== String(employeeId)) {
          return fail(res, 403, "You don't have access to this employee's breakdown");
        }
      }
    }

    const breakdown = await calculateMonthlyPerformance({ employeeId, month });

    return res.json({
      success: true,
      message: "Monthly performance calculated",
      data: breakdown,
    });
  } catch (error) {
    return serverError(res, error);
  }
};

export const deletePerformanceEvaluation = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id) return fail(res, 400, "Evaluation ID is required");

    await deleteEvaluation(id, req.user);

    return res.json({
      success: true,
      message: "Evaluation deleted",
    });
  } catch (error) {
    if (error.message.includes("not found")) return fail(res, 404, error.message);
    if (error.message.includes("Only HR")) return fail(res, 403, error.message);
    return serverError(res, error);
  }
};

// Returns employees reportable/evaluatable by the current user
export const getEvaluatableEmployees = async (req, res) => {
  try {
    const filter = { isActive: true };
    if (!canManage(req.user)) {
      const managed = [...(await managedIdSet(req.user))];
      filter._id = { $in: managed };
    }
    const employees = await User.find(filter)
      .select("name designation department team role")
      .populate("department", "name")
      .populate("team", "name")
      .sort("name")
      .lean();

    return res.json({
      success: true,
      message: "Evaluatable employees fetched",
      data: { employees },
    });
  } catch (error) {
    return serverError(res, error);
  }
};
