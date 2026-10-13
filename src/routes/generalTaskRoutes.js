import { Router } from "express";

import {
  GENERAL_TASK_CREATORS,
  listGeneralTasks,
  createGeneralTask,
  updateGeneralTask,
  deleteGeneralTask,
  setGeneralTaskDone,
} from "../controllers/generalTaskController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

// Everyone: their own assigned general tasks; ?scope=created is creator-only
// (checked in the controller).
router.get("/", listGeneralTasks);
router.post("/", authorize(...GENERAL_TASK_CREATORS), createGeneralTask);
router.patch("/:id", authorize(...GENERAL_TASK_CREATORS), updateGeneralTask);
router.delete("/:id", authorize(...GENERAL_TASK_CREATORS), deleteGeneralTask);
// Assignee marks their own part done / not done.
router.post("/:id/done", setGeneralTaskDone);

export default router;
