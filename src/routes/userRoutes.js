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
router.post("/", authorize("admin", "subadmin"), validateCreateUser, createUser);
router.get("/", authorize("admin", "subadmin"), listUsers);
router.get("/:id", getUserById);
router.patch("/:id", authorize("admin", "subadmin"), updateUser);
router.delete("/:id", authorize("admin", "subadmin"), deleteUser);

export default router;
