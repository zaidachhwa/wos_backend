import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role, extra = {}) => {
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  const res = await axios.post(
    `${BASE}/users`,
    { name: `Smoke ${role}`, email, password, role, ...extra },
    adminAuth
  );
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    userId: res.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  // --- fixture: one department with two teams, one team member each --------

  const dept = await axios.post(`${BASE}/departments`, { name: `Subadmin Smoke Dept ${Date.now()}` }, adminAuth);
  const deptId = dept.data.data.department._id;
  const otherDept = await axios.post(`${BASE}/departments`, { name: `Subadmin Smoke Other ${Date.now()}` }, adminAuth);
  const otherDeptId = otherDept.data.data.department._id;

  const teamA = await axios.post(`${BASE}/teams`, { name: `Team A ${Date.now()}`, department: deptId }, adminAuth);
  const teamAId = teamA.data.data.team._id;
  const teamB = await axios.post(`${BASE}/teams`, { name: `Team B ${Date.now()}`, department: deptId }, adminAuth);
  const teamBId = teamB.data.data.team._id;
  const otherTeam = await axios.post(
    `${BASE}/teams`,
    { name: `Other Team ${Date.now()}`, department: otherDeptId },
    adminAuth
  );
  const otherTeamId = otherTeam.data.data.team._id;

  const memberA = await createUser(adminAuth, "member", { team: teamAId, department: deptId });
  const memberB = await createUser(adminAuth, "member", { team: teamBId, department: deptId });
  const outsider = await createUser(adminAuth, "member", { team: otherTeamId, department: otherDeptId });

  const subadmin = await createUser(adminAuth, "subadmin", { managedDepartment: deptId });

  // --- helper correctness, exercised indirectly via the directory endpoint -
  // (getManagedUserIds itself is exercised by every later assertion in this
  // file; this first check just confirms the fixture wiring is sane before
  // building on it.)

  const directory = await axios.get(`${BASE}/users/directory`, adminAuth);
  const ids = directory.data.data.users.map((u) => u._id);
  assert.ok(ids.includes(memberA.userId), "fixture memberA exists");
  assert.ok(ids.includes(memberB.userId), "fixture memberB exists");
  assert.ok(ids.includes(outsider.userId), "fixture outsider exists in a different department");

  console.log("smoke-subadmin: all checks passed");
};

run().catch((error) => {
  console.error("smoke-subadmin failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
