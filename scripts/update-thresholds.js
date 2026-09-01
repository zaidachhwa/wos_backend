// CommonJS — run: node scripts/update-thresholds.js
const mongoose = require("mongoose");

async function run() {
  await mongoose.connect("mongodb://127.0.0.1:27017/workos_dev");
  const result = await mongoose.connection.db
    .collection("teams")
    .updateMany({}, { $set: { "performanceThresholds.red": 50, "performanceThresholds.yellow": 85 } });
  console.log(`Updated ${result.modifiedCount} team(s) → red<50 Red | 50-84 Yellow | >=85 Green`);
  await mongoose.disconnect();
}

run().catch((e) => { console.error(e); process.exit(1); });
