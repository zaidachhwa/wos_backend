import assert from "node:assert";
import axios from "axios";
import mongoose from "mongoose";

import Memo from "../src/models/Memo.js";
// Side-effect imports: registers these models in this standalone script's
// own mongoose connection so computeMonthlyAppraisal's .populate("team", ...)
// (reached via the direct runMonthlyMemoSweep call below) can resolve them —
// the running Express server process has its own separate registration.
import "../src/models/Team.js";
import "../src/models/User.js";
import "../src/models/FollowUp.js";

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

const currentMonth = () => new Date().toISOString().slice(0, 7);

const completeTask = async (manager, member, projectId) => {
  const task = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: `Smoke task ${Math.random().toString(36).slice(2, 6)}`, assignees: [member.userId], priority: "low" },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${task.data.data.task._id}`, { status: "completed" }, member.auth);
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);
  await mongoose.connect(process.env.MONGODB_URI);

  const dept = await axios.post(`${BASE}/departments`, { name: `Smoke Memo Dept ${Date.now()}` }, adminAuth);
  const teamA = await axios.post(`${BASE}/teams`, { name: `Smoke Memo A ${Date.now()}`, department: dept.data.data.department._id }, adminAuth);
  const teamB = await axios.post(`${BASE}/teams`, { name: `Smoke Memo B ${Date.now()}`, department: dept.data.data.department._id }, adminAuth);
  const teamAId = teamA.data.data.team._id;
  const teamBId = teamB.data.data.team._id;

  const manager = await createUser(adminAuth, "manager", { managedTeam: teamAId });

  // --- Task 1: thresholds default, and permission scoping ---

  assert.deepEqual(teamA.data.data.team.performanceThresholds, { red: 50, yellow: 80 }, "default thresholds match appraisal's prior hardcoded cutoffs");

  const mgrSetsOwn = await axios.patch(`${BASE}/teams/${teamAId}/thresholds`, { red: 101, yellow: 200 }, manager.auth);
  assert.equal(mgrSetsOwn.status, 200, "manager sets thresholds for their own team");
  assert.deepEqual(mgrSetsOwn.data.data.team.performanceThresholds, { red: 101, yellow: 200 });

  const mgrSetsOther = await axios.patch(
    `${BASE}/teams/${teamBId}/thresholds`,
    { red: 10, yellow: 20 },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(mgrSetsOther.status, 404, "manager cannot set thresholds for a team they don't manage");

  const adminSetsOther = await axios.patch(`${BASE}/teams/${teamBId}/thresholds`, { red: 40, yellow: 70 }, adminAuth);
  assert.equal(adminSetsOther.status, 200, "admin sets thresholds for any team");

  const badThresholds = await axios.patch(
    `${BASE}/teams/${teamAId}/thresholds`,
    { red: 90, yellow: 50 },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(badThresholds.status, 400, "red must be less than yellow");

  // teamA's thresholds are now {red:101, yellow:200} — any completed-task
  // month (score <= 100) is guaranteed Red, no need to inflate penalty
  // weights to force it.

  const member = await createUser(adminAuth, "member", { team: teamAId, reportingManager: manager.userId });
  const project = await axios.post(`${BASE}/projects`, { name: `Smoke Memo ${Date.now()}`, manager: manager.userId, members: [member.userId] }, manager.auth);
  const projectId = project.data.data.project._id;
  await completeTask(manager, member, projectId);

  // --- Task 2: manual sweep issues memo #1 (review_delay), pushes nextReviewDate ---

  const month = currentMonth();
  const sweep1 = await axios.post(`${BASE}/appraisal/run-memo-sweep`, { month }, adminAuth);
  assert.equal(sweep1.status, 200);
  assert.ok(sweep1.data.data.memosIssued >= 1, "sweep issues at least one memo (our red-band member)");

  const memosAfter1 = await axios.get(`${BASE}/users/${member.userId}/memos`, adminAuth);
  const memo1 = memosAfter1.data.data.memos.find((m) => m.month === month);
  assert.ok(memo1, "member has a memo for this month");
  assert.equal(memo1.sequenceNumber, 1);
  assert.equal(memo1.consequence, "review_delay");

  const userAfter1 = await axios.get(`${BASE}/users/${member.userId}`, adminAuth);
  assert.ok(userAfter1.data.data.user.nextReviewDate, "nextReviewDate is set after memo #1");
  const daysPushed = (new Date(userAfter1.data.data.user.nextReviewDate) - new Date()) / (24 * 60 * 60 * 1000);
  assert.ok(daysPushed > 20 && daysPushed < 22, `nextReviewDate pushed ~21 days out (got ${daysPushed.toFixed(1)})`);
  assert.equal(userAfter1.data.data.user.terminationPending, false, "not yet flagged after memo #1");

  // --- Task 3: re-running the sweep for the same month is a no-op (idempotent) ---

  const sweep2 = await axios.post(`${BASE}/appraisal/run-memo-sweep`, { month }, adminAuth);
  const memosAfter2 = await axios.get(`${BASE}/users/${member.userId}/memos`, adminAuth);
  assert.equal(memosAfter2.data.data.memos.filter((m) => m.month === month).length, 1, "re-running the sweep doesn't double-issue a memo for the same month");

  // --- Task 4: seed 2 more prior red months directly (Activity timestamps are
  // always "now", so a real 2nd/3rd red month can't be produced through the
  // live app within one test run) to reach memo #4 -> termination_flag ---

  await Memo.create({
    user: member.userId,
    team: teamAId,
    month: "2026-01",
    score: 10,
    thresholds: { red: 101, yellow: 200 },
    sequenceNumber: 2,
    consequence: "review_delay",
  });
  await Memo.create({
    user: member.userId,
    team: teamAId,
    month: "2026-02",
    score: 10,
    thresholds: { red: 101, yellow: 200 },
    sequenceNumber: 3,
    consequence: "review_delay",
  });

  // Since `month` is already consumed by memo #1, simulate the 4th red month
  // as a distinct "YYYY-MM" the sweep hasn't touched — seed one more Memo
  // directly for consistency of the running count, then call the real sweep
  // for a genuinely fresh month string so its own create-path (not a seed)
  // exercises the >=4 -> termination_flag branch end-to-end.
  const fakeMonth4 = "2026-03";
  // No completed-task Activity exists for 2026-03, so computeMonthlyAppraisal
  // would score this member `null` (0 tasks) for that window and skip them —
  // exercise the >=4 branch directly against the service instead of via HTTP,
  // mirroring smoke-department-scope.js's precedent for reaching states the
  // live HTTP flow can't produce within one test run.
  const { runMonthlyMemoSweep } = await import("../src/services/memoSweep.js");
  const Task = (await import("../src/models/Task.js")).default;
  const Activity = (await import("../src/models/Activity.js")).default;
  const task4 = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Smoke memo seq4 task", assignees: [member.userId], priority: "low" },
    manager.auth
  );
  await Task.findByIdAndUpdate(task4.data.data.task._id, { status: "completed" });
  await Activity.create({
    actor: member.userId,
    action: "status_changed",
    entityType: "task",
    entityId: task4.data.data.task._id,
    project: projectId,
    meta: { statusTo: "completed" },
    createdAt: new Date(`${fakeMonth4}-15T00:00:00.000Z`),
  });

  const sweep4 = await runMonthlyMemoSweep(fakeMonth4);
  assert.ok(sweep4.memosIssued >= 1, "4th-month sweep issues the escalation memo");

  const memosAfter4 = await axios.get(`${BASE}/users/${member.userId}/memos`, adminAuth);
  const memo4 = memosAfter4.data.data.memos.find((m) => m.month === fakeMonth4);
  assert.ok(memo4, "memo #4 exists");
  assert.equal(memo4.sequenceNumber, 4);
  assert.equal(memo4.consequence, "termination_flag", "4th memo escalates to termination_flag, not another review_delay");

  const userAfter4 = await axios.get(`${BASE}/users/${member.userId}`, adminAuth);
  assert.equal(userAfter4.data.data.user.terminationPending, true, "terminationPending set after memo #4");

  // --- Task 5: manager cannot reset memos (admin-only); admin reset clears the flag ---

  const mgrReset = await axios.post(`${BASE}/users/${member.userId}/memos/reset`, {}, { ...manager.auth, validateStatus: () => true });
  assert.equal(mgrReset.status, 403, "manager cannot reset memos");

  const adminReset = await axios.post(`${BASE}/users/${member.userId}/memos/reset`, {}, adminAuth);
  assert.equal(adminReset.status, 200);
  assert.equal(adminReset.data.data.user.terminationPending, false, "reset clears the termination flag");

  const memosAfterReset = await axios.get(`${BASE}/users/${member.userId}/memos`, adminAuth);
  assert.ok(memosAfterReset.data.data.memos.every((m) => m.voided), "reset voids every prior memo");

  console.log("smoke-memos: all checks passed");
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error("smoke-memos failed:", error.response?.data?.message || error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
