// Run from wos_backend directory: node scripts/update-thresholds.mjs
import mongoose from "mongoose";

const MONGODB_URI = "mongodb://127.0.0.1:27017/workos_dev";

await mongoose.connect(MONGODB_URI);
const result = await mongoose.connection.db.collection("teams").updateMany(
  {},
  { $set: { "performanceThresholds.red": 50, "performanceThresholds.yellow": 85 } }
);
console.log(`Updated ${result.modifiedCount} team(s) → red<50=Red, 50–84=Yellow, >=85=Green`);
await mongoose.disconnect();
