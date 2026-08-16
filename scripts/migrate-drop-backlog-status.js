import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const coll = db.collection("tasks");

  const result = await coll.updateMany({ status: "backlog" }, { $set: { status: "todo" } });
  console.log(`tasks: migrated ${result.modifiedCount} "backlog" -> "todo"`);

  const remaining = await coll.countDocuments({ status: "backlog" });
  console.assert(remaining === 0, `FAIL: ${remaining} tasks still have status "backlog"`);

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
