// One-off dummy-data seed for local/dev testing of the appraisal + HR
// attendance features. Idempotent for org structure (departments/teams/
// users are find-or-create by name/email); the task/activity/attendance/
// follow-up demo content is only created once (skipped on rerun if the
// demo project already exists), so rerunning this script is safe.
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

const { MONGODB_URI } = process.env;

// Hard safety rail: this script creates/deletes-nothing but writes a lot of
// demo data, and must never be pointed at the production cluster by accident.
const DEV_HOST_MARKER = "9tksggr.mongodb.net";
if (!MONGODB_URI || !MONGODB_URI.includes(DEV_HOST_MARKER)) {
  console.error(
    `Refusing to run: MONGODB_URI does not look like the dev cluster (expected host containing "${DEV_HOST_MARKER}").`
  );
  process.exit(1);
}

const PASSWORD = "Passw0rd!";

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
  if (!dept) dept = await Department.create({ name });
  return dept;
};

const findOrCreateTeam = async (name, department) => {
  let team = await Team.findOne({ name, department: department._id });
  if (!team) team = await Team.create({ name, department: department._id });
  return team;
};

const findOrCreateUser = async (fields) => {
  let user = await User.findOne({ email: fields.email });
  if (!user) {
    user = await User.create({ ...fields, password: await bcrypt.hash(fields.password || PASSWORD, 10) });
  } else {
    const { password, ...rest } = fields;
    await User.updateOne({ _id: user._id }, { $set: rest });
    user = await User.findById(user._id);
  }
  return user;
};

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log("Connected to dev DB");

  const engineering = await findOrCreateDepartment("Engineering");
  const teamAlpha = await findOrCreateTeam("Team Alpha", engineering);
  const teamBeta = await findOrCreateTeam("Team Beta", engineering);

  const admin = await findOrCreateUser({
    name: "Shams Ali",
    email: "shams@gmail.com",
    password: "shams@123",
    role: "admin",
    designation: "Founder",
  });

  const hr = await findOrCreateUser({
    name: "Priya Nair",
    email: "hr@wos.local",
    role: "hr",
    designation: "HR Manager",
  });

  const subadmin = await findOrCreateUser({
    name: "Arjun Mehta",
    email: "subadmin@wos.local",
    role: "subadmin",
    designation: "Engineering Head",
    managedDepartment: engineering._id,
    department: engineering._id,
  });

  const managerAlpha = await findOrCreateUser({
    name: "Kavya Reddy",
    email: "manager.alpha@wos.local",
    role: "manager",
    designation: "Project Manager",
    team: teamAlpha._id,
    department: engineering._id,
    managedTeam: teamAlpha._id,
    reportingManager: subadmin._id,
  });

  const managerBeta = await findOrCreateUser({
    name: "Rohan Kapoor",
    email: "manager.beta@wos.local",
    role: "manager",
    designation: "Project Manager",
    team: teamBeta._id,
    department: engineering._id,
    managedTeam: teamBeta._id,
    reportingManager: subadmin._id,
  });

  const subleadAlpha = await findOrCreateUser({
    name: "Divya Iyer",
    email: "sublead.alpha@wos.local",
    role: "sublead",
    designation: "Team Lead",
    team: teamAlpha._id,
    department: engineering._id,
    managedTeams: [teamAlpha._id],
    reportingManager: managerAlpha._id,
  });

  const subleadBeta = await findOrCreateUser({
    name: "Karan Malhotra",
    email: "sublead.beta@wos.local",
    role: "sublead",
    designation: "Team Lead",
    team: teamBeta._id,
    department: engineering._id,
    managedTeams: [teamBeta._id],
    reportingManager: managerBeta._id,
  });

  const memberDefs = [
    { name: "Abdul Raheem", email: "member1.alpha@wos.local", designation: "Frontend Developer", team: teamAlpha, reportingManager: subleadAlpha },
    { name: "Sneha Kulkarni", email: "member2.alpha@wos.local", designation: "Backend Developer", team: teamAlpha, reportingManager: subleadAlpha },
    { name: "Vikram Singh", email: "member3.alpha@wos.local", designation: "QA Engineer", team: teamAlpha, reportingManager: subleadAlpha },
    { name: "Fatima Sheikh", email: "member1.beta@wos.local", designation: "Frontend Developer", team: teamBeta, reportingManager: subleadBeta },
    { name: "Aditya Rao", email: "member2.beta@wos.local", designation: "Backend Developer", team: teamBeta, reportingManager: subleadBeta },
    { name: "Meera Pillai", email: "member3.beta@wos.local", designation: "QA Engineer", team: teamBeta, reportingManager: subleadBeta },
  ];

  const members = [];
  for (const m of memberDefs) {
    const user = await findOrCreateUser({
      name: m.name,
      email: m.email,
      role: "member",
      designation: m.designation,
      team: m.team._id,
      department: engineering._id,
      reportingManager: m.reportingManager._id,
    });
    members.push(user);
  }

  console.log(`Users ready: admin, hr, subadmin, 2 managers, 2 subleads, ${members.length} members`);

  const projectName = "Client Portal Revamp";
  let project = await Project.findOne({ name: projectName });
  const isFreshProject = !project;
  if (!project) {
    project = await Project.create({
      name: projectName,
      description: "Dummy project seeded for appraisal/HR testing",
      manager: managerAlpha._id,
      members: [...members.map((m) => m._id), subleadAlpha._id, subleadBeta._id],
      type: "client",
      status: "active",
    });
  }

  if (!isFreshProject) {
    console.log("Demo project already exists — skipping task/attendance/follow-up seeding (org structure still refreshed above).");
    await mongoose.disconnect();
    return;
  }

  // Per-user completed-task plan this month: [count, bugs, clientChanges].
  // Deliberately uneven so the roster shows a spread of scores.
  const taskPlan = new Map([
    [String(members[0]._id), [8, 1, 0]], // Abdul — strong
    [String(members[1]._id), [7, 2, 1]], // Sneha — mid
    [String(members[2]._id), [6, 0, 0]], // Vikram — clean, but gets leave marks below
    [String(members[3]._id), [9, 1, 2]], // Fatima — mid
    [String(members[4]._id), [5, 3, 0]], // Aditya — weak
    [String(members[5]._id), [6, 0, 1]], // Meera — strong
    [String(subleadAlpha._id), [6, 1, 0]],
    [String(subleadBeta._id), [5, 0, 1]],
    [String(managerAlpha._id), [5, 0, 0]],
    [String(managerBeta._id), [5, 1, 0]],
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
        createdBy: managerAlpha._id,
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
  console.log(`Seeded ${taskCount} completed tasks + activity records`);

  // Attendance: uneven late/leave spread — Aditya (already weak on defects)
  // gets hit hardest, to demo the combined score effect.
  const attendancePlan = [
    { user: members[0]._id, type: "late", offset: 3, note: "Traffic delay" },
    { user: members[2]._id, type: "leave", offset: 6, note: "Sick leave" },
    { user: members[4]._id, type: "late", offset: 2, note: "Late login" },
    { user: members[4]._id, type: "late", offset: 9, note: "Late login" },
    { user: members[4]._id, type: "leave", offset: 12, note: "Personal leave" },
    { user: managerBeta._id, type: "late", offset: 4, note: "Client call ran over" },
    { user: subleadAlpha._id, type: "leave", offset: 8, note: "Family emergency" },
  ];
  for (const a of attendancePlan) {
    await Attendance.create({
      user: a.user,
      date: daysAgoStr(a.offset),
      type: a.type,
      note: a.note,
      markedBy: hr._id,
    });
  }
  console.log(`Seeded ${attendancePlan.length} attendance records`);

  // A couple of today's follow-ups so the HR "Team" follow-ups view has content.
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
  console.log("Seeded 2 follow-up entries for today");

  await mongoose.disconnect();
  console.log("Done.");
};

run().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
