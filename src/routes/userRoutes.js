import { Router } from "express";

import {
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  listDirectory,
  getUserById,
  listUserMemos,
  resetUserMemos,
} from "../controllers/userController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateCreateUser } from "../validators/userValidators.js";

const router = Router();

router.use(authenticate);
router.get("/directory", listDirectory);
router.post("/", authorize("admin", "subadmin", "manager", "sublead", "hr"), validateCreateUser, createUser);
router.get("/", authorize("admin", "subadmin", "manager", "sublead", "hr", "director"), listUsers);
router.get("/:id", getUserById);
router.patch("/:id", authorize("admin", "subadmin", "manager", "sublead", "hr"), updateUser);
router.delete("/:id", authorize("admin", "subadmin", "manager", "sublead"), deleteUser);
router.get("/:id/memos", authorize("admin", "subadmin", "manager", "sublead"), listUserMemos);
router.post("/:id/memos/reset", authorize("admin"), resetUserMemos);

export default router;
