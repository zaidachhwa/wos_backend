import http from "node:http";

import app from "./app.js";
import { connectDB } from "./db/connect.js";
import { initIO } from "./utils/io.js";
import { loadPointsConfig } from "./utils/pointsConfig.js";
import { loadAttendanceConfig } from "./utils/attendanceConfig.js";
import { loadAppraisalConfig } from "./utils/appraisalConfig.js";
import { applyOverduePenalties } from "./services/overdueSweep.js";
import { sendEveningFollowUpReminders } from "./services/followUpReminders.js";
import { runMorningAttendanceSweep } from "./services/attendanceSweep.js";
import { localDay } from "./controllers/notificationController.js";
import { istClock } from "./utils/istTime.js";
import { ensureAppraisalConfig } from "./services/appraisal/appraisalConfig.js";
import { runAppraisalScheduler } from "./services/appraisal/appraisalScheduler.js";
import { sendWeeklyDirectorReports } from "./services/weeklyDirectorReport.js";

const PORT = process.env.PORT || 5000;

const REQUIRED_ENV = ["MONGODB_URI", "ACCESS_TOKEN_SECRET", "REFRESH_TOKEN_SECRET", "CLIENT_ORIGIN"];

const start = async () => {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`Missing required env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  try {
    await connectDB();
    await loadPointsConfig();
    await loadAttendanceConfig();
    await loadAppraisalConfig();
    await ensureAppraisalConfig();
    applyOverduePenalties().catch((error) => console.error("overdue sweep failed:", error.message));
    setInterval(() => {
      applyOverduePenalties().catch((error) => console.error("overdue sweep failed:", error.message));
    }, 2 * 60 * 1000);

    // Evening follow-up reminder emails, once a day at/after 8:30pm IST.
    // Checked every minute rather than scheduled for the exact instant —
    // simplest way to survive the process being down at 20:30 sharp (fires
    // on the first tick after) without pulling in a cron library. The
    // per-user "already emailed today" Notification marker (see
    // services/followUpReminders.js) makes a same-day re-run after a restart
    // a safe no-op, same idempotency shape as overdueSweep's claim-before-act.
    let lastReminderRunDate = null;
    setInterval(() => {
      const now = new Date();
      const { hours, minutes } = istClock(now);
      const pastReminderTime = hours > 20 || (hours === 20 && minutes >= 30);
      const today = localDay(now);
      if (pastReminderTime && lastReminderRunDate !== today) {
        lastReminderRunDate = today;
        sendEveningFollowUpReminders(now).catch((error) =>
          console.error("evening reminder sweep failed:", error.message)
        );
      }
    }, 60 * 1000);

    // Morning-attendance sweep, once a day at/after 9pm IST — late enough
    // that anyone submitting their morning follow-up today has already done
    // so. Classifies the day's follow-up submissions into late/absent
    // Attendance records (see services/attendanceSweep.js); never overwrites
    // an existing entry for that user/date, so — same as the reminder sweep
    // above — a same-day rerun after a restart is a safe no-op.
    let lastAttendanceSweepDate = null;
    setInterval(() => {
      const now = new Date();
      const { hours } = istClock(now);
      const pastSweepTime = hours >= 21;
      const today = localDay(now);
      if (pastSweepTime && lastAttendanceSweepDate !== today) {
        lastAttendanceSweepDate = today;
        runMorningAttendanceSweep(now).catch((error) =>
          console.error("morning attendance sweep failed:", error.message)
        );
      }
    }, 60 * 1000);

    // Monthly performance appraisal: closes the previous IST month and
    // emails finalized appraisals from 00:01 IST on the 1st (see
    // services/appraisal/appraisalScheduler.js). Every step is claim-based
    // and idempotent, so ticking every minute — and catching up on the
    // first tick after a restart — can never double-close or double-send.
    // APPRAISAL_SCHEDULER_DISABLED=true turns it off (e.g. a local copy of
    // production data with a live mail key).
    if (process.env.APPRAISAL_SCHEDULER_DISABLED !== "true") {
      setInterval(() => {
        runAppraisalScheduler(new Date()).catch((error) => console.error("appraisal scheduler failed:", error.message));
      }, 60 * 1000);
    }

    // Weekly director department report — fires every Monday at/after 08:00 IST.
    // The per-run date guard (lastWeeklyReportDate) makes it fire exactly once
    // per Monday even across ticks or restarts on the same day.
    let lastWeeklyReportDate = null;
    setInterval(() => {
      const now = new Date();
      const { hours, dayOfWeek } = istClock(now);
      const isMonday = dayOfWeek === 1;
      const today = localDay(now);
      if (isMonday && hours >= 8 && lastWeeklyReportDate !== today) {
        lastWeeklyReportDate = today;
        sendWeeklyDirectorReports(now).catch((error) =>
          console.error("weekly director report failed:", error.message)
        );
      }
    }, 60 * 1000);

    const server = http.createServer(app);
    initIO(server);
    server.listen(PORT, () => console.log(`API listening on ${PORT}`));
  } catch (error) {
    console.error("Failed to start:", error.message);
    process.exit(1);
  }
};

start();
