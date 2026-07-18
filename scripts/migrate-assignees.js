import mongoose from "mongoose";

const MONGODB_URI = process.env.MONGODB_URI;

const migrateCollection = async (db, collectionName, primaryField) => {
  const coll = db.collection(collectionName);
  const cursor = coll.find({
    $or: [{ [primaryField]: { $exists: true } }, { collaborators: { $exists: true } }],
  });

  let migrated = 0;
  for await (const doc of cursor) {
    const merged = [
      ...(doc[primaryField] ? [String(doc[primaryField])] : []),
      ...((doc.collaborators || []).map(String)),
    ];
    const assignees = [...new Set(merged)].map((id) => new mongoose.Types.ObjectId(id));

    await coll.updateOne(
      { _id: doc._id },
      { $set: { assignees }, $unset: { [primaryField]: "", collaborators: "" } }
    );
    migrated += 1;
  }
  return migrated;
};

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  const taskCount = await migrateCollection(db, "tasks", "assignee");
  const moduleCount = await migrateCollection(db, "projectmodules", "lead");

  console.log(`Migrated ${taskCount} tasks, ${moduleCount} modules.`);

  const remainingTasks = await db
    .collection("tasks")
    .countDocuments({ $or: [{ assignee: { $exists: true } }, { collaborators: { $exists: true } }] });
  const remainingModules = await db
    .collection("projectmodules")
    .countDocuments({ $or: [{ lead: { $exists: true } }, { collaborators: { $exists: true } }] });

  console.assert(remainingTasks === 0, `FAIL: ${remainingTasks} tasks still have old fields`);
  console.assert(remainingModules === 0, `FAIL: ${remainingModules} modules still have old fields`);
  console.log("Migration verified: no documents retain the old assignee/lead/collaborators fields.");

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
