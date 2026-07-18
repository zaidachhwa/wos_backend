import { Router } from "express";

import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
} from "../controllers/projectController.js";
import {
  createModule,
  listModules,
  updateModule,
  deleteModule,
} from "../controllers/moduleController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateProjectCreate, validateModuleCreate } from "../validators/projectValidators.js";

const router = Router();
router.use(authenticate);

router.get("/", listProjects);
router.post("/", authorize("admin", "manager"), validateProjectCreate, createProject);
router.get("/:id", getProject);
// role check is "admin|manager OR the project's manager" — needs the loaded
// project, so it's enforced inside the controller rather than here.
router.patch("/:id", updateProject);
router.delete("/:id", authorize("admin"), deleteProject);

router.get("/:projectId/modules", listModules);
router.post(
  "/:projectId/modules",
  authorize("admin", "manager", "sublead"),
  validateModuleCreate,
  createModule
);
router.patch("/:projectId/modules/:id", authorize("admin", "manager", "sublead"), updateModule);
router.delete("/:projectId/modules/:id", authorize("admin"), deleteModule);

export default router;
