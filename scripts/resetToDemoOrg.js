// Wipes all working data (smoke-test users, projects, tasks, follow-ups,
// notifications, appraisals…) and seeds a small clean organisation:
//
//   2 departments × (1 team lead + 3 employees)  = 8
//   1 HR + 1 Director                             = 2   → 10 people
//
// Kept: real admin accounts (role admin, not smoke-test) so someone can still
// log in as super admin, and org-wide configuration collections.
//
// Destructive, so it refuses to run without --confirm and first writes every
// collection to backups/<timestamp>/ as JSON.
//
//   node --env-file=.env scripts/resetToDemoOrg.js --confirm
//
// Env: DEMO_PASSWORD (login password for all 10; random if unset, printed),
//      DEMO_EMAIL_DOMAIN (default example.com — use a real domain to receive
//      appraisal emails).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import bcrypt from "bcrypt";
import mongoose from "mongoose";

import Department from "../src/models/Department.js";
import Team from "../src/models/Team.js";
import User from "../src/models/User.js";

// Configuration, not data — survives the reset.
const KEEP_COLLECTIONS = new Set([
  "leaderboardconfigs",
  "attendanceconfigs",
  "appraisalconfigs",
  "appraisalsettings",
  "appraisalcriterions",
]);

const isSmokeUser = (u) => /smoke/i.test(u.name || "") || /@wos\.local$/i.test(u.email || "");

const ORG = [
  {
    department: "Engineering",
    team: "Engineering Team",
    lead: { name: "Rahul Mehta", designation: "Engineering Team Lead" },
    members: [
      { name: "Priya Sharma", designation: "Senior Software Engineer" },
      { name: "Arjun Nair", designation: "Software Engineer" },
      { name: "Sneha Iyer", designation: "Software Engineer" },
    ],
  },
  {
    department: "Operations",
    team: "Operations Team",
    lead: { name: "Kavita Rao", designation: "Operations Team Lead" },
    members: [
      { name: "Vikram Singh", designation: "Operations Executive" },
      { name: "Neha Gupta", designation: "Operations Executive" },
      { name: "Imran Khan", designation: "Operations Associate" },
    ],
  },
];
const HR = { name: "Anjali Desai", designation: "HR Manager" };
const DIRECTOR = { name: "Suresh Menon", designation: "Director" };

const emailFor = (name, domain) => `${name.toLowerCase().replace(/[^a-z]+/g, ".")}@${domain}`;

const run = async () => {
  if (!process.argv.includes("--confirm")) {
    console.error("Refusing to run: this deletes data. Re-run with --confirm.");
    process.exit(1);
  }
  const { MONGODB_URI } = process.env;
  if (!MONGODB_URI) throw new Error("MONGODB_URI is required");
  const domain = process.env.DEMO_EMAIL_DOMAIN || "example.com";
  const password = process.env.DEMO_PASSWORD || crypto.randomBytes(9).toString("base64url");

  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  console.log(`Database: ${db.databaseName}`);

  // 1. Backup
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.resolve("backups", `${db.databaseName}-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const collections = (await db.listCollections().toArray()).map((c) => c.name);
  for (const name of collections) {
    const docs = await db.collection(name).find().toArray();
    fs.writeFileSync(path.join(backupDir, `${name}.json`), JSON.stringify(docs));
  }
  console.log(`Backup written: ${backupDir}`);

  // 2. Wipe data (keep config + real admins)
  const users = await db.collection("users").find({}, { projection: { name: 1, email: 1, role: 1 } }).toArray();
  const keptAdmins = users.filter((u) => u.role === "admin" && !isSmokeUser(u));
  for (const name of collections) {
    if (KEEP_COLLECTIONS.has(name)) continue;
    if (name === "users") {
      const r = await db.collection(name).deleteMany({ _id: { $nin: keptAdmins.map((u) => u._id) } });
      console.log(`  users: removed ${r.deletedCount}, kept ${keptAdmins.length} admin(s): ${keptAdmins.map((u) => u.email).join(", ")}`);
    } else {
      const r = await db.collection(name).deleteMany({});
      console.log(`  ${name}: removed ${r.deletedCount}`);
    }
  }

  // 3. Seed the organisation
  const hash = await bcrypt.hash(password, 10);
  const joinedAt = new Date("2025-01-01T00:00:00+05:30");
  const base = { password: hash, joinedAt, isActive: true };
  const created = [];

  for (const unit of ORG) {
    const department = await Department.create({ name: unit.department });
    const team = await Team.create({ name: unit.team, department: department._id });
    const lead = await User.create({
      ...base,
      ...unit.lead,
      email: emailFor(unit.lead.name, domain),
      role: "manager",
      department: department._id,
      team: team._id,
      managedTeam: team._id,
    });
    created.push({ ...unit.lead, role: "Team Lead (manager)", department: unit.department, email: lead.email });
    for (const m of unit.members) {
      const member = await User.create({
        ...base,
        ...m,
        email: emailFor(m.name, domain),
        role: "member",
        department: department._id,
        team: team._id,
        reportingManager: lead._id,
      });
      created.push({ ...m, role: "Employee (member)", department: unit.department, email: member.email });
    }
  }
  const hr = await User.create({ ...base, ...HR, email: emailFor(HR.name, domain), role: "hr" });
  created.push({ ...HR, role: "HR", department: "—", email: hr.email });
  const director = await User.create({ ...base, ...DIRECTOR, email: emailFor(DIRECTOR.name, domain), role: "director" });
  created.push({ ...DIRECTOR, role: "Director", department: "—", email: director.email });

  console.log("\nSeeded users:");
  console.table(created.map(({ name, role, department, designation, email }) => ({ name, role, department, designation, email })));
  console.log(process.env.DEMO_PASSWORD ? "Password: (DEMO_PASSWORD)" : `Password for all 10: ${password}`);
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("Reset failed:", error.message);
  await mongoose.disconnect();
  process.exit(1);
});
