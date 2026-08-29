import { Router } from "express";

import { getAppraisal, runMemoSweep } from "../controllers/appraisalController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", getAppraisal);
router.post("/run-memo-sweep", authorize("admin"), runMemoSweep);

export default router;
