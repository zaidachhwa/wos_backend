import { Router } from "express";

import { createTask, listTasks, getTask, updateTask, addComment } from "../controllers/taskController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateTaskCreate, validateComment } from "../validators/taskValidators.js";

const router = Router();
router.use(authenticate);

router.get("/", listTasks);
router.post("/", authorize("admin", "manager", "sublead"), validateTaskCreate, createTask);
router.get("/:id", getTask);
// role check is "assignee: status/actualHours/subtasks only, sublead+: everything"
// — needs the loaded task/project, so it's enforced inside the controller.
router.patch("/:id", updateTask);
router.post("/:id/comments", validateComment, addComment);

export default router;
