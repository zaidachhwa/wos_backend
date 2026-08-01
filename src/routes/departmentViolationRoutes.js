import { Router } from "express";

import { listDepartmentViolations } from "../controllers/departmentViolationController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);
router.get("/", authorize("admin"), listDepartmentViolations);

export default router;
