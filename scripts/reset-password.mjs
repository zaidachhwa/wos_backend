// Run from wos_backend directory: node scripts/reset-password.mjs
import mongoose from "mongoose";
import bcrypt from "bcrypt";

const MONGODB_URI = "mongodb://nexcorealliance:nexcore_alliance@72.62.241.150:27045/admin?authSource=admin";

await mongoose.connect(MONGODB_URI);

const NAME = "Prashant Patil";
const NEW_PASSWORD = "12345678";

const hashed = await bcrypt.hash(NEW_PASSWORD, 10);

const result = await mongoose.connection.db.collection("users").updateOne(
  { name: { $regex: new RegExp(`^${NAME}$`, "i") } },
  { $set: { password: hashed } }
);

if (result.matchedCount === 0) {
  console.error(`❌ No user found with name "${NAME}"`);
} else {
  console.log(`✅ Password reset for "${NAME}" → 12345678`);
}

await mongoose.disconnect();
