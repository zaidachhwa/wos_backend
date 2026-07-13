import { Router } from "express";

import { listActivity } from "../controllers/activityController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

router.get("/", listActivity);

export default router;
