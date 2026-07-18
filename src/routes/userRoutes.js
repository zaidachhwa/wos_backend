import { Router } from "express";

import {
  createUser,
  listUsers,
  updateUser,
  deleteUser,
  listDirectory,
} from "../controllers/userController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateCreateUser } from "../validators/userValidators.js";

const router = Router();

router.use(authenticate);
router.get("/directory", listDirectory);
router.post("/", authorize("admin"), validateCreateUser, createUser);
router.get("/", authorize("admin"), listUsers);
router.patch("/:id", authorize("admin"), updateUser);
router.delete("/:id", authorize("admin"), deleteUser);

export default router;
