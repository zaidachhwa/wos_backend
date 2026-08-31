import { Router } from "express";

import {
  getAppraisal,
  getMyAppraisal,
  getUserAppraisal,
  getAppraisalConfig,
  updateAppraisalConfig,
  runMemoSweep,
} from "../controllers/appraisalController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

// Own profile: any authenticated role.
router.get("/me", getMyAppraisal);
// Tenure-band thresholds — registered before "/:userId" so "config" is
// never captured as a userId param.
router.get("/config", authorize("admin", "hr", "director"), getAppraisalConfig);
router.patch("/config", authorize("admin", "hr"), updateAppraisalConfig);
// Manual "run it now" escape hatch for the monthly memo sweep — mirrors
// runOverdueSweep/runAttendanceSweepNow. Registered before "/:userId" for
// the same shadowing reason as "config" above.
router.post("/run-memo-sweep", authorize("admin", "hr"), runMemoSweep);
// Full roster, department-wise: admin and hr only — not even subadmin.
router.get("/", authorize("admin", "hr", "director"), getAppraisal);
// Drill into one specific person's itemized detail — registered after
// "/me", "/config", "/run-memo-sweep" and "/" so none of them are ever
// shadowed by this param route.
router.get("/:userId", authorize("admin", "hr", "director"), getUserAppraisal);

export default router;
