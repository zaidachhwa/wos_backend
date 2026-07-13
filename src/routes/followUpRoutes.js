import { Router } from "express";

import { upsertFollowUp, listFollowUps, reviewFollowUp } from "../controllers/followUpController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateFollowUpUpsert } from "../validators/followUpValidators.js";

const router = Router();
router.use(authenticate);

router.post("/", validateFollowUpUpsert, upsertFollowUp);
router.get("/", listFollowUps);
router.patch("/:id/review", authorize("admin", "manager"), reviewFollowUp);

export default router;
