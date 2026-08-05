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

// Covers the visibility boundary for GET /users/:id (team profile page):
// same-department peers are viewable, a different department's member is not.
const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  const deptA = await axios.post(`${BASE}/departments`, { name: `Smoke Profile Dept A ${Date.now()}` }, adminAuth);
  const deptB = await axios.post(`${BASE}/departments`, { name: `Smoke Profile Dept B ${Date.now()}` }, adminAuth);
  const teamA = await axios.post(
    `${BASE}/teams`,
    { name: `Smoke Profile Team A ${Date.now()}`, department: deptA.data.data.department._id },
    adminAuth
  );
  const teamB = await axios.post(
    `${BASE}/teams`,
    { name: `Smoke Profile Team B ${Date.now()}`, department: deptB.data.data.department._id },
    adminAuth
  );

  const memberA = await createUser(adminAuth, "member", { team: teamA.data.data.team._id });
  const memberA2 = await createUser(adminAuth, "member", { team: teamA.data.data.team._id });
  const memberB = await createUser(adminAuth, "member", { team: teamB.data.data.team._id });

  const own = await axios.get(`${BASE}/users/${memberA.userId}`, memberA.auth);
  assert.equal(own.data.data.user.name, memberA.name, "member fetches own profile");

  const peer = await axios.get(`${BASE}/users/${memberA2.userId}`, memberA.auth);
  assert.equal(peer.data.data.user.name, memberA2.name, "same-department peer profile is visible");

  const outOfScope = await axios.get(`${BASE}/users/${memberB.userId}`, {
    ...memberA.auth,
    validateStatus: () => true,
  });
  assert.equal(outOfScope.status, 404, "a different department's member profile is NOT visible");

  const asAdmin = await axios.get(`${BASE}/users/${memberB.userId}`, adminAuth);
  assert.equal(asAdmin.data.data.user.name, memberB.name, "admin can view any profile");

  const missing = await axios.get(`${BASE}/users/000000000000000000000000`, {
    ...adminAuth,
    validateStatus: () => true,
  });
  assert.equal(missing.status, 404, "nonexistent user id returns 404");

  console.log("smoke-user-profile: all checks passed");
};

run().catch((error) => {
  console.error("smoke-user-profile failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
