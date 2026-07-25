import { Router } from "express";

import { getLeaderboard, getPointsConfig, updatePointsConfig } from "../controllers/leaderboardController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", getLeaderboard);
router.get("/points-config", getPointsConfig);
router.put("/points-config", authorize("admin"), updatePointsConfig);

export default router;
