import { Router } from "express";

import {
  getAppraisal,
  getMyAppraisal,
  getUserAppraisal,
  getAppraisalConfig,
  updateAppraisalConfig,
} from "../controllers/appraisalController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

// Own profile: any authenticated role.
router.get("/me", getMyAppraisal);
// Tenure-band thresholds — registered before "/:userId" so "config" is
// never captured as a userId param.
router.get("/config", authorize("admin", "hr"), getAppraisalConfig);
router.patch("/config", authorize("admin", "hr"), updateAppraisalConfig);
// Full roster, department-wise: admin and hr only — not even subadmin.
router.get("/", authorize("admin", "hr"), getAppraisal);
// Drill into one specific person's itemized detail — registered after
// "/me", "/config" and "/" so none of them are ever shadowed by this param route.
router.get("/:userId", authorize("admin", "hr"), getUserAppraisal);

export default router;
