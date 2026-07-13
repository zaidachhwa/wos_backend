import mongoose from "mongoose";
import bcrypt from "bcrypt";

import User from "../src/models/User.js";

const seed = async () => {
  const { MONGODB_URI, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;
  if (!MONGODB_URI || !SEED_ADMIN_EMAIL || !SEED_ADMIN_PASSWORD) {
    console.error("MONGODB_URI, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required");
    process.exit(1);
  }
  await mongoose.connect(MONGODB_URI);
  const existing = await User.findOne({ role: "admin" });
  if (existing) {
    console.log(`Admin already exists: ${existing.email}`);
  } else {
    await User.create({
      name: "Admin",
      email: SEED_ADMIN_EMAIL,
      password: await bcrypt.hash(SEED_ADMIN_PASSWORD, 10),
      role: "admin",
    });
    console.log(`Admin created: ${SEED_ADMIN_EMAIL}`);
  }
  await mongoose.disconnect();
};

seed().catch((error) => {
  console.error("Seed failed:", error.message);
  process.exit(1);
});
