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
  await axios.post(
    `${BASE}/users`,
    { name: `Smoke ${role}`, email, password, role, ...extra },
    adminAuth
  );
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    email,
    password,
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const iso = (offsetHours) => new Date(Date.now() + offsetHours * 3600 * 1000).toISOString();

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  // Task 5 (department segregation) requires managedDepartment for the
  // manager role.
  const dept = await axios.post(`${BASE}/departments`, { name: `Smoke Timeblocks Dept ${Date.now()}` }, adminAuth);
  const deptId = dept.data.data.department._id;
  const manager = await createUser(adminAuth, "manager", { managedDepartment: deptId });
  const member = await createUser(adminAuth, "member", { reportingManager: manager.userId });
  const otherManager = await createUser(adminAuth, "manager", { managedDepartment: deptId });

  // --- member creates own time block ----------------------------------------

  const ownBlock = await axios.post(
    `${BASE}/timeblocks`,
    { title: "Deep work", start: iso(1), end: iso(2), category: "deep_work" },
    member.auth
  );
  assert.equal(ownBlock.status, 201, "member creates own time block");
  assert.equal(ownBlock.data.data.timeBlock.user, member.userId, "block belongs to member");

  // --- manager creates a block for their report; report sees it ------------

  const reportBlock = await axios.post(
    `${BASE}/timeblocks`,
    { title: "1:1", start: iso(3), end: iso(4), category: "meeting", user: member.userId },
    manager.auth
  );
  assert.equal(reportBlock.status, 201, "manager creates block for a report");
  assert.equal(reportBlock.data.data.timeBlock.createdBy, manager.userId, "createdBy is manager");

  const memberList = await axios.get(
    `${BASE}/timeblocks?from=${iso(-24)}&to=${iso(24)}`,
    member.auth
  );
  assert.ok(
    memberList.data.data.timeBlocks.some((b) => b._id === reportBlock.data.data.timeBlock._id),
    "report sees the manager-created block in their own list"
  );

  // --- manager can GET a report's time blocks; member cannot GET another's --

  const managerGetsReport = await axios.get(
    `${BASE}/timeblocks?user=${member.userId}`,
    manager.auth
  );
  assert.equal(managerGetsReport.status, 200, "manager can GET a report's time blocks");

  const memberGetsOther = await axios.get(
    `${BASE}/timeblocks?user=${manager.userId}`,
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberGetsOther.status, 403, "member cannot GET someone else's time blocks");

  // --- member cannot create for someone else --------------------------------

  const memberForOther = await axios.post(
    `${BASE}/timeblocks`,
    { title: "Nope", start: iso(1), end: iso(2), category: "personal", user: manager.userId },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberForOther.status, 403, "plain member cannot create a block for someone else");

  // --- unrelated manager cannot create for a non-report ---------------------

  const unrelatedManagerForMember = await axios.post(
    `${BASE}/timeblocks`,
    { title: "Nope", start: iso(1), end: iso(2), category: "meeting", user: member.userId },
    { ...otherManager.auth, validateStatus: () => true }
  );
  assert.equal(unrelatedManagerForMember.status, 403, "unrelated manager cannot create for a non-report");

  // --- end<=start rejected ---------------------------------------------------

  const badRange = await axios.post(
    `${BASE}/timeblocks`,
    { title: "Bad", start: iso(2), end: iso(2), category: "personal" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(badRange.status, 400, "end<=start is rejected");

  // --- PATCH by owner OK, by stranger forbidden -----------------------------

  const patchByOwner = await axios.patch(
    `${BASE}/timeblocks/${ownBlock.data.data.timeBlock._id}`,
    { title: "Deep work (renamed)" },
    member.auth
  );
  assert.equal(patchByOwner.status, 200, "owner can patch their own block");
  assert.equal(patchByOwner.data.data.timeBlock.title, "Deep work (renamed)", "title updated");

  const patchByStranger = await axios.patch(
    `${BASE}/timeblocks/${ownBlock.data.data.timeBlock._id}`,
    { title: "Hijacked" },
    { ...otherManager.auth, validateStatus: () => true }
  );
  assert.equal(patchByStranger.status, 403, "stranger cannot patch someone else's block");

  // --- calendar aggregate: block + assigned task deadline -------------------

  const project = await axios.post(
    `${BASE}/projects`,
    { name: "Calendar smoke project", manager: manager.userId },
    manager.auth
  );
  const task = await axios.post(
    `${BASE}/tasks`,
    {
      project: project.data.data.project._id,
      title: "Calendar smoke task",
      assignees: [member.userId],
      deadline: iso(5),
      labels: ["Sprint 12"],
    },
    manager.auth
  );
  assert.equal(task.status, 201, "task created for calendar smoke");

  // Deadline ten days out — outside the narrow window queried below — but the
  // task was just created, so its span [createdAt, deadline] still overlaps
  // the window and it must appear.
  const farTask = await axios.post(
    `${BASE}/tasks`,
    {
      project: project.data.data.project._id,
      title: "Far-deadline smoke task",
      assignees: [member.userId],
      deadline: iso(240),
    },
    manager.auth
  );
  assert.equal(farTask.status, 201, "far-deadline task created");

  // Deadline in the past — must NOT appear, guarding against the overlap query
  // accidentally dropping the deadline lower bound. (Task is created now;
  // only `deadline` is backdated.)
  const pastTask = await axios.post(
    `${BASE}/tasks`,
    {
      project: project.data.data.project._id,
      title: "Past-deadline smoke task",
      assignees: [member.userId],
      deadline: iso(-48),
    },
    manager.auth
  );
  assert.equal(pastTask.status, 201, "past-deadline task created");

  const calendar = await axios.get(
    `${BASE}/calendar?from=${iso(-24)}&to=${iso(24)}`,
    member.auth
  );
  assert.equal(calendar.status, 200, "calendar aggregate fetched");
  const items = calendar.data.data.items;
  assert.ok(
    items.some((i) => i.type === "timeblock" && i.id === ownBlock.data.data.timeBlock._id),
    "calendar includes the member's time block"
  );
  const taskItem = items.find((i) => i.type === "task_deadline" && i.id === task.data.data.task._id);
  assert.ok(taskItem, "calendar includes the assigned task's deadline");
  assert.equal(taskItem.label, "Sprint 12", "task_deadline item carries the task's first label");
  assert.equal(taskItem.projectName, "Calendar smoke project", "task_deadline item carries the project's name");
  assert.equal(taskItem.status, "backlog", "task_deadline item carries the task's status");
  assert.ok(taskItem.spanStart, "task_deadline item carries a spanStart");

  assert.ok(
    items.some((i) => i.type === "task_deadline" && i.id === farTask.data.data.task._id),
    "far-deadline task still appears — its span overlaps the narrow query window"
  );
  assert.ok(
    !items.some((i) => i.type === "task_deadline" && i.id === pastTask.data.data.task._id),
    "past-deadline task does not appear — its span ended before the query window"
  );

  const calendarMissingParams = await axios.get(`${BASE}/calendar`, {
    ...member.auth,
    validateStatus: () => true,
  });
  assert.equal(calendarMissingParams.status, 400, "calendar requires from and to");

  console.log("smoke-timeblocks: all checks passed");
};

run().catch((error) => {
  console.error("smoke-timeblocks failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
