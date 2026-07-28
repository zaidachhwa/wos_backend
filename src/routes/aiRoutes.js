import { Router } from "express";

import { requireAI, dailyPlanner, workloadAnalysis, projectHealth, chat } from "../controllers/aiController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateProjectHealth, validateChat } from "../validators/aiValidators.js";

const router = Router();
router.use(authenticate, requireAI);

router.post("/daily-planner", dailyPlanner);
router.post("/workload", authorize("admin", "manager", "subadmin"), workloadAnalysis);
router.post("/project-health", validateProjectHealth, projectHealth);
router.post("/chat", validateChat, chat);

export default router;
