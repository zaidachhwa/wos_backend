import { Router } from "express";

import { teamReport } from "../controllers/reportController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate, authorize("admin", "manager"));

router.get("/team", teamReport);

export default router;
