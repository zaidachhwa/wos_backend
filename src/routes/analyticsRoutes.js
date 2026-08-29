import express from "express";
import { getDashboardSummary, getProjectAnalytics, getUserAnalytics, getProjectDetails, getUserDetails } from "../controllers/analyticsController.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";

const router = express.Router();

router.use(requireAuth);
// Only admin, manager, subadmin, and hr should access analytics
router.use(requireRoles(["admin", "manager", "subadmin", "hr"]));

router.get("/dashboard", getDashboardSummary);
router.get("/projects", getProjectAnalytics);
router.get("/users", getUserAnalytics);
router.get("/projects/:id", getProjectDetails);
router.get("/users/:id", getUserDetails);

export default router;
