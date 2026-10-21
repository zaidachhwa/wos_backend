import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { errorHandler } from "./middleware/errorHandler.js";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import { departmentRouter, teamRouter } from "./routes/orgRoutes.js";
import projectRoutes from "./routes/projectRoutes.js";
import taskRoutes from "./routes/taskRoutes.js";
import followUpRoutes from "./routes/followUpRoutes.js";
import timeblockRoutes from "./routes/timeblockRoutes.js";
import calendarRoutes from "./routes/calendarRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import activityRoutes from "./routes/activityRoutes.js";
import dashboardRoutes from "./routes/dashboardRoutes.js";
import profileRoutes from "./routes/profileRoutes.js";
import aiRoutes from "./routes/aiRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import searchRoutes from "./routes/searchRoutes.js";
import leaderboardRoutes from "./routes/leaderboardRoutes.js";
import departmentViolationRoutes from "./routes/departmentViolationRoutes.js";
import appraisalRoutes from "./routes/appraisalRoutes.js";
import attendanceRoutes from "./routes/attendanceRoutes.js";
import analyticsRoutes from "./routes/analyticsRoutes.js";
import appraisalsRoutes from "./routes/appraisalsRoutes.js";
import bugRoutes from "./routes/bugRoutes.js";
import generalTaskRoutes from "./routes/generalTaskRoutes.js";
import availabilityRoutes from "./routes/availabilityRoutes.js";
import { feedbackRouter, bonusRequestRouter } from "./routes/feedbackRoutes.js";
import roleRoutes from "./routes/roleRoutes.js";

const app = express();

const allowedOrigins = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      const cleanOrigin = origin.replace(/\/+$/, "");
      if (allowedOrigins.length === 0 || allowedOrigins.includes(cleanOrigin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/roles", roleRoutes);
app.use("/api/departments", departmentRouter);
app.use("/api/teams", teamRouter);
app.use("/api/projects", projectRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/followups", followUpRoutes);
app.use("/api/timeblocks", timeblockRoutes);
app.use("/api/calendar", calendarRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/activity", activityRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/profile", profileRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/search", searchRoutes);
app.use("/api/leaderboard", leaderboardRoutes);
app.use("/api/appraisal", appraisalRoutes);
app.use("/api/appraisals", appraisalsRoutes);
app.use("/api/bugs", bugRoutes);
app.use("/api/general-tasks", generalTaskRoutes);
app.use("/api/availability", availabilityRoutes);
app.use("/api/feedback", feedbackRouter);
app.use("/api/bonus-requests", bonusRequestRouter);
app.use("/api/attendance", attendanceRoutes);
app.use("/api/department-violations", departmentViolationRoutes);
app.use("/api/analytics", analyticsRoutes);

app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "OK" });
});

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

app.use(errorHandler);

export default app;
