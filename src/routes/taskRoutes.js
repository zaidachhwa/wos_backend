import { Router } from "express";

import {
  createTask,
  listTasks,
  getTask,
  updateTask,
  addComment,
  updateComment,
  deleteComment,
  bulkUpdateTasks,
  deleteTask,
  approveTask,
  rejectTask,
} from "../controllers/taskController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateTaskCreate, validateComment } from "../validators/taskValidators.js";

const router = Router();
router.use(authenticate);

router.get("/", listTasks);
router.post("/", authorize("admin", "manager", "subadmin", "sublead", "member", "director"), validateTaskCreate, createTask);
// Must come before "/:id" — otherwise Express matches "bulk" as the :id param.
router.patch("/bulk", authorize("admin", "manager", "subadmin", "sublead"), bulkUpdateTasks);
router.get("/:id", getTask);
// role check is "assignee: status/actualHours/subtasks only, sublead+: everything"
// — needs the loaded task/project, so it's enforced inside the controller.
router.patch("/:id", updateTask);
router.post("/:id/comments", validateComment, addComment);
router.patch("/:id/comments/:commentId", validateComment, updateComment);
router.delete("/:id/comments/:commentId", deleteComment);
router.delete("/:id", authorize("admin"), deleteTask);
// approve/reject need the loaded task's creator (for the reportingManager
// check), so — same reasoning as updateTask above — enforced in the controller.
router.patch("/:id/approve", approveTask);
router.patch("/:id/reject", rejectTask);

export default router;
