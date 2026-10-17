import { Router } from "express";

import {
  listRoles,
  getRoleById,
  createRole,
  updateRole,
  deleteRole,
} from "../controllers/roleController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateRoleCreate, validateRoleUpdate } from "../validators/roleValidators.js";

const router = Router();

router.use(authenticate);

router.get("/", listRoles);
router.get("/:id", getRoleById);

// Creating, updating, deleting roles requires admin or hr privileges
router.post("/", authorize("admin", "hr"), validateRoleCreate, createRole);
router.patch("/:id", authorize("admin", "hr"), validateRoleUpdate, updateRole);
router.delete("/:id", authorize("admin", "hr"), deleteRole);

export default router;
