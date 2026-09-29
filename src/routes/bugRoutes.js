import { Router } from "express";

import { listBugs, reportableEmployees, getBug, createBug, updateBug, addBugComment } from "../controllers/bugController.js";
import { authenticate, authorize } from "../middleware/auth.js";
import { APPRAISAL_VIEW_ALL_ROLES, BUG_REPORTER_ROLES } from "../constants/appraisal.constants.js";

const router = Router();
router.use(authenticate);

// Members never see this router; finer per-record scope (a lead only sees
// bugs for people they manage or that they reported) is in the controller.
router.use(authorize(...new Set([...BUG_REPORTER_ROLES, ...APPRAISAL_VIEW_ALL_ROLES])));

router.get("/", listBugs);
router.get("/reportable-employees", authorize(...BUG_REPORTER_ROLES), reportableEmployees);
router.post("/", authorize(...BUG_REPORTER_ROLES), createBug);
router.get("/:id", getBug);
router.patch("/:id", authorize(...BUG_REPORTER_ROLES), updateBug);
router.post("/:id/comments", addBugComment);

export default router;
