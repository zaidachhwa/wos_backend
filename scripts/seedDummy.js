// Dummy-data seed for local/dev testing of the appraisal, HR, attendance,
// tasks, and role-based access control.
// Idempotent for org structure (departments/teams/users are find-or-create by name/email).
// Demo content (project, tasks, attendance, follow-ups) is created if not already present.
import mongoose from "mongoose";
import bcrypt from "bcrypt";

import Department from "../src/models/Department.js";
import Team from "../src/models/Team.js";
import User from "../src/models/User.js";
import Project from "../src/models/Project.js";
import Task from "../src/models/Task.js";
import Activity from "../src/models/Activity.js";
import Attendance from "../src/models/Attendance.js";
import FollowUp from "../src/models/FollowUp.js";

const { MONGODB_URI, SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD } = process.env;

// Allow localhost / 127.0.0.1 / dev database or explicit ALLOW_SEED=true
const isAllowedDb =
  MONGODB_URI &&
  (MONGODB_URI.includes("127.0.0.1") ||
    MONGODB_URI.includes("localhost") ||
    MONGODB_URI.includes("workos_dev") ||
    MONGODB_URI.includes("9tksggr.mongodb.net") ||
    process.env.ALLOW_SEED === "true");

if (!isAllowedDb) {
  console.error(
    `Refusing to run: MONGODB_URI does not look like a local or dev database.\nIf you are sure, set ALLOW_SEED=true in your environment.`
  );
  process.exit(1);
}

const DEFAULT_PASSWORD = "Passw0rd!";

const pad = (n) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysAgoStr = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const daysAgoDate = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

const findOrCreateDepartment = async (name) => {
  let dept = await Department.findOne({ name });
  if (!dept) dept = await Department.create({ name, description: `${name} Department` });
  return dept;
};

const findOrCreateTeam = async (name, department) => {
  let team = await Team.findOne({ name, department: department._id });
  if (!team) team = await Team.create({ name, department: department._id });
  return team;
};

const findOrCreateUser = async (fields) => {
  let user = await User.findOne({ email: fields.email });
  const rawPassword = fields.password || DEFAULT_PASSWORD;
  if (!user) {
    user = await User.create({
      ...fields,
      password: await bcrypt.hash(rawPassword, 10),
    });
  } else {
    const { password, ...rest } = fields;
    const update = { ...rest };
    if (fields.password) {
      update.password = await bcrypt.hash(fields.password, 10);
    }
    await User.updateOne({ _id: user._id }, { $set: update });
    user = await User.findById(user._id);
  }
  return { user, password: rawPassword };
};

