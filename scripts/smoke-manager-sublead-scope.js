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

  // --- access rules: only Director (not manager/subadmin/sublead) may
  // assign a task to hr — the directory (task-assignee picker source) must
  // hide hr from everyone except director (and admin, unscoped already) ---

  const hrUser = await createUser(adminAuth, "hr");
  const director = await createUser(adminAuth, "director");

  const mgrDirectory = await axios.get(`${BASE}/users/directory`, manager.auth);
  assert.ok(
    !mgrDirectory.data.data.users.some((u) => u._id === hrUser.userId),
    "a manager's directory excludes hr — only Director can assign tasks to hr"
  );

  const dirDirectory = await axios.get(`${BASE}/users/directory`, director.auth);
  assert.ok(
    dirDirectory.data.data.users.some((u) => u._id === hrUser.userId),
    "a director's directory includes hr despite hr having no team"
  );

  // --- "HR can see all Tasks and Followups" — org-wide, like admin; Director
  // deliberately does NOT get this (access rules: Director "can't see Tasks
  // and Followups of Teams") ---

  const hrProject = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke HR Visibility ${Date.now()}`, manager: manager.userId },
    manager.auth
  );
  const hrProjectId = hrProject.data.data.project._id;
  const hrTask = await axios.post(
    `${BASE}/tasks`,
    { project: hrProjectId, title: "HR visibility task", assignees: [manager.userId], priority: "low" },
    manager.auth
  );
  const hrTaskId = hrTask.data.data.task._id;

  const hrGetsTask = await axios.get(`${BASE}/tasks/${hrTaskId}`, hrUser.auth);
  assert.equal(hrGetsTask.status, 200, "hr can view a task in a project they're not a member of");

  const hrListTasks = await axios.get(`${BASE}/tasks?project=${hrProjectId}`, hrUser.auth);
  assert.ok(
    hrListTasks.data.data.tasks.some((t) => t._id === hrTaskId),
    "hr's task list includes a task from an unrelated project"
  );

  const dirGetsTask = await axios.get(
    `${BASE}/tasks/${hrTaskId}`,
    { ...director.auth, validateStatus: () => true }
  );
  assert.equal(dirGetsTask.status, 403, "director does NOT get org-wide task visibility, unlike hr");

  const mgrEditsOwn = await axios.patch(`${BASE}/users/${mgrHireId}`, { designation: "Engineer" }, manager.auth);
  assert.equal(mgrEditsOwn.status, 200, "manager edits a member on their own team");

  const mgrEditsOwnShift = await axios.patch(
    `${BASE}/users/${mgrHireId}`,
    { shiftStart: "09:30", shiftEnd: "18:30" },
    manager.auth
  );
  assert.equal(mgrEditsOwnShift.status, 200, "manager sets shift timing for a member on their own team");
  assert.equal(mgrEditsOwnShift.data.data.user.shiftStart, "09:30");
  assert.equal(mgrEditsOwnShift.data.data.user.shiftEnd, "18:30");

  const mgrEditsOther = await axios.patch(
    `${BASE}/users/${memberA2.userId}`,
    { designation: "Nope" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(mgrEditsOther.status, 404, "manager cannot edit a different team's member");

  const mgrEditsOtherShift = await axios.patch(
    `${BASE}/users/${memberA2.userId}`,
    { shiftStart: "09:00", shiftEnd: "17:00" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(mgrEditsOtherShift.status, 404, "manager cannot set shift timing for a different team's member");

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
