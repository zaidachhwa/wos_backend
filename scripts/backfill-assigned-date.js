import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const coll = db.collection("tasks");

  const cursor = coll.find({ assignedDate: { $exists: false } });
  let migrated = 0;
  for await (const doc of cursor) {
    await coll.updateOne({ _id: doc._id }, { $set: { assignedDate: doc.createdAt || new Date() } });
    migrated += 1;
  }
  console.log(`Backfilled assignedDate on ${migrated} tasks.`);

  const remaining = await coll.countDocuments({ assignedDate: { $exists: false } });
  console.assert(remaining === 0, `FAIL: ${remaining} tasks still missing assignedDate`);
  console.log("Backfill verified.");

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
