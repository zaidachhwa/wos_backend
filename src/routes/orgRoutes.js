import { Router } from "express";

import {
  createDepartment,
  listDepartments,
  updateDepartment,
  deleteDepartment,
  createTeam,
  listTeams,
  updateTeam,
  updateTeamThresholds,
  deleteTeam,
} from "../controllers/orgController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { validateDepartmentName, validateTeamCreate } from "../validators/orgValidators.js";

export const departmentRouter = Router();
departmentRouter.use(authenticate);
departmentRouter.get("/", listDepartments);
departmentRouter.post("/", authorize("admin"), validateDepartmentName, createDepartment);
departmentRouter.patch("/:id", authorize("admin"), updateDepartment);
departmentRouter.delete("/:id", authorize("admin"), deleteDepartment);

export const teamRouter = Router();
teamRouter.use(authenticate);
teamRouter.get("/", listTeams);
teamRouter.post("/", authorize("admin", "subadmin"), validateTeamCreate, createTeam);
teamRouter.patch("/:id", authorize("admin", "subadmin"), updateTeam);
teamRouter.patch("/:id/thresholds", authorize("admin", "manager"), updateTeamThresholds);
teamRouter.delete("/:id", authorize("admin", "subadmin"), deleteTeam);
