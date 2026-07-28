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

  // --- subadmin: list is restricted to managed department's users ----------

  const listAsSubadmin = await axios.get(`${BASE}/users`, subadmin.auth);
  assert.equal(listAsSubadmin.status, 200, "subadmin can list users");
  const listedIds = listAsSubadmin.data.data.users.map((u) => String(u._id));
  assert.ok(listedIds.includes(memberA.userId), "subadmin's list includes memberA (their department)");
  assert.ok(!listedIds.includes(outsider.userId), "subadmin's list excludes outsider (different department)");
  assert.ok(!listedIds.some((id) => id === String(subadmin.userId)), "subadmin's list excludes admin/subadmin accounts")

  // --- subadmin: create user in a managed team OK, outside team forbidden --

  const createInScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Subadmin-created",
      email: `subadmincreated+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamAId,
    },
    subadmin.auth
  );
  assert.equal(createInScope.status, 201, "subadmin creates a user on their own managed team");

  const createOutOfScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Should fail",
      email: `shouldfail+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: otherTeamId,
    },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(createOutOfScope.status, 403, "subadmin cannot create a user on a team outside their department");

  const createAdminForbidden = await axios.post(
    `${BASE}/users`,
    {
      name: "Should fail",
      email: `shouldfail2+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "admin",
      team: teamAId,
    },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(createAdminForbidden.status, 403, "subadmin cannot create a user with role admin");

  // --- subadmin: update/deactivate in scope OK, out of scope forbidden -----

  const updateInScope = await axios.patch(
    `${BASE}/users/${memberA.userId}`,
    { designation: "Updated by subadmin" },
    subadmin.auth
  );
  assert.equal(updateInScope.status, 200, "subadmin updates a user in their managed department");

  const updateOutOfScope = await axios.patch(
    `${BASE}/users/${outsider.userId}`,
    { designation: "Should fail" },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(updateOutOfScope.status, 404, "subadmin cannot update a user outside their department");

  const updateAdminForbidden = await axios.patch(
    `${BASE}/users/${subadmin.userId}`,
    { designation: "Should fail" },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(updateAdminForbidden.status, 403, "subadmin cannot update another subadmin's own account");

  const moveOutOfManagedTeam = await axios.patch(
    `${BASE}/users/${memberA.userId}`,
    { team: otherTeamId },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(moveOutOfManagedTeam.status, 403, "subadmin cannot move a user to a team outside their department");

  const nullTeamAttempt = await axios.patch(
    `${BASE}/users/${memberA.userId}`,
    { team: null },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(nullTeamAttempt.status, 403, "subadmin cannot null out a managed user's team");

  const departmentAttempt = await axios.patch(
    `${BASE}/users/${memberA.userId}`,
    { department: otherDeptId },
    subadmin.auth
  );
  assert.equal(departmentAttempt.status, 200, "subadmin's department update request still succeeds (field is silently dropped)");
  assert.equal(
    String(departmentAttempt.data.data.user.department),
    String(deptId),
    "subadmin cannot change a managed user's department"
  );

  const reportingManagerAttempt = await axios.patch(
    `${BASE}/users/${memberA.userId}`,
    { reportingManager: subadmin.userId },
    subadmin.auth
  );
  assert.equal(
    reportingManagerAttempt.status,
    200,
    "subadmin's reportingManager update request still succeeds (field is silently dropped)"
  );
  assert.equal(
    reportingManagerAttempt.data.data.user.reportingManager,
    null,
    "subadmin cannot set a managed user's reportingManager"
  );

  const deactivateOutOfScope = await axios.delete(`${BASE}/users/${outsider.userId}`, {
    ...subadmin.auth,
    validateStatus: () => true,
  });
  assert.equal(deactivateOutOfScope.status, 404, "subadmin cannot deactivate a user outside their department");

  const deactivateInScope = await axios.delete(`${BASE}/users/${memberB.userId}`, subadmin.auth);
  assert.equal(deactivateInScope.status, 200, "subadmin deactivates a user in their managed department");

  // --- managedDepartment is required when creating a subadmin --------------

  const subadminMissingDept = await axios.post(
    `${BASE}/users`,
    {
      name: "Should fail",
      email: `subadminnodept+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "subadmin",
    },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(subadminMissingDept.status, 400, "creating a subadmin without managedDepartment is rejected");

  console.log("smoke-subadmin: all checks passed");
};

run().catch((error) => {
  console.error("smoke-subadmin failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
