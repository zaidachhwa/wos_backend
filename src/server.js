import http from "node:http";

import app from "./app.js";
import { connectDB } from "./db/connect.js";
import { initIO } from "./utils/io.js";
import { loadPointsConfig } from "./utils/pointsConfig.js";
import { applyOverduePenalties } from "./services/overdueSweep.js";

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
    const server = http.createServer(app);
    initIO(server);
    server.listen(PORT, () => console.log(`API listening on ${PORT}`));
  } catch (error) {
    console.error("Failed to start:", error.message);
    process.exit(1);
  }
};

start();
