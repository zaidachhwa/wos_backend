import { Router } from "express";

import {
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  listDirectory,
  getUserById,
} from "../controllers/userController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateCreateUser } from "../validators/userValidators.js";

const router = Router();

router.use(authenticate);
router.get("/directory", listDirectory);
router.post("/", authorize("admin", "subadmin", "manager", "sublead"), validateCreateUser, createUser);
router.get("/", authorize("admin", "subadmin", "manager", "sublead"), listUsers);
router.get("/:id", getUserById);
router.patch("/:id", authorize("admin", "subadmin", "manager", "sublead"), updateUser);
router.delete("/:id", authorize("admin", "subadmin", "manager", "sublead"), deleteUser);

export default router;
