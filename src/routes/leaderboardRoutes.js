import { Router } from "express";

import { getLeaderboard } from "../controllers/leaderboardController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", getLeaderboard);

export default router;
