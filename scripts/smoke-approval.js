import assert from "node:assert";
import axios from "axios";

// Smoke coverage for the member-proposes / manager-approves task pipeline:
// a member creating a task lands as self-assigned + pending, is locked from
// edits, then either the reportingManager or an admin can approve/reject it,
// and non-managers/outsiders are forbidden from deciding.

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role, reportingManager, extra = {}) => {
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  await axios.post(
    `${BASE}/users`,
    { name: `Smoke ${role}`, email, password, role, reportingManager: reportingManager || null, ...extra },
    adminAuth
  );
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  // Task 5 (department segregation) requires managedDepartment for the
  // manager role — a dedicated department fixture for these two managers.
  const dept = await axios.post(`${BASE}/departments`, { name: `Smoke Approval Dept ${Date.now()}` }, adminAuth);
  const deptId = dept.data.data.department._id;

  const manager = await createUser(adminAuth, "manager", null, { managedDepartment: deptId });
  const member = await createUser(adminAuth, "member", manager.userId);
  const outsiderManager = await createUser(adminAuth, "manager", null, { managedDepartment: deptId });

  const project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Approval ${Date.now()}`, manager: manager.userId, members: [member.userId] },
    manager.auth
  );
  const projectId = project.data.data.project._id;

  // --- member proposes a task: self-assigned + pending ---------------------

  const proposed = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Proposed by member", assignees: [manager.userId] },
    member.auth
  );
  assert.equal(proposed.status, 201, "member can create a task");
  const task = proposed.data.data.task;
  assert.equal(task.approvalStatus, "pending", "member-created task starts pending");
  assert.equal(task.assignees.length, 1, "member-created task is self-assigned only");
  assert.equal(String(task.assignees[0]), String(member.userId), "assignee-tampering in the body is ignored");
  assert.equal(task.status, "backlog", "member-created task is forced to backlog regardless of body");

  // --- pending task is locked from normal edits -----------------------------

  const editWhilePending = await axios.patch(
    `${BASE}/tasks/${task._id}`,
    { status: "in_progress" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(editWhilePending.status, 409, "pending task can't be edited via the normal PATCH route");

  // --- decision permissions --------------------------------------------------

  const outsiderReject = await axios.patch(
    `${BASE}/tasks/${task._id}/reject`,
    { approvalComment: "not my report" },
    { ...outsiderManager.auth, validateStatus: () => true }
  );
  assert.equal(outsiderReject.status, 403, "a manager who isn't the creator's reportingManager can't decide");

  const rejectWithoutReason = await axios.patch(
    `${BASE}/tasks/${task._id}/reject`,
    {},
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(rejectWithoutReason.status, 400, "rejecting requires a reason");

  // --- happy path: reportingManager approves, can also add an assignee -----

  const approved = await axios.patch(
    `${BASE}/tasks/${task._id}/approve`,
    { assignees: [member.userId, manager.userId] },
    manager.auth
  );
  assert.equal(approved.status, 200, "reportingManager approves the task");
  assert.equal(approved.data.data.task.approvalStatus, "approved");
  assert.equal(approved.data.data.task.assignees.length, 2, "approver can add assignees in the same request");

  const doubleApprove = await axios.patch(
    `${BASE}/tasks/${task._id}/approve`,
    {},
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(doubleApprove.status, 409, "an already-approved task can't be approved again");

  const nowEditable = await axios.patch(`${BASE}/tasks/${task._id}`, { status: "todo" }, manager.auth);
  assert.equal(nowEditable.status, 200, "approved task is editable again");

  // --- reject path -----------------------------------------------------------

  const proposed2 = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Proposed then rejected" },
    member.auth
  );
  const task2 = proposed2.data.data.task._id;

  const rejected = await axios.patch(
    `${BASE}/tasks/${task2}/reject`,
    { approvalComment: "duplicate of existing work" },
    manager.auth
  );
  assert.equal(rejected.status, 200, "reportingManager rejects with a reason");
  assert.equal(rejected.data.data.task.approvalStatus, "rejected");
  assert.equal(rejected.data.data.task.approvalComment, "duplicate of existing work");

  // --- admin can decide even without being the reportingManager -------------

  const proposed3 = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Proposed, admin decides" },
    member.auth
  );
  const task3 = proposed3.data.data.task._id;
  const adminApproves = await axios.patch(`${BASE}/tasks/${task3}/approve`, {}, adminAuth);
  assert.equal(adminApproves.status, 200, "admin can approve regardless of reportingManager");

  console.log("smoke-approval: all checks passed");
};

run().catch((error) => {
  console.error("smoke-approval failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
