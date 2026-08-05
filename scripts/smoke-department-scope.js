import assert from "node:assert";
import axios from "axios";
import mongoose from "mongoose";

import User from "../src/models/User.js";
import { getLeaderboard } from "../src/controllers/leaderboardController.js";

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

  // A manager's own `team` has no designed relationship to the team they
  // manage (managedTeam drives scope.teamIds, not the manager's own team) —
  // put the manager's own team in a department they do NOT manage, so
  // scope.teamIds excludes it. Before the fix, this meant a manager could
  // never see their own directory entry.
  const deptC = await axios.post(`${BASE}/departments`, { name: `Smoke Dept C ${Date.now()}` }, adminAuth);
  const deptCId = deptC.data.data.department._id;
  const teamC = await axios.post(`${BASE}/teams`, { name: `Smoke Team C ${Date.now()}`, department: deptCId }, adminAuth);
  const teamCId = teamC.data.data.team._id;

  // Hierarchy fix: manager is now scoped to a single managedTeam (not the
  // whole managedDepartment a sub-admin gets) — set through the real
  // createUser API.
  const manager = await createUser(adminAuth, "manager", { team: teamCId, managedTeam: teamAId });

  const dirManager = await axios.get(`${BASE}/users/directory`, manager.auth);
  assert.ok(
    dirManager.data.data.users.map((u) => u.name).includes(manager.name),
    "a manager whose own team differs from their managed team still sees themselves in their own directory"
  );

  // --- Task 3: leaderboard's default roster (no ?team=) is department-scoped ---

  const csvA1 = await axios.get(`${BASE}/leaderboard?format=csv`, { ...memberA1.auth, validateStatus: () => true });
  assert.equal(csvA1.status, 403, "a plain member cannot export the csv report (unchanged, pre-existing rule)");

  // Hierarchy fix: manager is scoped to a single managedTeam (teamA only —
  // NOT the whole department, which now belongs to sub-admin's scope).
  const manager1 = await createUser(adminAuth, "manager", { managedTeam: teamAId });

  const csvManagerDefault = await axios.get(`${BASE}/leaderboard?format=csv`, manager1.auth);
  assert.equal(csvManagerDefault.status, 200);
  assert.ok(
    csvManagerDefault.data.includes(memberA1.name),
    "Team-A manager's default roster includes their own team's member"
  );
  assert.ok(
    !csvManagerDefault.data.includes(memberA2.name),
    "Team-A manager's default roster excludes a same-department, different-team member (manager scope is one team, not the whole department)"
  );
  assert.ok(
    !csvManagerDefault.data.includes(memberB.name),
    "Team-A manager's default roster (no ?team=) excludes a different department's member"
  );

  const csvManagerCrossTeam = await axios.get(
    `${BASE}/leaderboard?format=csv&team=${teamBId}`,
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(csvManagerCrossTeam.status, 403, "a manager cannot use ?team= to reach a team outside their own department");

  const csvManagerSameDeptOtherTeam = await axios.get(
    `${BASE}/leaderboard?format=csv&team=${teamA2Id}`,
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(
    csvManagerSameDeptOtherTeam.status,
    403,
    "a manager cannot use ?team= to reach a same-department team they don't personally manage"
  );

  // --- fix: a team-less member/sublead's default roster (no ?team=) still
  // includes themselves. Before the fix, resolveDepartmentScope resolved
  // them to { teamIds: [] }, and the roster filter only ever read
  // scope.teamIds, so `team: { $in: [] }` matched nobody — the leaderboard
  // came back completely empty for a team-less member. -------------------
  //
  // Can't reach this over HTTP today: CSV export 403s for member/sublead
  // unconditionally (isReporter gate, see csvA1 above — pre-existing,
  // unrelated to this bug), and the JSON view is Monday-locked (today isn't
  // Monday). So call the real controller in-process against the same
  // MongoDB, faking Date.prototype.getDay() for just this one call to clear
  // the lock — this never touches the live dev server or the CSV gate.

  const memberNoTeam = await createUser(adminAuth, "member");
  await mongoose.connect(process.env.MONGODB_URI);
  const memberNoTeamDoc = await User.findById(memberNoTeam.userId);

  const realGetDay = Date.prototype.getDay;
  Date.prototype.getDay = () => 1; // ponytail: fake "today is Monday", this call only
  let leaderboardResult;
  const fakeRes = {
    status() {
      return this;
    },
    json(payload) {
      leaderboardResult = payload;
      return this;
    },
    setHeader() {},
    send(payload) {
      leaderboardResult = payload;
      return this;
    },
  };
  try {
    await getLeaderboard({ query: {}, user: memberNoTeamDoc }, fakeRes);
  } finally {
    Date.prototype.getDay = realGetDay;
    await mongoose.disconnect();
  }

  assert.ok(
    !leaderboardResult?.data?.locked,
    "faked-Monday in-process call reaches the roster query, not the lock message"
  );
  assert.ok(
    leaderboardResult.data.rows.some((r) => r.user.name === memberNoTeam.name),
    "a team-less member's default roster includes themselves"
  );

  // --- Task 4: departments/teams listing is department-scoped ---

  const deptsAsMemberA = await axios.get(`${BASE}/departments`, memberA1.auth);
  const deptNamesA = deptsAsMemberA.data.data.departments.map((d) => d.name);
  assert.ok(!deptNamesA.includes(deptB.data.data.department.name), "member cannot see Department B in the departments list");

  const teamsAsMemberA = await axios.get(`${BASE}/teams`, memberA1.auth);
  const teamNamesA = teamsAsMemberA.data.data.teams.map((t) => t.name);
  assert.ok(!teamNamesA.includes(teamB.data.data.team.name), "member cannot see Team B (Department B) in the teams list");
  assert.ok(teamNamesA.includes(teamA.data.data.team.name), "member CAN see their own Team A");

  const deptsAsAdmin = await axios.get(`${BASE}/departments`, adminAuth);
  assert.ok(
    deptsAsAdmin.data.data.departments.map((d) => d.name).includes(deptB.data.data.department.name),
    "admin's departments list is unrestricted"
  );

  // --- Task 5: manager requires managedTeam, and is scoped to it ---

  const managerNoTeam = await axios.post(
    `${BASE}/users`,
    { name: "Bad Manager", email: `badmanager+${Date.now()}@wos.local`, password: "smokepass123", role: "manager" },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(managerNoTeam.status, 400, "creating a manager with no managedTeam is rejected");

  const projectA = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Project A ${Date.now()}`, manager: manager1.userId, members: [memberA1.userId] },
    adminAuth
  );
  const projectAId = projectA.data.data.project._id;

  const manager2 = await createUser(adminAuth, "manager", { managedTeam: teamBId });
  const projectB = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Project B ${Date.now()}`, manager: manager2.userId, members: [memberB.userId] },
    adminAuth
  );
  const projectBId = projectB.data.data.project._id;

  const manager1SeesA = await axios.get(`${BASE}/projects/${projectAId}`, { ...manager1.auth, validateStatus: () => true });
  assert.equal(manager1SeesA.status, 200, "Department-A manager can see a Department-A project they manage");

  const manager1SeesB = await axios.get(`${BASE}/projects/${projectBId}`, { ...manager1.auth, validateStatus: () => true });
  assert.equal(manager1SeesB.status, 403, "Department-A manager CANNOT see a Department-B project (was unconditional before this task)");

  const listAsManager1 = await axios.get(`${BASE}/projects?limit=100`, manager1.auth);
  const namesAsManager1 = listAsManager1.data.data.projects.map((p) => p.name);
  assert.ok(namesAsManager1.includes(projectA.data.data.project.name), "manager1's project list includes their own Department-A project");
  assert.ok(!namesAsManager1.includes(projectB.data.data.project.name), "manager1's project list excludes the Department-B project");

  // --- Task 6: createProject validates department for scoped roles ---

  const managerCrossDept = await axios.post(
    `${BASE}/projects`,
    { name: "Should fail cross-dept", manager: manager1.userId, members: [memberB.userId] },
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(managerCrossDept.status, 400, "a Department-A manager cannot create a project with a Department-B member");

  const managerOwnTeam = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Own-Team Project ${Date.now()}`, manager: manager1.userId, members: [memberA1.userId] },
    manager1.auth
  );
  assert.equal(managerOwnTeam.status, 201, "a manager CAN create a project with a member of their own managed team");
  await axios.delete(`${BASE}/projects/${managerOwnTeam.data.data.project._id}`, adminAuth);

  // Hierarchy fix: manager's scope narrowed from the whole department to one
  // team, so a same-department member on a DIFFERENT team is now out of
  // scope too — this used to be allowed back when manager == sub-admin's
  // department-wide reach.
  const managerSameDeptOtherTeam = await axios.post(
    `${BASE}/projects`,
    { name: "Should fail same-dept-different-team", manager: manager1.userId, members: [memberA2.userId] },
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(
    managerSameDeptOtherTeam.status,
    400,
    "a manager cannot create a project with a same-department member outside their one managed team"
  );

  const adminCrossDept = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Cross-Dept Project ${Date.now()}`, manager: manager1.userId, members: [memberB.userId] },
    adminAuth
  );
  assert.equal(adminCrossDept.status, 201, "admin (unrestricted) CAN create a project spanning departments");
  await axios.delete(`${BASE}/projects/${adminCrossDept.data.data.project._id}`, adminAuth);

  // --- Task 7: violations endpoint ---

  const violationsAsMember = await axios.get(`${BASE}/department-violations`, { ...memberA1.auth, validateStatus: () => true });
  assert.equal(violationsAsMember.status, 403, "only admin can read department violations");

  const violationsAsAdmin = await axios.get(`${BASE}/department-violations`, adminAuth);
  assert.equal(violationsAsAdmin.status, 200);
  assert.ok(Array.isArray(violationsAsAdmin.data.data.violations), "violations endpoint returns an array");

  // --- Fix 1: manager's default GET /tasks (no ?project=) is project-scoped,
  // not an unconditional org-wide fast path (was the ["admin","manager"]
  // short-circuit that skipped visibilityFilter entirely) -----------------

  const deptBTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectBId, title: `Smoke Dept B Task ${Date.now()}`, assignees: [memberB.userId] },
    adminAuth
  );
  const deptBTaskId = deptBTask.data.data.task._id;

  const manager1Tasks = await axios.get(`${BASE}/tasks?limit=500`, manager1.auth);
  assert.ok(
    !manager1Tasks.data.data.tasks.some((t) => t._id === deptBTaskId),
    "Department-A manager's unscoped GET /tasks does NOT include a Department-B task (was unconditional org-wide before this fix)"
  );

  // --- Fix 2: admin's ?team= filter on the leaderboard is respected, not
  // silently dropped -------------------------------------------------------

  const adminTeamACsv = await axios.get(`${BASE}/leaderboard?format=csv&team=${teamAId}`, adminAuth);
  assert.ok(adminTeamACsv.data.includes(memberA1.name), "admin's ?team= roster includes a member of that team");
  assert.ok(
    !adminTeamACsv.data.includes(memberA2.name),
    "admin's ?team= roster excludes a same-department member of a DIFFERENT team (proves team-, not department-, narrowing)"
  );
  assert.ok(!adminTeamACsv.data.includes(memberB.name), "admin's ?team= roster excludes a different department's member");

  // --- Fix 4: updateProject enforces the same department boundary as
  // createProject, so a manager can't bypass Task 6's scoping with a PATCH -

  const fix4Project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Fix4 Project ${Date.now()}`, manager: manager1.userId, members: [memberA1.userId] },
    manager1.auth
  );
  const fix4ProjectId = fix4Project.data.data.project._id;

  const fix4PatchCrossDept = await axios.patch(
    `${BASE}/projects/${fix4ProjectId}`,
    { members: [memberA1.userId, memberB.userId] },
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(fix4PatchCrossDept.status, 400, "a Department-A manager cannot PATCH a project to add a Department-B member");
  assert.ok(
    fix4PatchCrossDept.data.message.includes("outside your department"),
    "the PATCH rejection uses the same 'outside your department' message as createProject"
  );

  const fix4PatchAdmin = await axios.patch(
    `${BASE}/projects/${fix4ProjectId}`,
    { members: [memberA1.userId, memberB.userId] },
    adminAuth
  );
  assert.equal(fix4PatchAdmin.status, 200, "admin (unrestricted) CAN PATCH a project to add a cross-department member");
  await axios.delete(`${BASE}/projects/${fix4ProjectId}`, adminAuth);

  // --- Fix (round 2, regression): updateProject must not re-validate the
  // RESULTING manager/members when the request doesn't touch those fields.
  // A legacy project that already spans departments (the exact population
  // the migration flags into DepartmentViolation) must still allow a
  // status-only edit by its own manager. Build that legacy shape directly
  // via admin (unrestricted), bypassing manager1's own createProject scoping.

  const legacyProject = await axios.post(
    `${BASE}/projects`,
    {
      name: `Smoke Legacy Cross-Dept Project ${Date.now()}`,
      manager: manager1.userId,
      members: [memberA1.userId, memberB.userId],
    },
    adminAuth
  );
  const legacyProjectId = legacyProject.data.data.project._id;

  const legacyStatusOnlyPatch = await axios.patch(
    `${BASE}/projects/${legacyProjectId}`,
    { status: "active" },
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(
    legacyStatusOnlyPatch.status,
    200,
    "a manager can status-only PATCH a legacy project that already has an out-of-scope member, as long as the PATCH doesn't touch manager/members"
  );

  const legacyAddOutOfScope = await axios.patch(
    `${BASE}/projects/${legacyProjectId}`,
    { members: [memberA1.userId, memberB.userId] },
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(
    legacyAddOutOfScope.status,
    400,
    "a manager PATCHing with members explicitly in the request body still 400s when it contains an out-of-scope id (the check still fires when members is actually present)"
  );

  await axios.delete(`${BASE}/projects/${legacyProjectId}`, adminAuth);

  // --- Fix (round 2, leak): globalSearch's user-search branch must be
  // department-scoped the same way /users/directory already is -----------

  const searchAsMemberA1 = await axios.get(
    `${BASE}/search?q=${encodeURIComponent(memberB.name)}`,
    memberA1.auth
  );
  assert.ok(
    !searchAsMemberA1.data.data.users.some((u) => u.name === memberB.name),
    "a Department-A member's search does not return a Department-B user"
  );

  const searchAsMemberA1Own = await axios.get(
    `${BASE}/search?q=${encodeURIComponent(memberA2.name)}`,
    memberA1.auth
  );
  assert.ok(
    searchAsMemberA1Own.data.data.users.some((u) => u.name === memberA2.name),
    "a Department-A member's search still returns a same-department user"
  );

  const searchAsAdmin = await axios.get(`${BASE}/search?q=${encodeURIComponent(memberB.name)}`, adminAuth);
  assert.ok(
    searchAsAdmin.data.data.users.some((u) => u.name === memberB.name),
    "admin's search remains unrestricted"
  );

  // --- Fix 7: updateComment's moderator privilege is project-scoped, not
  // unconditional org-wide -------------------------------------------------

  const addCommentRes = await axios.post(`${BASE}/tasks/${deptBTaskId}/comments`, { text: "Dept B comment" }, memberB.auth);
  const deptBCommentId = addCommentRes.data.data.task.comments.at(-1)._id;

  const manager1EditsDeptBComment = await axios.patch(
    `${BASE}/tasks/${deptBTaskId}/comments/${deptBCommentId}`,
    { text: "hijacked" },
    { ...manager1.auth, validateStatus: () => true }
  );
  assert.equal(
    manager1EditsDeptBComment.status,
    403,
    "a Department-A manager cannot use moderator privilege to edit a comment on a Department-B task"
  );

  console.log("smoke-department-scope: all checks passed");
};

run().catch((error) => {
  console.error("smoke-department-scope failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
