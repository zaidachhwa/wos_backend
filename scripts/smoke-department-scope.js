import assert from "node:assert";
import axios from "axios";
import mongoose from "mongoose";

import User from "../src/models/User.js";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role, extra = {}) => {
  const name = `Smoke ${role} ${Math.random().toString(36).slice(2, 6)}`;
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  const res = await axios.post(`${BASE}/users`, { name, email, password, role, ...extra }, adminAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    name,
    userId: res.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  // Two separate departments, each with one team, so we can prove cross-
  // department isolation rather than just "some" filtering.
  const deptA = await axios.post(`${BASE}/departments`, { name: `Smoke Dept A ${Date.now()}` }, adminAuth);
  const deptB = await axios.post(`${BASE}/departments`, { name: `Smoke Dept B ${Date.now()}` }, adminAuth);
  const deptAId = deptA.data.data.department._id;
  const deptBId = deptB.data.data.department._id;
  const teamA = await axios.post(`${BASE}/teams`, { name: `Smoke Team A ${Date.now()}`, department: deptAId }, adminAuth);
  // A second team in dept A proves the boundary is the department, not the
  // team — a team-scoped (rather than department-scoped) filter would wrongly
  // exclude memberA2 below.
  const teamA2 = await axios.post(`${BASE}/teams`, { name: `Smoke Team A2 ${Date.now()}`, department: deptAId }, adminAuth);
  const teamB = await axios.post(`${BASE}/teams`, { name: `Smoke Team B ${Date.now()}`, department: deptBId }, adminAuth);
  const teamAId = teamA.data.data.team._id;
  const teamA2Id = teamA2.data.data.team._id;
  const teamBId = teamB.data.data.team._id;

  const memberA1 = await createUser(adminAuth, "member", { team: teamAId });
  const memberA2 = await createUser(adminAuth, "member", { team: teamA2Id });
  const memberB = await createUser(adminAuth, "member", { team: teamBId });

  // --- Task 2: directory is department-scoped ---

  const dirA1 = await axios.get(`${BASE}/users/directory`, memberA1.auth);
  const namesA1 = dirA1.data.data.users.map((u) => u.name);
  assert.ok(namesA1.includes(memberA2.name), "same-department, different-team sibling is visible");
  assert.ok(!namesA1.includes(memberB.name), "a different department's member is NOT visible in the directory");

  const dirAdmin = await axios.get(`${BASE}/users/directory`, adminAuth);
  assert.ok(
    dirAdmin.data.data.users.map((u) => u.name).includes(memberB.name),
    "admin's directory is unrestricted, sees every department"
  );

  // --- fix: the directory filter always folds in the caller's own _id, so
  // every non-admin role sees themselves even when scope.teamIds wouldn't
  // otherwise match their own team --------------------------------------

  assert.ok(namesA1.includes(memberA1.name), "a member-with-a-team sees themselves in their own directory");

  // A manager's own `team` has no designed relationship to the department
  // they manage (managedDepartment drives scope.teamIds, not the manager's
  // own team) — put the manager's own team in a department they do NOT
  // manage, so scope.teamIds excludes it. Before the fix, this meant a
  // manager could never see their own directory entry.
  const deptC = await axios.post(`${BASE}/departments`, { name: `Smoke Dept C ${Date.now()}` }, adminAuth);
  const deptCId = deptC.data.data.department._id;
  const teamC = await axios.post(`${BASE}/teams`, { name: `Smoke Team C ${Date.now()}`, department: deptCId }, adminAuth);
  const teamCId = teamC.data.data.team._id;

  const manager = await createUser(adminAuth, "manager", { team: teamCId });
  // createUser/updateUser both force managedDepartment to null for any
  // non-subadmin role (see userController.js) — there's no API path today to
  // assign a manager's managedDepartment, so set it directly for this
  // fixture (same pattern as scripts/seed.js).
  await mongoose.connect(process.env.MONGODB_URI);
  await User.findByIdAndUpdate(manager.userId, { managedDepartment: deptAId });
  await mongoose.disconnect();

  const dirManager = await axios.get(`${BASE}/users/directory`, manager.auth);
  assert.ok(
    dirManager.data.data.users.map((u) => u.name).includes(manager.name),
    "a manager whose own team sits outside their managed department still sees themselves in their own directory"
  );

  // --- Task 3: leaderboard's default roster (no ?team=) is department-scoped ---

  const csvA1 = await axios.get(`${BASE}/leaderboard?format=csv`, { ...memberA1.auth, validateStatus: () => true });
  assert.equal(csvA1.status, 403, "a plain member cannot export the csv report (unchanged, pre-existing rule)");

  // createUser forces managedDepartment to null for any non-subadmin role
  // (see userController.js) — same quirk worked around above for the
  // directory-fix fixture; set it directly here too.
  const manager1 = await createUser(adminAuth, "manager", { managedDepartment: deptAId });
  await mongoose.connect(process.env.MONGODB_URI);
  await User.findByIdAndUpdate(manager1.userId, { managedDepartment: deptAId });
  await mongoose.disconnect();

  const csvManagerDefault = await axios.get(`${BASE}/leaderboard?format=csv`, manager1.auth);
  assert.equal(csvManagerDefault.status, 200);
  assert.ok(
    csvManagerDefault.data.includes(memberA1.name) || csvManagerDefault.data.includes(memberA2.name),
    "Department-A manager's default roster includes at least one Department-A member"
  );
  assert.ok(
    !csvManagerDefault.data.includes(memberB.name),
    "Department-A manager's default roster (no ?team=) excludes a Department-B member"
  );

  const csvManagerCrossTeam = await axios.get(
    `${BASE}/leaderboard?format=csv&team=${teamBId}`,
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(csvManagerCrossTeam.status, 403, "a manager cannot use ?team= to reach a team outside their own department");

  console.log("smoke-department-scope: all checks passed");
};

run().catch((error) => {
  console.error("smoke-department-scope failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
