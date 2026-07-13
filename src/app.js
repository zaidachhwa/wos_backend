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

const app = express();

app.use(cors({ origin: process.env.CLIENT_ORIGIN, credentials: true }));
app.use(express.json());
app.use(cookieParser());

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
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

app.get("/api/health", (req, res) => {
  res.json({ success: true, message: "OK" });
});

app.use("/api", (req, res) => {
  res.status(404).json({ success: false, message: "Not found" });
});

app.use(errorHandler);

export default app;
