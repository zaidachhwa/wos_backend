import { Router } from "express";

import { teamReport } from "../controllers/reportController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/team", authorize("admin", "manager", "subadmin", "hr"), teamReport);

export default router;
