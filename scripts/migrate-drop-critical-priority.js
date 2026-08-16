import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  for (const collName of ["tasks", "projects"]) {
    const coll = db.collection(collName);
    const result = await coll.updateMany({ priority: "critical" }, { $set: { priority: "high" } });
    console.log(`${collName}: migrated ${result.modifiedCount} "critical" -> "high"`);

    const remaining = await coll.countDocuments({ priority: "critical" });
    console.assert(remaining === 0, `FAIL: ${remaining} ${collName} still have priority "critical"`);
  }

  const configResult = await db
    .collection("leaderboardconfigs")
    .updateMany({}, { $unset: { "pointsByPriority.critical": "" } });
  console.log(`leaderboardconfigs: stripped critical from ${configResult.modifiedCount} doc(s)`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
