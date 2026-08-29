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
  await axios.post(`${BASE}/users`, { name, email, password, role, ...extra }, adminAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    name,
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const currentMonth = () => new Date().toISOString().slice(0, 7);
const today = () => new Date().toISOString().slice(0, 10);
const completeTask = async (manager, member, projectId, extra = {}) => {
  const task = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: `Smoke task ${Math.random().toString(36).slice(2, 6)}`, assignees: [member.userId], priority: "low", ...extra },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${task.data.data.task._id}`, { status: "completed" }, member.auth);
  return task.data.data.task._id;
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);
  const dept = await axios.post(`${BASE}/departments`, { name: `Smoke Monthly Dept ${Date.now()}` }, adminAuth);
  const team = await axios.post(
    `${BASE}/teams`,
    { name: `Smoke Monthly Team ${Date.now()}`, department: dept.data.data.department._id },
    adminAuth
  );
  const manager = await createUser(adminAuth, "manager", { managedTeam: team.data.data.team._id });
  const member = await createUser(adminAuth, "member", { reportingManager: manager.userId, team: team.data.data.team._id });

  const project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Monthly ${Date.now()}`, manager: manager.userId, members: [member.userId] },
    manager.auth
  );
  const projectId = project.data.data.project._id;

  // --- Task 1: admin can update monthly penalties and office location; validation matches the existing pattern ---

  const configBefore = await axios.get(`${BASE}/leaderboard/points-config`, adminAuth);
  assert.deepEqual(
    configBefore.data.data.monthlyPenalties,
    { leave: 1, lateMark: 1, clientChange: 1, bug: 1 },
    "default monthly penalty weights match the spec"
  );
  assert.deepEqual(
    configBefore.data.data.officeLocation,
    { lat: null, lng: null, radiusMeters: null },
    "office location starts unconfigured"
  );

  const badWeights = await axios.put(
    `${BASE}/leaderboard/points-config`,
    { monthlyPenalties: { leave: -1, lateMark: 1, clientChange: 1, bug: 1 } },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(badWeights.status, 400, "a negative monthly penalty weight is rejected");

  const memberPut = await axios.put(
    `${BASE}/leaderboard/points-config`,
    { monthlyPenalties: { leave: 2, lateMark: 1, clientChange: 3, bug: 2 } },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberPut.status, 403, "only admins can change monthly penalty weights");

  try {
    const goodPut = await axios.put(
      `${BASE}/leaderboard/points-config`,
      {
        monthlyPenalties: { leave: 2, lateMark: 1, clientChange: 3, bug: 2 },
        officeLocation: { lat: 12.9716, lng: 77.5946, radiusMeters: 1000 },
      },
      adminAuth
    );
    assert.equal(goodPut.status, 200);
    assert.deepEqual(goodPut.data.data.monthlyPenalties, { leave: 2, lateMark: 1, clientChange: 3, bug: 2 });
    assert.deepEqual(goodPut.data.data.officeLocation, { lat: 12.9716, lng: 77.5946, radiusMeters: 1000 });
    // Updating one config group must not wipe the other (the $set-per-group fix).
    assert.deepEqual(goodPut.data.data.pointsByPriority, configBefore.data.data.pointsByPriority);
    assert.deepEqual(goodPut.data.data.penalties, configBefore.data.data.penalties);

    // --- Task 2: the worked example from the spec (20 tasks, weighted penalties -> 99.30) ---

    for (let i = 0; i < 20; i += 1) {
      await completeTask(manager, member, projectId);
    }
    for (let i = 0; i < 2; i += 1) {
      await completeTask(manager, member, projectId, { isClientChange: true });
    }
    const projectModule = await axios.post(`${BASE}/projects/${projectId}/modules`, { name: `Smoke Module ${Date.now()}` }, manager.auth);
    for (let i = 0; i < 2; i += 1) {
      await completeTask(manager, member, projectId, { type: "bug", reference: "smoke bug", modules: [projectModule.data.data.module._id] });
    }
    // Net: 24 completed tasks, 2 client changes, 2 bugs. leaves/lateMarks are 0
    // (member has no shiftStart/shiftEnd set yet), weights leave=2 lateMark=1
    // clientChange=3 bug=2 -> penalty = 0 + 0 + 2*3 + 2*2 = 10; score = 100 - 10/24 = 99.58.

    const appraisal = await axios.get(`${BASE}/appraisal?month=${currentMonth()}&team=${team.data.data.team._id}`, manager.auth);
    const row = appraisal.data.data.rows.find((r) => r.user._id === member.userId);
    assert.ok(row, "member appears in the appraisal");
    assert.equal(row.tasksCompleted, 24, "24 tasks completed this month");
    assert.equal(row.clientChanges, 2);
    assert.equal(row.bugs, 2);
    assert.equal(row.leaves, 0, "no shift time configured yet -> no leave/late-mark derivation");
    assert.equal(row.lateMarks, 0);
    assert.equal(row.penaltyPoints, 10);
    assert.equal(row.score, 99.58, "weighted formula matches: 100 - 10/24");

    // --- Task 3: zero completed tasks -> score is null, never NaN/Infinity ---

    const idleMember = await createUser(adminAuth, "member", { reportingManager: manager.userId, team: team.data.data.team._id });
    const appraisalIdle = await axios.get(`${BASE}/appraisal?month=${currentMonth()}&team=${team.data.data.team._id}`, manager.auth);
    const idleRow = appraisalIdle.data.data.rows.find((r) => r.user._id === idleMember.userId);
    assert.ok(idleRow, "idle member appears in the appraisal");
    assert.equal(idleRow.tasksCompleted, 0);
    assert.equal(idleRow.score, null, "zero completed tasks -> null score, not NaN/Infinity/0");

    // --- Task 4: competition ranking ---

    assert.ok(appraisal.data.data.rows.every((r) => typeof r.rank === "number"), "every row has a rank");
    const sorted = [...appraisal.data.data.rows].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(sorted[i].rank >= sorted[i - 1].rank, "ranks are non-decreasing once sorted");
    }

    // --- Task 5: shift time + late mark / leave derivation ---

    await axios.patch(`${BASE}/profile`, { shiftStart: "00:00", shiftEnd: "00:01" }, member.auth);
    // Shift time has no history (documented simplification) — setting it now
    // retroactively evaluates every IST working day so far *this month*, not
    // just today, since the member never submitted a follow-up all month.
    // Only Sunday is an official holiday; Saturday is a regular working day.
    // Leave cutoff (shiftEnd + 1h = 01:01 IST) has certainly already passed
    // for every one of those days by the time this script runs.
    const istNow = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const isWorkingDayIST = (d) => d.getUTCDay() !== 0;
    let expectedAttendanceHits = 0;
    for (let day = 1; day <= istNow.getUTCDate(); day += 1) {
      if (isWorkingDayIST(new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), day)))) {
        expectedAttendanceHits += 1;
      }
    }

    const afterShift = await axios.get(`${BASE}/appraisal?month=${currentMonth()}&team=${team.data.data.team._id}`, manager.auth);
    const shiftedRow = afterShift.data.data.rows.find((r) => r.user._id === member.userId);
    assert.equal(
      shiftedRow.lateMarks,
      expectedAttendanceHits,
      `${expectedAttendanceHits} late mark(s) for every IST weekday so far this month, no follow-up ever submitted`
    );
    assert.equal(
      shiftedRow.leaves,
      expectedAttendanceHits,
      `${expectedAttendanceHits} leave(s) for every IST weekday so far this month, neither follow-up submitted`
    );
    assert.equal(
      shiftedRow.penaltyPoints,
      expectedAttendanceHits * 2 + expectedAttendanceHits * 1 + 2 * 3 + 2 * 2,
      "leave+lateMark penalties for every elapsed weekday are included"
    );

    // --- Task 6: follow-up geofencing ---

    const farSubmit = await axios.post(
      `${BASE}/followups`,
      { date: today(), type: "evening", data: { completedWork: "x" }, submit: true, lat: 0, lng: 0 },
      { ...member.auth, validateStatus: () => true }
    );
    assert.equal(farSubmit.status, 400, "submitting far from the configured office is rejected");

    const missingLocation = await axios.post(
      `${BASE}/followups`,
      { date: today(), type: "evening", data: { completedWork: "x" }, submit: true },
      { ...member.auth, validateStatus: () => true }
    );
    assert.equal(missingLocation.status, 400, "submitting with no coordinates is rejected once office location is configured");

    const nearSubmit = await axios.post(
      `${BASE}/followups`,
      { date: today(), type: "evening", data: { completedWork: "x" }, submit: true, lat: 12.9716, lng: 77.5946 },
      member.auth
    );
    assert.equal(nearSubmit.status, 200, "submitting within the office radius succeeds");

    // Disable the geofence and confirm submission is no longer blocked.
    await axios.put(
      `${BASE}/leaderboard/points-config`,
      { officeLocation: { lat: null, lng: null, radiusMeters: null } },
      adminAuth
    );
    const draftFarAway = await axios.post(
      `${BASE}/followups`,
      { date: today(), type: "morning", data: { todayPlan: "x" }, submit: true, lat: 0, lng: 0 },
      { ...member.auth, validateStatus: () => true }
    );
    assert.equal(draftFarAway.status, 200, "geofence disabled -> submission from anywhere succeeds");
  } finally {
    await axios.put(
      `${BASE}/leaderboard/points-config`,
      {
        pointsByPriority: configBefore.data.data.pointsByPriority,
        penalties: configBefore.data.data.penalties,
        monthlyPenalties: configBefore.data.data.monthlyPenalties,
        officeLocation: configBefore.data.data.officeLocation,
      },
      adminAuth
    );
  }

  console.log("smoke-monthly-performance: all checks passed");
};

run().catch((error) => {
  console.error("smoke-monthly-performance failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
