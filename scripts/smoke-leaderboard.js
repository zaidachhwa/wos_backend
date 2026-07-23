import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role) => {
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  await axios.post(`${BASE}/users`, { name: `Smoke ${role}`, email, password, role }, adminAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    email,
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const todayStr = () => new Date().toISOString().slice(0, 10);

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);
  const manager = await createUser(adminAuth, "manager");
  const member = await createUser(adminAuth, "member");

  const project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Leaderboard ${Date.now()}`, manager: manager.userId, members: [member.userId] },
    manager.auth
  );
  const projectId = project.data.data.project._id;

  // --- on-time high-priority completion: ceiling 15, auto = round(15*0.75) = 11 ---

  const onTime = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "On-time high task",
      assignees: [member.userId],
      priority: "high",
      deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000), // a week out — not overdue
    },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${onTime.data.data.task._id}`, { status: "completed" }, member.auth);

  // --- late high-priority completion: 11 - 5 (overdue penalty) = 6 ---

  const late = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Late high task",
      assignees: [member.userId],
      priority: "high",
      deadline: new Date(Date.now() - 24 * 3600 * 1000), // yesterday — already overdue
    },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${late.data.data.task._id}`, { status: "completed" }, member.auth);

  // --- bonus points: cap for "high" is 15 - 11 = 4 ---

  const bonused = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Bonused high task",
      assignees: [member.userId],
      priority: "high",
      deadline: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    },
    manager.auth
  );
  const bonusedId = bonused.data.data.task._id;
  await axios.patch(`${BASE}/tasks/${bonusedId}`, { status: "completed" }, member.auth);

  const overCap = await axios.patch(
    `${BASE}/tasks/${bonusedId}`,
    { bonusPoints: 5 },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(overCap.status, 400, "bonusPoints exceeding the priority cap is rejected");

  const withinCap = await axios.patch(`${BASE}/tasks/${bonusedId}`, { bonusPoints: 4 }, manager.auth);
  assert.equal(withinCap.status, 200, "bonusPoints within the priority cap is accepted");

  const memberCannotAward = await axios.patch(
    `${BASE}/tasks/${bonusedId}`,
    { bonusPoints: 1 },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberCannotAward.status, 403, "a plain assignee cannot award their own bonus points");

  // Activity is recorded fire-and-forget (not awaited by updateTask), so give
  // it a moment to land before the leaderboard query reads it back.
  await sleep(400);

  const leaderboard = await axios.get(`${BASE}/leaderboard?week=${todayStr()}`, member.auth);
  assert.equal(leaderboard.status, 200, "leaderboard endpoint is reachable");

  const row = leaderboard.data.data.rows.find((r) => r.user._id === member.userId);
  assert.ok(row, "member appears on the leaderboard");
  assert.equal(row.tasksCompleted, 3, "three completed tasks credited this week");
  // 11 (on-time) + 6 (late, -5 penalty) + 15 (bonused, 11 auto + 4 bonus) = 32
  assert.equal(row.points, 32, "points sum matches the priority-weighted formula exactly");

  const ranked = leaderboard.data.data.rows.every((r, i, arr) => i === 0 || arr[i - 1].points >= r.points);
  assert.ok(ranked, "rows are sorted by points descending");

  console.log("smoke-leaderboard: all checks passed");
};

run().catch((error) => {
  console.error("smoke-leaderboard failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
