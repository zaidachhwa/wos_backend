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

  // --- subadmin: team CRUD scoped to their managed department --------------

  const teamCreateInScope = await axios.post(
    `${BASE}/teams`,
    { name: `Subadmin Team ${Date.now()}`, department: deptId },
    subadmin.auth
  );
  assert.equal(teamCreateInScope.status, 201, "subadmin creates a team in their managed department");
  const subadminTeamId = teamCreateInScope.data.data.team._id;

  const teamCreateOutOfScope = await axios.post(
    `${BASE}/teams`,
    { name: "Should fail", department: otherDeptId },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(teamCreateOutOfScope.status, 403, "subadmin cannot create a team in a different department");

  const teamUpdateInScope = await axios.patch(
    `${BASE}/teams/${subadminTeamId}`,
    { name: "Renamed by subadmin" },
    subadmin.auth
  );
  assert.equal(teamUpdateInScope.status, 200, "subadmin renames a team in their managed department");

  // --- adversarial: falsy department values must not bypass the scope check
  // (Task 2 had a `req.body.team &&` truthy-check bypass on null/""/0; confirm
  // the equivalent `req.body.department` check here is gated on presence, not
  // truthiness.)

  for (const badValue of [null, "", 0, false]) {
    const falsyDeptAttempt = await axios.patch(
      `${BASE}/teams/${subadminTeamId}`,
      { department: badValue },
      { ...subadmin.auth, validateStatus: () => true }
    );
    assert.equal(
      falsyDeptAttempt.status,
      403,
      `subadmin cannot set department to falsy value ${JSON.stringify(badValue)} on a managed team`
    );
  }

  const teamUpdateOutOfScope = await axios.patch(
    `${BASE}/teams/${otherTeamId}`,
    { name: "Should fail" },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(teamUpdateOutOfScope.status, 404, "subadmin cannot update a team in a different department");

  const teamDeleteOutOfScope = await axios.delete(`${BASE}/teams/${otherTeamId}`, {
    ...subadmin.auth,
    validateStatus: () => true,
  });
  assert.equal(teamDeleteOutOfScope.status, 404, "subadmin cannot delete a team in a different department");

  const teamDeleteInScope = await axios.delete(`${BASE}/teams/${subadminTeamId}`, subadmin.auth);
  assert.equal(teamDeleteInScope.status, 200, "subadmin deletes a team in their managed department");

  // --- subadmin: Department CRUD stays forbidden ----------------------------

  const deptCreateForbidden = await axios.post(
    `${BASE}/departments`,
    { name: "Should fail" },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(deptCreateForbidden.status, 403, "subadmin cannot create a department");

  const deptDeleteForbidden = await axios.delete(`${BASE}/departments/${deptId}`, {
    ...subadmin.auth,
    validateStatus: () => true,
  });
  assert.equal(deptDeleteForbidden.status, 403, "subadmin cannot delete their own managed department");

  // --- subadmin: project visibility follows manager/member overlap ---------

  const projectInScope = await axios.post(
    `${BASE}/projects`,
    { name: `Subadmin Smoke Project ${Date.now()}`, manager: memberA.userId, type: "internal" },
    subadmin.auth
  );
  assert.equal(projectInScope.status, 201, "subadmin creates a project managed by memberA (in scope)");
  const projectInScopeId = projectInScope.data.data.project._id;

  const projectOutOfScope = await axios.post(
    `${BASE}/projects`,
    { name: `Outside Project ${Date.now()}`, manager: outsider.userId, type: "internal" },
    adminAuth
  );
  const projectOutOfScopeId = projectOutOfScope.data.data.project._id;

  const projectListAsSubadmin = await axios.get(`${BASE}/projects`, subadmin.auth);
  const visibleProjectIds = projectListAsSubadmin.data.data.projects.map((p) => String(p._id));
  assert.ok(visibleProjectIds.includes(String(projectInScopeId)), "subadmin sees the in-scope project");
  assert.ok(!visibleProjectIds.includes(String(projectOutOfScopeId)), "subadmin does not see the out-of-scope project");

  const getOutOfScopeProject = await axios.get(`${BASE}/projects/${projectOutOfScopeId}`, {
    ...subadmin.auth,
    validateStatus: () => true,
  });
  assert.equal(getOutOfScopeProject.status, 403, "subadmin is forbidden from fetching the out-of-scope project directly");

  // --- subadmin: task creation/visibility follows the same project scope ---

  const taskInScope = await axios.post(
    `${BASE}/tasks`,
    { project: projectInScopeId, title: "Subadmin smoke task", assignees: [memberA.userId] },
    subadmin.auth
  );
  assert.equal(taskInScope.status, 201, "subadmin creates a task in an in-scope project");

  const taskOutOfScope = await axios.post(
    `${BASE}/tasks`,
    { project: projectOutOfScopeId, title: "Should fail", assignees: [outsider.userId] },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(taskOutOfScope.status, 403, "subadmin cannot create a task in an out-of-scope project");

  // --- fix: canViewProject's module/task fallback must use the same
  // managed-user-set as visibilityFilter, not bare user._id (Critical finding)
  // A project managed by an outsider gets a task assigned to memberA (someone
  // the subadmin manages). visibilityFilter already put this project in the
  // subadmin's list via the task-assignment fallback; canViewProject must now
  // agree and allow the direct fetch too, instead of 403ing.

  const taskInOutOfScopeProject = await axios.post(
    `${BASE}/tasks`,
    { project: projectOutOfScopeId, title: "Assigned to managed user", assignees: [memberA.userId] },
    adminAuth
  );
  assert.equal(taskInOutOfScopeProject.status, 201, "admin assigns a task in the out-of-scope project to memberA");

  const listAfterTaskAssign = await axios.get(`${BASE}/projects`, subadmin.auth);
  const visibleIdsAfterTaskAssign = listAfterTaskAssign.data.data.projects.map((p) => String(p._id));
  assert.ok(
    visibleIdsAfterTaskAssign.includes(String(projectOutOfScopeId)),
    "subadmin's list now includes the out-of-scope project via memberA's task assignment"
  );

  const getOutOfScopeProjectAfterAssign = await axios.get(`${BASE}/projects/${projectOutOfScopeId}`, subadmin.auth);
  assert.equal(
    getOutOfScopeProjectAfterAssign.status,
    200,
    "subadmin can now fetch the project directly too (list and detail agree)"
  );

  // --- fix: a subadmin's own managed/created project must appear in their
  // own list, not just be directly fetchable (Important finding)
  // scopeIds for visibilityFilter must include the subadmin's own _id, not
  // just their managed-user-set (which deliberately excludes admin/subadmin).

  const projectSelfManaged = await axios.post(
    `${BASE}/projects`,
    { name: `Subadmin Self-Managed Project ${Date.now()}`, manager: subadmin.userId, type: "internal" },
    subadmin.auth
  );
  assert.equal(projectSelfManaged.status, 201, "subadmin creates a project they themselves manage");
  const projectSelfManagedId = projectSelfManaged.data.data.project._id;

  const listWithSelfManaged = await axios.get(`${BASE}/projects`, subadmin.auth);
  const visibleIdsWithSelfManaged = listWithSelfManaged.data.data.projects.map((p) => String(p._id));
  assert.ok(
    visibleIdsWithSelfManaged.includes(String(projectSelfManagedId)),
    "subadmin's own managed project appears in their own project list"
  );

  const getSelfManagedProject = await axios.get(`${BASE}/projects/${projectSelfManagedId}`, subadmin.auth);
  assert.equal(getSelfManagedProject.status, 200, "subadmin can also fetch their own managed project directly");

  // --- subadmin: dashboard "reports" is the managed-user-set ---------------

  const dashboardAsSubadmin = await axios.get(`${BASE}/dashboard`, subadmin.auth);
  assert.equal(dashboardAsSubadmin.status, 200, "subadmin fetches their dashboard");
  const dashboardReportIds = dashboardAsSubadmin.data.data.workload.map((w) => String(w.user._id));
  assert.ok(dashboardReportIds.includes(memberA.userId), "subadmin's dashboard workload includes memberA");
  assert.ok(!dashboardReportIds.includes(outsider.userId), "subadmin's dashboard workload excludes outsider");

  // --- subadmin: team report is scoped to the managed department -----------

  const today = new Date().toISOString().slice(0, 10);
  const reportAsSubadmin = await axios.get(
    `${BASE}/reports/team?from=${today}&to=${today}`,
    subadmin.auth
  );
  assert.equal(reportAsSubadmin.status, 200, "subadmin fetches the team report");
  const reportUserIds = reportAsSubadmin.data.data.rows.map((r) => String(r.user._id));
  assert.ok(reportUserIds.includes(memberA.userId), "subadmin's report includes memberA");
  assert.ok(!reportUserIds.includes(outsider.userId), "subadmin's report excludes outsider");

  // --- subadmin: leaderboard roster restricted to the managed department ---

  const leaderboardAsSubadmin = await axios.get(`${BASE}/leaderboard`, subadmin.auth);
  assert.equal(leaderboardAsSubadmin.status, 200, "subadmin fetches the leaderboard");
  if (!leaderboardAsSubadmin.data.data.locked) {
    const rosterIds = leaderboardAsSubadmin.data.data.rows.map((r) => String(r.user._id));
    assert.ok(rosterIds.includes(memberA.userId), "subadmin's leaderboard roster includes memberA");
    assert.ok(!rosterIds.includes(outsider.userId), "subadmin's leaderboard roster excludes outsider");
  }

  const leaderboardTeamOutOfScope = await axios.get(`${BASE}/leaderboard?team=${otherTeamId}`, {
    ...subadmin.auth,
    validateStatus: () => true,
  });
  assert.ok(
    [200, 403].includes(leaderboardTeamOutOfScope.status) &&
      (leaderboardTeamOutOfScope.status !== 200 || leaderboardTeamOutOfScope.data.data.locked),
    "subadmin cannot use ?team= to view a team outside their department"
  );

  // --- subadmin: AI workload analysis is reachable (scoping is internal to
  // the prompt context sent to Gemini, not independently observable from the
  // response text — this just confirms the route/role-gate wiring is correct) --

  const workloadAsSubadmin = await axios.post(
    `${BASE}/ai/workload`,
    {},
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.ok(
    [200, 503].includes(workloadAsSubadmin.status),
    "subadmin can reach the AI workload endpoint (200 if Gemini is configured, 503 if AI isn't configured — both prove the role gate didn't 403)"
  );

  // --- subadmin: can act for a managed user, not for an outsider -----------

  const iso = (offsetHours) => new Date(Date.now() + offsetHours * 3600 * 1000).toISOString();

  const timeBlockInScope = await axios.post(
    `${BASE}/timeblocks`,
    { title: "Subadmin-created block", start: iso(1), end: iso(2), category: "meeting", user: memberA.userId },
    subadmin.auth
  );
  assert.equal(timeBlockInScope.status, 201, "subadmin creates a time block for a managed user");

  const timeBlockOutOfScope = await axios.post(
    `${BASE}/timeblocks`,
    { title: "Should fail", start: iso(1), end: iso(2), category: "meeting", user: outsider.userId },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(timeBlockOutOfScope.status, 403, "subadmin cannot create a time block for an outsider");

  // --- hierarchy fix: subadmin CAN assign/promote to role "manager", since
  // manager is now scoped to a single managedTeam (not company-wide) — but
  // only within the subadmin's own managed department.

  const createManagerInScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Subadmin-appointed manager",
      email: `subadminmgr+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "manager",
      team: teamAId,
      managedTeam: teamAId,
    },
    subadmin.auth
  );
  assert.equal(createManagerInScope.status, 201, "subadmin creates a manager whose managedTeam is in their department");

  const createManagerOutOfScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Should fail",
      email: `shouldfailmgr+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "manager",
      team: teamAId,
      managedTeam: otherTeamId,
    },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(
    createManagerOutOfScope.status,
    403,
    "subadmin cannot appoint a manager over a team outside their department"
  );

  // Dedicated fixture (not memberA/memberB — both are reused heavily further
  // down this file) so promoting it to manager can't affect later assertions.
  const promoteCandidate = await createUser(adminAuth, "member", { team: teamAId, department: deptId });
  const updateToManagerInScope = await axios.patch(
    `${BASE}/users/${promoteCandidate.userId}`,
    { role: "manager", managedTeam: teamBId },
    subadmin.auth
  );
  assert.equal(
    updateToManagerInScope.status,
    200,
    "subadmin promotes an in-scope member to manager over another in-department team"
  );

  const updateToManagerOutOfScope = await axios.patch(
    `${BASE}/users/${memberB.userId}`,
    { role: "manager", managedTeam: otherTeamId },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(
    updateToManagerOutOfScope.status,
    403,
    "subadmin cannot promote a member to manager over a team outside their department"
  );

  const subadminEditsManagerDesignation = await axios.patch(
    `${BASE}/users/${createManagerInScope.data.data.user._id}`,
    { designation: "Team Lead" },
    subadmin.auth
  );
  assert.equal(
    subadminEditsManagerDesignation.status,
    200,
    "subadmin edits a manager already within their department"
  );

  // --- fix: subadmin cannot attach a new user's reportingManager to an
  // out-of-department user (Important finding 5)

  const reportingManagerOutOfScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Should fail",
      email: `shouldfailrm+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamAId,
      reportingManager: outsider.userId,
    },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(
    reportingManagerOutOfScope.status,
    403,
    "subadmin cannot create a user reporting to a manager outside their managed set"
  );

  const reportingManagerInScope = await axios.post(
    `${BASE}/users`,
    {
      name: "Reporting to memberA",
      email: `reportok+${Date.now()}@wos.local`,
      password: "smokepass123",
      role: "member",
      team: teamAId,
      reportingManager: memberA.userId,
    },
    subadmin.auth
  );
  assert.equal(
    reportingManagerInScope.status,
    201,
    "subadmin can create a user reporting to one of their own managed users"
  );
  const promotionCandidateId = reportingManagerInScope.data.data.user._id;

  // --- fix: updateComment no longer grants subadmin unscoped cross-department
  // comment moderation (Important finding 3) — even on a task the subadmin CAN
  // view (via memberA's assignment), editing someone else's comment is 403.

  const commentByMemberA = await axios.post(
    `${BASE}/tasks/${taskInOutOfScopeProject.data.data.task._id}/comments`,
    { text: "memberA's comment" },
    memberA.auth
  );
  assert.equal(commentByMemberA.status, 201, "memberA can comment on the task they're assigned to");
  const comments = commentByMemberA.data.data.task.comments;
  const commentId = comments[comments.length - 1]._id;

  const subadminEditForeignComment = await axios.patch(
    `${BASE}/tasks/${taskInOutOfScopeProject.data.data.task._id}/comments/${commentId}`,
    { text: "Should fail" },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(
    subadminEditForeignComment.status,
    403,
    "subadmin cannot edit another user's comment on an out-of-department project's task"
  );

  // --- fix: managedDepartment can be set via updateUser for an admin actor
  // (Important finding 4) — promoting an in-scope member to subadmin now
  // actually persists the managed department instead of silently defaulting
  // to null.

  const promoteMissingDept = await axios.patch(
    `${BASE}/users/${promotionCandidateId}`,
    { role: "subadmin" },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(
    promoteMissingDept.status,
    400,
    "admin promoting a user to subadmin without managedDepartment is rejected"
  );

  const promoteWithDept = await axios.patch(
    `${BASE}/users/${promotionCandidateId}`,
    { role: "subadmin", managedDepartment: otherDeptId },
    adminAuth
  );
  assert.equal(promoteWithDept.status, 200, "admin promotes the candidate to subadmin with a managedDepartment");
  assert.equal(
    String(promoteWithDept.data.data.user.managedDepartment),
    String(otherDeptId),
    "the managedDepartment persists in the update response"
  );

  const verifyPromoted = await axios.get(`${BASE}/users`, adminAuth);
  const promotedUser = verifyPromoted.data.data.users.find((u) => String(u._id) === promotionCandidateId);
  assert.ok(promotedUser, "promoted user appears in the admin's user list");
  assert.equal(
    String(promotedUser.managedDepartment?._id || promotedUser.managedDepartment),
    String(otherDeptId),
    "managedDepartment persists on a follow-up GET too"
  );

  // --- fix: managedDepartment is populated in API responses, not a bare
  // ObjectId (Critical finding 2)

  const meAsSubadmin = await axios.get(`${BASE}/auth/me`, subadmin.auth);
  assert.equal(meAsSubadmin.status, 200, "subadmin fetches their own profile");
  assert.ok(
    meAsSubadmin.data.data.user.managedDepartment && typeof meAsSubadmin.data.data.user.managedDepartment === "object",
    "me's managedDepartment is a populated object, not a bare ObjectId string"
  );
  assert.equal(
    String(meAsSubadmin.data.data.user.managedDepartment._id),
    String(deptId),
    "me's populated managedDepartment._id matches the subadmin's actual managed department"
  );

  // --- fix: PATCH /profile returns a populated managedDepartment, so a
  // subadmin editing their own profile doesn't lose managedDepartment._id
  // client-side (re-review finding 1)

  const profileUpdateAsSubadmin = await axios.patch(
    `${BASE}/profile`,
    { name: "Subadmin Renamed" },
    subadmin.auth
  );
  assert.equal(profileUpdateAsSubadmin.status, 200, "subadmin updates their own profile");
  assert.ok(
    profileUpdateAsSubadmin.data.data.user.managedDepartment &&
      typeof profileUpdateAsSubadmin.data.data.user.managedDepartment === "object",
    "profile update response's managedDepartment is a populated object, not a bare ObjectId string"
  );
  assert.equal(
    String(profileUpdateAsSubadmin.data.data.user.managedDepartment._id),
    String(deptId),
    "profile update response's populated managedDepartment._id matches the subadmin's actual managed department"
  );

  // --- hierarchy fix: a subadmin CAN demote/deactivate an in-department
  // manager — sub-admin manages its whole department, managers included,
  // now that manager is scoped to one team rather than being unscoped/
  // company-wide.

  const managerInDept = await createUser(adminAuth, "manager", {
    team: teamAId,
    department: deptId,
    managedTeam: teamAId,
  });

  const subadminDemotesManager = await axios.patch(
    `${BASE}/users/${managerInDept.userId}`,
    { role: "member" },
    subadmin.auth
  );
  assert.equal(subadminDemotesManager.status, 200, "subadmin demotes an in-department manager to member");
  assert.equal(
    subadminDemotesManager.data.data.user.managedTeam,
    null,
    "demoting away from manager clears the stale managedTeam"
  );

  const managerToDeactivate = await createUser(adminAuth, "manager", {
    team: teamBId,
    department: deptId,
    managedTeam: teamBId,
  });
  const subadminDeactivatesManager = await axios.delete(`${BASE}/users/${managerToDeactivate.userId}`, subadmin.auth);
  assert.equal(subadminDeactivatesManager.status, 200, "subadmin deactivates an in-department manager");

  // --- fix: managedDepartment is cleared when a subadmin is demoted, so a
  // later re-promotion can't silently inherit the stale value (minor finding)

  const demoteSubadmin = await axios.patch(
    `${BASE}/users/${subadmin.userId}`,
    { role: "member" },
    adminAuth
  );
  assert.equal(demoteSubadmin.status, 200, "admin demotes the subadmin fixture to member");

  const repromoteMissingDept = await axios.patch(
    `${BASE}/users/${subadmin.userId}`,
    { role: "subadmin" },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(
    repromoteMissingDept.status,
    400,
    "re-promoting to subadmin without managedDepartment is rejected — the stale managedDepartment was actually cleared on demotion, not silently reused"
  );

  console.log("smoke-subadmin: all checks passed");
};

run().catch((error) => {
  console.error("smoke-subadmin failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
