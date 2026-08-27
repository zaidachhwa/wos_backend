import { Router } from "express";

import {
  createAttendance,
  listAttendance,
  deleteAttendance,
  attendanceReport,
  getAttendanceConfig,
  updateAttendanceConfig,
  listUserDeadlines,
  setUserMorningDeadline,
  runAttendanceSweepNow,
} from "../controllers/attendanceController.js";
import { authenticate, authorize } from "../middleware/auth.js";

const router = Router();
router.use(authenticate);

// Deadline is readable by everyone (so employees know their submit-by
// time), even though only hr/admin can change it below.
router.get("/config", getAttendanceConfig);

router.use(authorize("hr", "admin"));
router.post("/", createAttendance);
router.get("/", listAttendance);
router.get("/report", attendanceReport);
router.delete("/:id", deleteAttendance);
router.patch("/config", updateAttendanceConfig);
router.get("/deadlines", listUserDeadlines);
router.patch("/deadline/:userId", setUserMorningDeadline);
// Narrower than the rest of this router — mirrors runOverdueSweep/
// runEveningReminderSweep, both admin-only manual triggers.
router.post("/run-sweep", authorize("admin"), runAttendanceSweepNow);

export default router;
