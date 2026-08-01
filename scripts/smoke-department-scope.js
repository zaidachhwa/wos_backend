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

  console.log("smoke-department-scope: all checks passed");
};

run().catch((error) => {
  console.error("smoke-department-scope failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
