// Run from wos_backend directory: node scripts/reset-password.mjs
import mongoose from "mongoose";
import bcrypt from "bcrypt";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb://nexcorealliance:nexcore_alliance@72.62.241.150:27045/admin?authSource=admin";

await mongoose.connect(MONGODB_URI);

const NAME = "Sharique Shah";
const NEW_PASSWORD = "12345678";

const users = await mongoose.connection.db.collection("users").find({
  $or: [
    { name: new RegExp("shariq", "i") },
    { name: new RegExp("shah", "i") },
    { email: new RegExp("shariq", "i") },
    { email: new RegExp("shah", "i") },
  ]
}).toArray();

console.log("Matching users found:", users.map(u => ({ id: u._id, name: u.name, email: u.email })));

const targets = users.filter(u => /shariq/i.test(u.name) || /shariq/i.test(u.email));
const hashed = await bcrypt.hash("12345678", 10);
for (const target of targets) {
  await mongoose.connection.db.collection("users").updateOne(
    { _id: target._id },
    { $set: { password: hashed } }
  );
  console.log(`✅ Password reset for "${target.name}" (${target.email}) → 12345678`);
}

await mongoose.disconnect();
