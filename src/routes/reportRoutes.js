import { Router } from "express";

import { teamReport, workLog } from "../controllers/reportController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/team", authorize("admin", "manager"), teamReport);
router.get("/work-log", workLog);

export default router;
