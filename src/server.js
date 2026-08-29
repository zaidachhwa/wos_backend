import http from "node:http";

import app from "./app.js";
import { connectDB } from "./db/connect.js";
import { initIO } from "./utils/io.js";
import { loadPointsConfig } from "./utils/pointsConfig.js";
import { applyOverduePenalties } from "./services/overdueSweep.js";
import { sendEveningFollowUpReminders } from "./services/followUpReminders.js";
import { runMonthlyMemoSweep } from "./services/memoSweep.js";
import { localDay } from "./controllers/notificationController.js";
import { istClock, istDayStr } from "./utils/istTime.js";

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

    // Monthly performance memo sweep: fires once when the IST calendar rolls
    // into a new month, evaluating the month that just ended (the default
    // month runMonthlyMemoSweep resolves). The in-memory guard only prevents
    // re-firing within one process's uptime — true restart-safe idempotency
    // comes from Memo's unique {user, month} index (a repeat pass is a no-op
    // per user), same layering as the evening reminder job above.
    let lastMemoSweepMonth = null;
    setInterval(() => {
      const currentMonth = istDayStr(new Date()).slice(0, 7);
      if (lastMemoSweepMonth !== currentMonth) {
        lastMemoSweepMonth = currentMonth;
        runMonthlyMemoSweep().catch((error) => console.error("memo sweep failed:", error.message));
      }
    }, 60 * 60 * 1000);

    const server = http.createServer(app);
    initIO(server);
    server.listen(PORT, () => console.log(`API listening on ${PORT}`));
  } catch (error) {
    console.error("Failed to start:", error.message);
    process.exit(1);
  }
};

start();
