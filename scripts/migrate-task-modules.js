import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const coll = db.collection("tasks");

  const cursor = coll.find({ module: { $exists: true } });
  let migrated = 0;
  for await (const doc of cursor) {
    const modules = doc.module ? [doc.module] : [];
    await coll.updateOne({ _id: doc._id }, { $set: { modules }, $unset: { module: "" } });
    migrated += 1;
  }
  console.log(`Migrated ${migrated} tasks.`);

  const remaining = await coll.countDocuments({ module: { $exists: true } });
  console.assert(remaining === 0, `FAIL: ${remaining} tasks still have the old module field`);
  console.log("Migration verified: no documents retain the old module field.");

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
