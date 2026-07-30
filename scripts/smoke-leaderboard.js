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
    email,
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

// The CSV writer only quotes the Name/Team fields; this mirrors that shape
// (quoted-or-empty) rather than pulling in a CSV dependency for a test file.
const parseLeaderboardCsv = (csv) =>
  csv
    .trim()
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      // points can be negative now (Task 6: penalty activities net into the total)
      const m = line.match(/^(\d+),"((?:[^"]|"")*)",(\w+),(?:"([^"]*)"|),(\d+),(-?\d+)$/);
      assert.ok(m, `unparseable leaderboard CSV row: ${line}`);
      const [, rank, name, role, team, tasksCompleted, points] = m;
      return {
        rank: Number(rank),
        name: name.replace(/""/g, '"'),
        role,
        team: team || null,
        tasksCompleted: Number(tasksCompleted),
        points: Number(points),
      };
    });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const todayStr = () => new Date().toISOString().slice(0, 10);
const weekAhead = () => new Date(Date.now() + 7 * 24 * 3600 * 1000);

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
    { project: projectId, title: "On-time high task", assignees: [member.userId], priority: "high", deadline: weekAhead() },
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
    { project: projectId, title: "Bonused high task", assignees: [member.userId], priority: "high", deadline: weekAhead() },
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

  // --- fairness math, read via the manager's CSV export (bypasses the Monday lock below) ---

  const csv1 = await axios.get(`${BASE}/leaderboard?week=${todayStr()}&format=csv`, manager.auth);
  assert.equal(csv1.status, 200, "csv export is reachable for a manager");
  let row = parseLeaderboardCsv(csv1.data).find((r) => r.name === member.name);
  assert.ok(row, "member appears in the export");
  assert.equal(row.tasksCompleted, 3, "three completed tasks credited this week");
  // 11 (on-time) + 6 (late, -5 penalty) + 15 (bonused, 11 auto + 4 bonus) = 32
  assert.equal(row.points, 32, "points sum matches the priority-weighted formula exactly");

  const memberCsv = await axios.get(`${BASE}/leaderboard?format=csv`, { ...member.auth, validateStatus: () => true });
  assert.equal(memberCsv.status, 403, "a plain member cannot export the csv report");

  // --- requirement 1: the JSON view is locked to Monday only, for every role ---

  const isMonday = new Date().getDay() === 1;
  for (const [label, auth] of [["member", member.auth], ["manager", manager.auth]]) {
    const view = await axios.get(`${BASE}/leaderboard?week=${todayStr()}`, auth);
    assert.equal(view.status, 200);
    if (isMonday) {
      assert.ok(Array.isArray(view.data.data.rows), `${label}: unlocked on Monday, rows are returned`);
    } else {
      assert.equal(view.data.data.locked, true, `${label}: locked outside of Monday`);
      assert.equal(new Date(view.data.data.nextMonday).getDay(), 1, `${label}: nextMonday really is a Monday`);
    }
  }

  const adminView = await axios.get(`${BASE}/leaderboard?week=${todayStr()}`, adminAuth);
  assert.equal(adminView.status, 200);
  assert.ok(
    Array.isArray(adminView.data.data.rows),
    "admin: the live view is never locked, regardless of the day"
  );

  // --- requirement 1: admins are excluded from the roster entirely ---

  const admin2 = await createUser(adminAuth, "admin");
  const adminTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Admin task", assignees: [admin2.userId], priority: "low", deadline: weekAhead() },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${adminTask.data.data.task._id}`, { status: "completed" }, admin2.auth);
  await sleep(300);

  const csv2 = await axios.get(`${BASE}/leaderboard?week=${todayStr()}&format=csv`, manager.auth);
  assert.ok(
    !parseLeaderboardCsv(csv2.data).some((r) => r.name === admin2.name),
    "admin users never appear on the leaderboard, even after completing a task"
  );

  // --- requirement 4: cross-team visibility, with team detail + filter ---

  const dept = await axios.post(`${BASE}/departments`, { name: `Smoke Dept ${Date.now()}` }, adminAuth);
  const team = await axios.post(
    `${BASE}/teams`,
    { name: `Smoke Team ${Date.now()}`, department: dept.data.data.department._id },
    adminAuth
  );
  const teamId = team.data.data.team._id;
  const teamName = team.data.data.team.name;

  const teamMember = await createUser(adminAuth, "member", { team: teamId });
  const teamTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Team task", assignees: [teamMember.userId], priority: "medium", deadline: weekAhead() },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${teamTask.data.data.task._id}`, { status: "completed" }, teamMember.auth);
  await sleep(300);

  const csv3 = await axios.get(`${BASE}/leaderboard?week=${todayStr()}&format=csv`, manager.auth);
  const allRows = parseLeaderboardCsv(csv3.data);
  const teamRow = allRows.find((r) => r.name === teamMember.name);
  assert.ok(teamRow, "the teammate shows up in the org-wide export");
  assert.equal(teamRow.team, teamName, "the row is labeled with the member's team");
  assert.ok(
    allRows.some((r) => r.name === member.name),
    "a member with no team is visible in the same org-wide list as the teammate (team A sees team B)"
  );

  const csv4 = await axios.get(`${BASE}/leaderboard?week=${todayStr()}&format=csv&team=${teamId}`, manager.auth);
  const filteredRows = parseLeaderboardCsv(csv4.data);
  assert.ok(filteredRows.length > 0, "the team filter returns at least the teammate");
  assert.ok(
    filteredRows.every((r) => r.name === teamMember.name),
    "the team filter narrows the export to just that team"
  );

  // --- requirement 3: admin-configurable point values ---

  const original = await axios.get(`${BASE}/leaderboard/points-config`, member.auth);
  assert.equal(original.status, 200, "any authenticated user can read the point config");
  const defaults = original.data.data.pointsByPriority;

  const memberPut = await axios.put(
    `${BASE}/leaderboard/points-config`,
    { pointsByPriority: { ...defaults, low: 50 } },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberPut.status, 403, "only admins can change point values");

  const badPut = await axios.put(
    `${BASE}/leaderboard/points-config`,
    { pointsByPriority: { ...defaults, low: -1 } },
    { ...adminAuth, validateStatus: () => true }
  );
  assert.equal(badPut.status, 400, "negative point values are rejected");

  try {
    const goodPut = await axios.put(
      `${BASE}/leaderboard/points-config`,
      { pointsByPriority: { ...defaults, low: 50 } },
      adminAuth
    );
    assert.equal(goodPut.status, 200);
    assert.equal(goodPut.data.data.pointsByPriority.low, 50, "updated value is echoed back");

    const configTask = await axios.post(
      `${BASE}/tasks`,
      { project: projectId, title: "Config-priced task", assignees: [member.userId], priority: "low", deadline: weekAhead() },
      manager.auth
    );
    await axios.patch(`${BASE}/tasks/${configTask.data.data.task._id}`, { status: "completed" }, member.auth);
    await sleep(300);

    const csv5 = await axios.get(`${BASE}/leaderboard?week=${todayStr()}&format=csv`, manager.auth);
    const memberRowAfter = parseLeaderboardCsv(csv5.data).find((r) => r.name === member.name);
    // previous total (32) + round(50 * 0.75 auto-award ratio) for the new low-priority task
    assert.equal(
      memberRowAfter.points,
      32 + Math.round(50 * 0.75),
      "a newly-completed task is priced from the live admin-configured value, not the hardcoded default"
    );
  } finally {
    // Leave shared scoring config exactly as we found it. Asserted (not just
    // fired) — a silent failure here would leave the live scoring corrupted
    // for every subsequent run, which is exactly what happened once before.
    const restore = await axios.put(
      `${BASE}/leaderboard/points-config`,
      { pointsByPriority: defaults },
      adminAuth
    );
    assert.equal(restore.status, 200, "points config restore succeeded");
    assert.deepEqual(restore.data.data.pointsByPriority, defaults, "points config restored to its exact original values");
  }

  console.log("smoke-leaderboard: all checks passed");
};

run().catch((error) => {
  console.error("smoke-leaderboard failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
