import { Router } from "express";

import {
  getConfig,
  createCriterion,
  updateCriterion,
  updateAllocation,
  reorderCriteria,
  deleteCriterion,
  updateSettings,
} from "../controllers/appraisalSettingsController.js";
import {
  listAppraisals,
  bulkUpdateInputs,
  getAppraisal,
  openEmployeeMonth,
  recalculateAppraisal,
  updateAppraisalHrInputs,
  updateEvaluation,
  submit,
  finalize,
  reopen,
  finalizeMonth,
  appraisalAudit,
  employeeHistory,
  myAppraisals,
  teamAppraisals,
  report,
  listEmailLogs,
  retryEmailLog,
  listPeriods,
  closePeriod,
  listClientChanges,
  categorizeClientChange,
  listAudit,
} from "../controllers/appraisalsController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { APPRAISAL_MANAGE_ROLES, APPRAISAL_VIEW_ALL_ROLES, TEAM_LEAD_ROLES } from "../constants/appraisal.constants.js";

// The configurable monthly appraisal module. The legacy score view stays at
// /api/appraisal (appraisalRoutes.js); the old memo system has been removed.
const router = Router();
router.use(authenticate);

const manage = authorize(...APPRAISAL_MANAGE_ROLES);
const viewAll = authorize(...APPRAISAL_VIEW_ALL_ROLES);

// Anyone: own finalized appraisals. Per-record access (self / managed / HR)
// is checked inside the controllers.
router.get("/my", myAppraisals);
router.get("/team", authorize(...TEAM_LEAD_ROLES), teamAppraisals);
router.get("/employee/:userId/history", employeeHistory);

// Configuration
router.get("/config", viewAll, getConfig);
router.post("/criteria", manage, createCriterion);
router.put("/criteria/allocation", manage, updateAllocation);
router.patch("/criteria/reorder", manage, reorderCriteria);
router.patch("/criteria/:id", manage, updateCriterion);
router.delete("/criteria/:id", manage, deleteCriterion);
router.patch("/settings", manage, updateSettings);

// Month roster, inputs, reports
router.get("/", viewAll, listAppraisals);
router.patch("/inputs", manage, bulkUpdateInputs);
router.post("/finalize-month", manage, finalizeMonth);
router.get("/reports", viewAll, report);
router.get("/emails", manage, listEmailLogs);
router.post("/emails/:id/retry", manage, retryEmailLog);
router.get("/periods", manage, listPeriods);
router.post("/periods/:month/close", manage, closePeriod);
router.get("/client-changes", manage, listClientChanges);
router.patch("/client-changes/:taskId", manage, categorizeClientChange);
router.get("/audit", manage, listAudit);
router.get("/employee/:userId/month/:month", manage, openEmployeeMonth);

// One appraisal — registered last so "/:id" never shadows the paths above.
router.get("/:id", getAppraisal);
router.get("/:id/audit", manage, appraisalAudit);
router.post("/:id/recalculate", manage, recalculateAppraisal);
router.patch("/:id/hr-inputs", manage, updateAppraisalHrInputs);
router.patch("/:id/evaluations/:criterionKey", manage, updateEvaluation);
router.post("/:id/submit", manage, submit);
router.post("/:id/finalize", manage, finalize);
router.post("/:id/reopen", manage, reopen);

export default router;
