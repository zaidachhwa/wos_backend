import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const run = async () => {
  const login = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  const auth = { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };

  const memberEmail = `orgmember+${Date.now()}@wos.local`;
  await axios.post(
    `${BASE}/users`,
    { name: "Org Member", email: memberEmail, password: "memberpass123", role: "member" },
    auth
  );
  const memberLogin = await axios.post(`${BASE}/auth/login`, {
    email: memberEmail,
    password: "memberpass123",
  });
  const memberAuth = { headers: { Authorization: `Bearer ${memberLogin.data.data.accessToken}` } };

  // Departments
  const dept = await axios.post(`${BASE}/departments`, { name: `Engineering ${Date.now()}` }, auth);
  assert.equal(dept.status, 201, "admin creates department");
  const deptId = dept.data.data.department._id;

  const deptMissingName = await axios.post(
    `${BASE}/departments`,
    {},
    { ...auth, validateStatus: () => true }
  );
  assert.equal(deptMissingName.status, 400, "department create requires name");

  const deptForbidden = await axios.post(
    `${BASE}/departments`,
    { name: "Should fail" },
    { ...memberAuth, validateStatus: () => true }
  );
  assert.equal(deptForbidden.status, 403, "member cannot create department");

  const deptListMember = await axios.get(`${BASE}/departments`, memberAuth);
  assert.equal(deptListMember.status, 200, "member can list departments");

  const deptUpdated = await axios.patch(
    `${BASE}/departments/${deptId}`,
    { name: "Engineering Updated" },
    auth
  );
  assert.equal(deptUpdated.data.data.department.name, "Engineering Updated", "admin updates department");

  // Teams
  const team = await axios.post(
    `${BASE}/teams`,
    { name: `Backend ${Date.now()}`, department: deptId },
    auth
  );
  assert.equal(team.status, 201, "admin creates team");
  const teamId = team.data.data.team._id;

  const teamBadDept = await axios.post(
    `${BASE}/teams`,
    { name: "Bad", department: "000000000000000000000000" },
    { ...auth, validateStatus: () => true }
  );
  assert.equal(teamBadDept.status, 400, "team create requires existing department");

  const teamForbidden = await axios.post(
    `${BASE}/teams`,
    { name: "Should fail", department: deptId },
    { ...memberAuth, validateStatus: () => true }
  );
  assert.equal(teamForbidden.status, 403, "member cannot create team");

  const teamListMember = await axios.get(`${BASE}/teams`, memberAuth);
  assert.equal(teamListMember.status, 200, "member can list teams");

  const teamUpdated = await axios.patch(`${BASE}/teams/${teamId}`, { name: "Backend Updated" }, auth);
  assert.equal(teamUpdated.data.data.team.name, "Backend Updated", "admin updates team");

  // Directory (any authenticated role, no email/password)
  const directory = await axios.get(`${BASE}/users/directory`, memberAuth);
  assert.equal(directory.status, 200, "member can view directory");
  const users = directory.data.data.users;
  assert.ok(users.length > 0, "directory returns users");
  for (const u of users) {
    assert.equal(u.email, undefined, "directory hides email");
    assert.equal(u.password, undefined, "directory hides password");
  }

  // Cleanup (admin deletes)
  const teamDelete = await axios.delete(`${BASE}/teams/${teamId}`, auth);
  assert.equal(teamDelete.status, 200, "admin deletes team");

  const deptDelete = await axios.delete(`${BASE}/departments/${deptId}`, auth);
  assert.equal(deptDelete.status, 200, "admin deletes department");

  console.log("smoke-org: all checks passed");
};

run().catch((error) => {
  console.error("smoke-org failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
