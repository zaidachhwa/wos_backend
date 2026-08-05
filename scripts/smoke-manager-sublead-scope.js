import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (actorAuth, role, extra = {}) => {
  const name = `Smoke ${role} ${Math.random().toString(36).slice(2, 6)}`;
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  const res = await axios.post(`${BASE}/users`, { name, email, password, role, ...extra }, actorAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    name,
    userId: res.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

// Covers the manager/sub-lead hierarchy fix: a manager manages exactly one
// team (managedTeam), a sub-lead can manage several (managedTeams), and
// both can now create/edit/deactivate *member*-role accounts within that
// scope — where before, manager had zero user-management capability and
// sub-lead didn't exist as a management role at all.
const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  const dept = await axios.post(`${BASE}/departments`, { name: `Smoke Hierarchy Dept ${Date.now()}` }, adminAuth);
  const deptId = dept.data.data.department._id;
  const teamA1 = await axios.post(`${BASE}/teams`, { name: `Smoke A1 ${Date.now()}`, department: deptId }, adminAuth);
  const teamA2 = await axios.post(`${BASE}/teams`, { name: `Smoke A2 ${Date.now()}`, department: deptId }, adminAuth);
  const teamA1Id = teamA1.data.data.team._id;
  const teamA2Id = teamA2.data.data.team._id;

  const deptB = await axios.post(`${BASE}/departments`, { name: `Smoke Hierarchy Dept B ${Date.now()}` }, adminAuth);
  const teamB1 = await axios.post(
    `${BASE}/teams`,
    { name: `Smoke B1 ${Date.now()}`, department: deptB.data.data.department._id },
    adminAuth
  );
  const teamB1Id = teamB1.data.data.team._id;

  // --- Creating a manager without managedTeam is rejected ---
  const badManager = await axios.post(
    `${BASE}/users`,
    { name: "Bad Mgr", email: `badmgr+${Date.now()}@wos.local`, password: "smokepass123", role: "manager" },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(badManager.status, 400, "manager without managedTeam is rejected");

  const manager = await createUser(adminAuth, "manager", { managedTeam: teamA1Id });
  const sublead = await createUser(adminAuth, "sublead", { managedTeams: [teamA1Id, teamA2Id] });
  const memberA2 = await createUser(adminAuth, "member", { team: teamA2Id });

  // --- Manager: scoped to exactly their one team ---

  const mgrCreatesInScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Mgr Hire",
      email: `mgrhire+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamA1Id,
    },
    manager.auth
  );
  assert.equal(mgrCreatesInScope.status, 201, "manager creates a member in their own team");
  assert.equal(
    String(mgrCreatesInScope.data.data.user.department),
    String(deptId),
    "new member's department is auto-derived from the team"
  );
  const mgrHireId = mgrCreatesInScope.data.data.user._id;

  const mgrCreatesOutOfScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Mgr Overreach",
      email: `mgroverreach+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamA2Id,
    },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(mgrCreatesOutOfScope.status, 403, "manager cannot place a new member on a team they don't manage");

  const mgrCreatesSublead = await axios.post(
    `${BASE}/users`,
    {
      name: "Mgr Promotes",
      email: `mgrpromotes+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "sublead",
      team: teamA1Id,
    },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(mgrCreatesSublead.status, 403, "manager cannot create a sub-lead account");

  const mgrList = await axios.get(`${BASE}/users`, manager.auth);
  const mgrListNames = mgrList.data.data.users.map((u) => u.name);
  assert.ok(mgrListNames.includes("Mgr Hire"), "manager's user list includes their own team's new hire");
  assert.ok(!mgrListNames.includes(memberA2.name), "manager's user list excludes a different team's member");

  const mgrEditsOwn = await axios.patch(`${BASE}/users/${mgrHireId}`, { designation: "Engineer" }, manager.auth);
  assert.equal(mgrEditsOwn.status, 200, "manager edits a member on their own team");

  const mgrEditsOther = await axios.patch(
    `${BASE}/users/${memberA2.userId}`,
    { designation: "Nope" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(mgrEditsOther.status, 404, "manager cannot edit a different team's member");

  const mgrDeactivatesOwn = await axios.delete(`${BASE}/users/${mgrHireId}`, manager.auth);
  assert.equal(mgrDeactivatesOwn.status, 200, "manager deactivates a member on their own team");

  // --- Sub-lead: scoped to several explicitly-assigned teams ---

  const subleadCreatesInA1 = await axios.post(
    `${BASE}/users`,
    {
      name: "Sublead Hire A1",
      email: `subleadhirea1+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamA1Id,
    },
    sublead.auth
  );
  assert.equal(subleadCreatesInA1.status, 201, "sub-lead creates a member in the first of their managed teams");

  const subleadCreatesInA2 = await axios.post(
    `${BASE}/users`,
    {
      name: "Sublead Hire A2",
      email: `subleadhirea2+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamA2Id,
    },
    sublead.auth
  );
  assert.equal(subleadCreatesInA2.status, 201, "sub-lead creates a member in the second of their managed teams");

  const subleadCreatesInB1 = await axios.post(
    `${BASE}/users`,
    {
      name: "Sublead Overreach",
      email: `subleadoverreach+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamB1Id,
    },
    { ...sublead.auth, validateStatus: () => true }
  );
  assert.equal(subleadCreatesInB1.status, 403, "sub-lead cannot place a member on an unmanaged team");

  const subleadList = await axios.get(`${BASE}/users`, sublead.auth);
  const subleadListNames = subleadList.data.data.users.map((u) => u.name);
  assert.ok(subleadListNames.includes("Sublead Hire A1") && subleadListNames.includes("Sublead Hire A2"), "sub-lead's list spans both managed teams");

  console.log("smoke-manager-sublead-scope: all checks passed");
};

run().catch((error) => {
  console.error("smoke-manager-sublead-scope failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
