import mongoose from "mongoose";

import "../src/models/Department.js";
import Role from "../src/models/Role.js";
import User from "../src/models/User.js";

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB");

  // 1. Update the Role document
  const roleUpdate = await Role.updateMany(
    { name: { $regex: /^head\s*[-–—of\s]*technical\s*operations?$/i } },
    { $set: { baseRole: "head_of_technical_operations" } }
  );
  console.log("Updated Role definitions:", roleUpdate);

  // If the role doesn't exist, create it
  const existingRole = await Role.findOne({ name: { $regex: /^head\s*[-–—of\s]*technical\s*operations?$/i } });
  if (!existingRole) {
    const createdRole = await Role.create({
      name: "Head - Technical Operations",
      baseRole: "head_of_technical_operations",
      description: "Oversees technical operations with administrative permissions.",
      isActive: true,
    });
    console.log("Created Role document:", createdRole);
  }

  // 2. Update users with designation matching "Head - Technical Operations" or "Head of Technical Operation"
  const userUpdate = await User.updateMany(
    { designation: { $regex: /^head\s*[-–—of\s]*technical\s*operations?$/i } },
    { $set: { role: "head_of_technical_operations" } }
  );
  console.log("Updated Users:", userUpdate);

  // Print updated users
  const updatedUsers = await User.find({
    $or: [
      { role: "head_of_technical_operations" },
      { designation: { $regex: /^head\s*[-–—of\s]*technical\s*operations?$/i } },
    ],
  }).select("name email role designation department");

  console.log("\nUsers with Head of Technical Operations role/designation:");
  for (const u of updatedUsers) {
    console.log(`- ${u.name} (${u.email}): role="${u.role}", designation="${u.designation}"`);
  }

  process.exit(0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
