import { Router } from "express";

import {
  upsertFollowUp,
  listFollowUps,
  reviewFollowUp,
  getFollowUpSuggestion,
  workLog,
} from "../controllers/followUpController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateFollowUpUpsert } from "../validators/followUpValidators.js";

const router = Router();
router.use(authenticate);

router.post("/", validateFollowUpUpsert, upsertFollowUp);
router.get("/", listFollowUps);
router.get("/suggestions", getFollowUpSuggestion);
router.get("/work-log", workLog);
router.patch("/:id/review", authorize("admin", "manager", "subadmin", "sublead"), reviewFollowUp);

export default router;
