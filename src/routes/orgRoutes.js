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
// HR can add/rename departments and teams; deleting stays admin(/subadmin
// for teams) since it can orphan people and teams.
departmentRouter.post("/", authorize("admin", "hr"), validateDepartmentName, createDepartment);
departmentRouter.patch("/:id", authorize("admin", "hr"), updateDepartment);
departmentRouter.delete("/:id", authorize("admin"), deleteDepartment);

export const teamRouter = Router();
teamRouter.use(authenticate);
teamRouter.get("/", listTeams);
teamRouter.post("/", authorize("admin", "subadmin", "hr"), validateTeamCreate, createTeam);
teamRouter.patch("/:id", authorize("admin", "subadmin", "hr"), updateTeam);
teamRouter.patch("/:id/thresholds", authorize("admin", "manager"), updateTeamThresholds);
teamRouter.delete("/:id", authorize("admin", "subadmin"), deleteTeam);
