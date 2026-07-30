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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const yesterday = () => new Date(Date.now() - 24 * 3600 * 1000);

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);
  const manager = await createUser(adminAuth, "manager");
  const member = await createUser(adminAuth, "member", { reportingManager: manager.userId });

  const project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Accountability ${Date.now()}`, manager: manager.userId, members: [member.userId] },
    manager.auth
  );
  const projectId = project.data.data.project._id;

  // --- Task 1: client_review is exempt from the overdue tag ---

  const overdueTask = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Client review exemption task",
      assignees: [member.userId],
      priority: "medium",
      deadline: yesterday(),
      status: "client_review",
    },
    manager.auth
  );
  const overdueTaskId = overdueTask.data.data.task._id;

  const dashWhileReview = await axios.get(`${BASE}/dashboard`, manager.auth);
  assert.ok(
    !dashWhileReview.data.data.overdueTasks.some((t) => t._id === overdueTaskId),
    "a task in client_review, even past its deadline, is not counted as overdue"
  );

  await axios.patch(`${BASE}/tasks/${overdueTaskId}`, { status: "in_progress" }, manager.auth);
  const dashAfterMove = await axios.get(`${BASE}/dashboard`, manager.auth);
  assert.ok(
    dashAfterMove.data.data.overdueTasks.some((t) => t._id === overdueTaskId),
    "moving the same task out of client_review while still past deadline makes it overdue again"
  );

  // --- Task 2: penalties are part of the points config, with correct defaults ---

  const configBefore = await axios.get(`${BASE}/leaderboard/points-config`, member.auth);
  assert.deepEqual(
    configBefore.data.data.penalties,
    { completedLate: 5, overdue: 2, bug: 1 },
    "default penalty values match the spec"
  );

  // --- Task 3: admins can update penalties; validation matches the priority-points pattern ---

  const badPenalty = await axios.put(
    `${BASE}/leaderboard/points-config`,
    { pointsByPriority: configBefore.data.data.pointsByPriority, penalties: { completedLate: -1, overdue: 2, bug: 1 } },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(badPenalty.status, 400, "a negative penalty value is rejected");

  const memberPut = await axios.put(
    `${BASE}/leaderboard/points-config`,
    { pointsByPriority: configBefore.data.data.pointsByPriority, penalties: { completedLate: 9, overdue: 2, bug: 1 } },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberPut.status, 403, "only admins can change penalty values");

  try {
    const goodPut = await axios.put(
      `${BASE}/leaderboard/points-config`,
      { pointsByPriority: configBefore.data.data.pointsByPriority, penalties: { completedLate: 9, overdue: 3, bug: 2 } },
      adminAuth
    );
    assert.equal(goodPut.status, 200);
    assert.deepEqual(goodPut.data.data.penalties, { completedLate: 9, overdue: 3, bug: 2 }, "updated penalties echoed back");
  } finally {
    const restore = await axios.put(
      `${BASE}/leaderboard/points-config`,
      { pointsByPriority: configBefore.data.data.pointsByPriority, penalties: configBefore.data.data.penalties },
      adminAuth
    );
    assert.equal(restore.status, 200, "points/penalties config restore succeeded");
  }

  // --- Task 4: bugs require at least one module, and log a penalty activity ---

  const bugNoModule = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Bug with no module", type: "bug", assignees: [member.userId], priority: "high" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(bugNoModule.status, 400, "a bug with no modules is rejected");

  const projectModule = await axios.post(
    `${BASE}/projects/${projectId}/modules`,
    { name: `Smoke Module ${Date.now()}` },
    manager.auth
  );
  const moduleId = projectModule.data.data.module._id;

  const bug = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Real bug",
      type: "bug",
      reference: "Found while testing checkout",
      modules: [moduleId],
      assignees: [member.userId],
      priority: "medium",
    },
    manager.auth
  );
  assert.equal(bug.status, 201);
  assert.equal(bug.data.data.task.type, "bug", "the created task is marked as a bug");
  assert.equal(bug.data.data.task.reference, "Found while testing checkout");

  // --- Task 5: the overdue sweep penalizes an open, past-deadline task exactly once ---

  const overdueOpenTask = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Still-open overdue task",
      assignees: [member.userId],
      priority: "medium",
      deadline: yesterday(),
    },
    manager.auth
  );
  const overdueOpenTaskId = overdueOpenTask.data.data.task._id;

  const sweep1 = await axios.post(`${BASE}/leaderboard/run-overdue-sweep`, {}, adminAuth);
  assert.equal(sweep1.status, 200);
  assert.ok(sweep1.data.data.processed >= 1, "the sweep processes at least the one overdue task just created");

  const sweep2 = await axios.post(`${BASE}/leaderboard/run-overdue-sweep`, {}, adminAuth);
  assert.equal(sweep2.data.data.processed, 0, "a second sweep immediately after finds nothing new to penalize");

  const memberSweep = await axios.post(
    `${BASE}/leaderboard/run-overdue-sweep`,
    {},
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberSweep.status, 403, "only admins can trigger the sweep");

  // --- Task 5 fix: two concurrent sweeps must not double-penalize the same task ---

  const raceTask = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Race condition overdue task",
      assignees: [member.userId],
      priority: "medium",
      deadline: yesterday(),
    },
    manager.auth
  );
  assert.equal(raceTask.status, 201);

  const [raceSweepA, raceSweepB] = await Promise.all([
    axios.post(`${BASE}/leaderboard/run-overdue-sweep`, {}, adminAuth),
    axios.post(`${BASE}/leaderboard/run-overdue-sweep`, {}, adminAuth),
  ]);
  const totalProcessed = raceSweepA.data.data.processed + raceSweepB.data.data.processed;
  assert.equal(
    totalProcessed,
    1,
    "two concurrent sweeps must claim the newly-overdue task exactly once between them, not twice"
  );

  // --- Task 6: the leaderboard nets bug + overdue penalties against completed-task points ---

  await sleep(400); // let the fire-and-forget Activity writes above land

  const csv = await axios.get(`${BASE}/leaderboard?week=${new Date().toISOString().slice(0, 10)}&format=csv`, manager.auth);
  const row = csv.data
    .trim()
    .split("\n")
    .slice(1)
    .find((line) => line.includes(member.name));
  assert.ok(row, "member appears in the export after accruing penalties");
  const penaltyPoints = Number(row.split(",").pop());
  // member has accrued exactly: -1 (bug_logged) + -6 (three overdue_penalized rows at
  // the default -2 each: the section-1 "Client review exemption task" once patched out
  // of client_review, plus "Still-open overdue task" and "Race condition overdue task"
  // from section 5 — the sweep has no notion of *why* a task became eligible, it just
  // claims every non-exempt, overdue, unswept task, so all three of member's overdue
  // tasks get penalized once section 5's sweeps run). No completions yet this run.
  assert.equal(penaltyPoints, -7, "bug and multiple overdue penalties net together correctly, going negative");

  // --- Task 7: time-in-status is reconstructed from the status-change activity log ---

  const timedTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Timed task", assignees: [member.userId], priority: "low" },
    manager.auth
  );
  const timedTaskId = timedTask.data.data.task._id;

  await axios.patch(`${BASE}/tasks/${timedTaskId}`, { status: "in_progress" }, member.auth);
  await sleep(1000);
  await axios.patch(`${BASE}/tasks/${timedTaskId}`, { status: "review" }, member.auth);
  await sleep(500);
  await axios.patch(`${BASE}/tasks/${timedTaskId}`, { status: "completed" }, member.auth);
  await sleep(200); // let the fire-and-forget status-change Activity writes land

  const fetched = await axios.get(`${BASE}/tasks/${timedTaskId}`, member.auth);
  const { statusDurations, totalWorkingMs } = fetched.data.data.task;
  assert.ok(statusDurations.in_progress >= 900, `in_progress duration recorded (got ${statusDurations.in_progress}ms)`);
  assert.ok(statusDurations.review >= 400, `review duration recorded (got ${statusDurations.review}ms)`);
  assert.equal(
    totalWorkingMs,
    statusDurations.in_progress + (statusDurations.review || 0) + (statusDurations.testing || 0),
    "totalWorkingMs sums exactly in_progress + review + testing"
  );

  console.log("smoke-accountability: all checks passed");
};

run().catch((error) => {
  console.error("smoke-accountability failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