const run = async () => {
  console.log(`Connecting to DB: ${MONGODB_URI}...`);
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to MongoDB successfully.\n");

  // 1. Departments & Teams
  const engineering = await findOrCreateDepartment("Engineering");
  const teamAlpha = await findOrCreateTeam("Team Alpha", engineering);
  const teamBeta = await findOrCreateTeam("Team Beta", engineering);

  const seededUsers = [];

  // 2. Admin Accounts
  // Default env admin
  if (SEED_ADMIN_EMAIL && SEED_ADMIN_PASSWORD) {
    const adminAccount = await findOrCreateUser({
      name: "System Admin",
      email: SEED_ADMIN_EMAIL,
      password: SEED_ADMIN_PASSWORD,
      role: "admin",
      designation: "Administrator",
    });
    seededUsers.push({ ...adminAccount, role: "admin", note: "Env Admin" });
  }

  const shamsAdmin = await findOrCreateUser({
    name: "Shams Ali",
    email: "shams@gmail.com",
    password: "shams@123",
    role: "admin",
    designation: "Founder",
  });
  seededUsers.push({ ...shamsAdmin, role: "admin", note: "Founder Admin" });

  // 3. Director Account
  const director = await findOrCreateUser({
    name: "Rajesh Verma",
    email: "director@wos.local",
    role: "director",
    designation: "Director of Operations",
    department: engineering._id,
  });
  seededUsers.push({ ...director, role: "director", note: "Executive / Director" });

  // 4. HR Account
  const hr = await findOrCreateUser({
    name: "Priya Nair",
    email: "hr@wos.local",
    role: "hr",
    designation: "HR Manager",
    department: engineering._id,
  });
  seededUsers.push({ ...hr, role: "hr", note: "HR Manager" });

  // 5. Subadmin Account (Department Head)
  const subadmin = await findOrCreateUser({
    name: "Arjun Mehta",
    email: "subadmin@wos.local",
    role: "subadmin",
    designation: "Engineering Head",
    managedDepartment: engineering._id,
    department: engineering._id,
  });
  seededUsers.push({ ...subadmin, role: "subadmin", note: "Engineering Head" });

  // 6. Managers
  const managerAlpha = await findOrCreateUser({
    name: "Kavya Reddy",
    email: "manager.alpha@wos.local",
    role: "manager",
    designation: "Project Manager",
    team: teamAlpha._id,
    department: engineering._id,
    managedTeam: teamAlpha._id,
    reportingManager: subadmin.user._id,
  });
  seededUsers.push({ ...managerAlpha, role: "manager", note: "Manager (Team Alpha)" });

  const managerBeta = await findOrCreateUser({
    name: "Rohan Kapoor",
    email: "manager.beta@wos.local",
    role: "manager",
    designation: "Project Manager",
    team: teamBeta._id,
    department: engineering._id,
    managedTeam: teamBeta._id,
    reportingManager: subadmin.user._id,
  });
  seededUsers.push({ ...managerBeta, role: "manager", note: "Manager (Team Beta)" });

  // 7. Subleads
  const subleadAlpha = await findOrCreateUser({
    name: "Divya Iyer",
    email: "sublead.alpha@wos.local",
    role: "sublead",
    designation: "Team Lead",
    team: teamAlpha._id,
    department: engineering._id,
    managedTeams: [teamAlpha._id],
    reportingManager: managerAlpha.user._id,
  });
  seededUsers.push({ ...subleadAlpha, role: "sublead", note: "Team Lead (Alpha)" });

  const subleadBeta = await findOrCreateUser({
    name: "Karan Malhotra",
    email: "sublead.beta@wos.local",
    role: "sublead",
    designation: "Team Lead",
    team: teamBeta._id,
    department: engineering._id,
    managedTeams: [teamBeta._id],
    reportingManager: managerBeta.user._id,
  });
  seededUsers.push({ ...subleadBeta, role: "sublead", note: "Team Lead (Beta)" });

  // 8. QA
  const qa = await findOrCreateUser({
    name: "Neha Sharma",
    email: "qa@wos.local",
    role: "qa",
    designation: "Lead QA Engineer",
    team: teamAlpha._id,
    department: engineering._id,
    reportingManager: subleadAlpha.user._id,
  });
  seededUsers.push({ ...qa, role: "qa", note: "QA Lead" });

  // 9. Members
  const memberDefs = [
    { name: "Abdul Raheem", email: "member1.alpha@wos.local", designation: "Frontend Developer", team: teamAlpha, reportingManager: subleadAlpha.user },
    { name: "Sneha Kulkarni", email: "member2.alpha@wos.local", designation: "Backend Developer", team: teamAlpha, reportingManager: subleadAlpha.user },
    { name: "Vikram Singh", email: "member3.alpha@wos.local", designation: "QA Engineer", team: teamAlpha, reportingManager: subleadAlpha.user },
    { name: "Fatima Sheikh", email: "member1.beta@wos.local", designation: "Frontend Developer", team: teamBeta, reportingManager: subleadBeta.user },
    { name: "Aditya Rao", email: "member2.beta@wos.local", designation: "Backend Developer", team: teamBeta, reportingManager: subleadBeta.user },
    { name: "Meera Pillai", email: "member3.beta@wos.local", designation: "QA Engineer", team: teamBeta, reportingManager: subleadBeta.user },
    { name: "John Member", email: "member@wos.local", designation: "Fullstack Developer", team: teamAlpha, reportingManager: subleadAlpha.user },
  ];

  const members = [];
  for (const m of memberDefs) {
    const res = await findOrCreateUser({
      name: m.name,
      email: m.email,
      role: "member",
      designation: m.designation,
      team: m.team._id,
      department: engineering._id,
      reportingManager: m.reportingManager._id,
    });
    members.push(res.user);
    seededUsers.push({ ...res, role: "member", note: `${m.designation} (${m.team.name})` });
  }

  console.log(`✓ Seeded ${seededUsers.length} user accounts covering all roles.`);

  // 10. Sample Project & Activities/Tasks
  const projectName = "Client Portal Revamp";
  let project = await Project.findOne({ name: projectName });
  const isFreshProject = !project;
  if (!project) {
    project = await Project.create({
      name: projectName,
      description: "Dummy project seeded for local development and appraisal/HR testing",
      manager: managerAlpha.user._id,
      members: [...members.map((m) => m._id), subleadAlpha.user._id, subleadBeta.user._id, qa.user._id],
      type: "client",
      status: "active",
    });
    console.log(`✓ Created demo project: "${projectName}"`);
  }

  if (isFreshProject) {
    // Task distribution
    const taskPlan = new Map([
      [String(members[0]._id), [8, 1, 0]], // Abdul — strong
      [String(members[1]._id), [7, 2, 1]], // Sneha — mid
      [String(members[2]._id), [6, 0, 0]], // Vikram — clean
      [String(members[3]._id), [9, 1, 2]], // Fatima — mid
      [String(members[4]._id), [5, 3, 0]], // Aditya — weak
      [String(members[5]._id), [6, 0, 1]], // Meera — strong
      [String(members[6]._id), [5, 1, 1]], // John — general
      [String(subleadAlpha.user._id), [6, 1, 0]],
      [String(subleadBeta.user._id), [5, 0, 1]],
      [String(managerAlpha.user._id), [5, 0, 0]],
      [String(managerBeta.user._id), [5, 1, 0]],
    ]);

    let taskCount = 0;
    let dayOffset = 1;
    for (const [userId, [total, bugs, clientChanges]] of taskPlan.entries()) {
      for (let i = 0; i < total; i += 1) {
        const isBug = i < bugs;
        const isClientChange = !isBug && i < bugs + clientChanges;
        const completedAt = daysAgoDate((dayOffset % 18) + 1);
        dayOffset += 1;

        const task = await Task.create({
          project: project._id,
          title: isBug ? `Fix issue #${taskCount + 1}` : `Task ${taskCount + 1}`,
          assignees: [userId],
          type: isBug ? "bug" : "task",
          isClientChange,
          status: "completed",
          priority: "medium",
          createdBy: managerAlpha.user._id,
        });
        await Activity.create({
          actor: userId,
          action: "updated",
          entityType: "task",
          entityId: task._id,
          project: project._id,
          meta: { statusFrom: "in_progress", statusTo: "completed" },
          createdAt: completedAt,
        });
        taskCount += 1;
      }
    }
    console.log(`✓ Seeded ${taskCount} completed tasks and activity records`);

    // Attendance data
    const attendancePlan = [
      { user: members[0]._id, type: "late", offset: 3, note: "Traffic delay" },
      { user: members[2]._id, type: "leave", offset: 6, note: "Sick leave" },
      { user: members[4]._id, type: "late", offset: 2, note: "Late login" },
      { user: members[4]._id, type: "late", offset: 9, note: "Late login" },
      { user: members[4]._id, type: "leave", offset: 12, note: "Personal leave" },
      { user: managerBeta.user._id, type: "late", offset: 4, note: "Client call ran over" },
      { user: subleadAlpha.user._id, type: "leave", offset: 8, note: "Family emergency" },
    ];
    for (const a of attendancePlan) {
      await Attendance.create({
        user: a.user,
        date: daysAgoStr(a.offset),
        type: a.type,
        note: a.note,
        markedBy: hr.user._id,
      });
    }
    console.log(`✓ Seeded ${attendancePlan.length} attendance records`);

    // Follow-ups for today
    await FollowUp.create({
      user: members[0]._id,
      date: todayStr(),
      type: "morning",
      status: "submitted",
      morning: { yesterdayCompleted: "Finished login page", todayPlan: "Start on dashboard widgets", blockers: "", estimatedHours: 6 },
      submittedAt: new Date(),
    });
    await FollowUp.create({
      user: members[3]._id,
      date: todayStr(),
      type: "morning",
      status: "submitted",
      morning: { yesterdayCompleted: "API integration", todayPlan: "Write tests", blockers: "Waiting on staging access", estimatedHours: 5 },
      submittedAt: new Date(),
    });
    console.log("✓ Seeded 2 follow-up entries for today");
  } else {
    console.log("ℹ Demo project already exists — skipped task/attendance seeding (users were verified/updated).");
  }

  console.log("\n=================== DUMMY USERS CREDENTIALS ===================");
  console.table(
    seededUsers.map((item) => ({
      Role: item.role.toUpperCase(),
      Name: item.user.name,
      Email: item.user.email,
      Password: item.password,
      Note: item.note,
    }))
  );
  console.log("===============================================================\n");

  await mongoose.disconnect();
  console.log("Seed completed successfully!");
};

run().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});

