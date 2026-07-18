import assert from "node:assert";
import axios from "axios";

// Smoke coverage for the five task features added on top of smoke-projects.js:
// comment edit/delete, bulk status/assignee update, blockedBy populate, and
// recurring-task auto-creation on completion. (Subtask delete is
// frontend-only — backend already supports replacing `subtasks` wholesale,
// covered indirectly by the bulk/PATCH assertions below.)

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
    password,
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  const manager = await createUser(adminAuth, "manager");
  const member = await createUser(adminAuth, "member");
  const outsider = await createUser(adminAuth, "member");

  const project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Extra ${Date.now()}`, manager: manager.userId, members: [member.userId] },
    manager.auth
  );
  const projectId = project.data.data.project._id;

  // --- blockedBy: create + populate on get/list ---------------------------

  const blocker = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Blocker task" },
    manager.auth
  );
  const blockerId = blocker.data.data.task._id;

  const deadline = new Date("2026-08-01T00:00:00.000Z");
  const blocked = await axios.post(
    `${BASE}/tasks`,
    {
      project: projectId,
      title: "Blocked recurring task",
      assignees: [member.userId],
      blockedBy: [blockerId],
      deadline,
      recurrence: { frequency: "daily", interval: 1 },
    },
    manager.auth
  );
  assert.equal(blocked.status, 201, "creates a task with blockedBy + recurrence");
  const blockedId = blocked.data.data.task._id;

  const blockedGet = await axios.get(`${BASE}/tasks/${blockedId}`, manager.auth);
  assert.equal(blockedGet.data.data.task.blockedBy.length, 1, "blockedBy populated on getTask");
  assert.equal(blockedGet.data.data.task.blockedBy[0].title, "Blocker task", "blockedBy populate includes title");
  assert.equal(blockedGet.data.data.task.blockedBy[0].status, "backlog", "blockedBy populate includes status");

  const listWithBlocked = await axios.get(`${BASE}/tasks?project=${projectId}`, manager.auth);
  const listed = listWithBlocked.data.data.tasks.find((t) => t._id === blockedId);
  assert.equal(listed.blockedBy[0].title, "Blocker task", "blockedBy populated on listTasks too");

  // --- comments: edit/delete permissions -----------------------------------

  const comment = await axios.post(`${BASE}/tasks/${blockedId}/comments`, { text: "Original" }, member.auth);
  assert.equal(comment.status, 201);
  const commentId = comment.data.data.task.comments.at(-1)._id;

  const editByOutsider = await axios.patch(
    `${BASE}/tasks/${blockedId}/comments/${commentId}`,
    { text: "Hacked" },
    { ...outsider.auth, validateStatus: () => true }
  );
  assert.equal(editByOutsider.status, 403, "non-author, non-sublead+ cannot edit a comment");

  const editBlankText = await axios.patch(
    `${BASE}/tasks/${blockedId}/comments/${commentId}`,
    { text: "   " },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(editBlankText.status, 400, "editing to blank text is rejected");

  const editByManager = await axios.patch(
    `${BASE}/tasks/${blockedId}/comments/${commentId}`,
    { text: "Edited by manager" },
    manager.auth
  );
  assert.equal(editByManager.status, 200, "sublead+ (manager) can edit someone else's comment");
  assert.equal(
    editByManager.data.data.task.comments.find((c) => c._id === commentId).text,
    "Edited by manager"
  );

  const editByAuthor = await axios.patch(
    `${BASE}/tasks/${blockedId}/comments/${commentId}`,
    { text: "Edited by author" },
    member.auth
  );
  assert.equal(editByAuthor.status, 200, "comment author can edit their own comment");

  const deleteByManagerForbidden = await axios.delete(`${BASE}/tasks/${blockedId}/comments/${commentId}`, {
    ...manager.auth,
    validateStatus: () => true,
  });
  assert.equal(
    deleteByManagerForbidden.status,
    403,
    "manager (non-author, non-admin) cannot delete someone else's comment — delete is tighter than edit"
  );

  const missingCommentEdit = await axios.patch(
    `${BASE}/tasks/${blockedId}/comments/000000000000000000000000`,
    { text: "x" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(missingCommentEdit.status, 404, "editing a nonexistent comment 404s");

  const deleteByAuthor = await axios.delete(`${BASE}/tasks/${blockedId}/comments/${commentId}`, member.auth);
  assert.equal(deleteByAuthor.status, 200, "comment author can delete their own comment");
  assert.equal(deleteByAuthor.data.data.task.comments.length, 0, "comment removed from task");

  const secondComment = await axios.post(`${BASE}/tasks/${blockedId}/comments`, { text: "By member" }, member.auth);
  const secondCommentId = secondComment.data.data.task.comments.at(-1)._id;
  const deleteByAdmin = await axios.delete(`${BASE}/tasks/${blockedId}/comments/${secondCommentId}`, adminAuth);
  assert.equal(deleteByAdmin.status, 200, "admin can delete anyone's comment");

  // --- bulk update ----------------------------------------------------------

  const bulkTaskA = await axios.post(`${BASE}/tasks`, { project: projectId, title: "Bulk A" }, manager.auth);
  const bulkTaskB = await axios.post(`${BASE}/tasks`, { project: projectId, title: "Bulk B" }, manager.auth);
  const idsToBulk = [bulkTaskA.data.data.task._id, bulkTaskB.data.data.task._id];

  const bulkForbidden = await axios.patch(
    `${BASE}/tasks/bulk`,
    { ids: idsToBulk, status: "in_progress" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(bulkForbidden.status, 403, "plain member cannot bulk-update (route-level authorize)");

  const bulkOk = await axios.patch(
    `${BASE}/tasks/bulk`,
    { ids: idsToBulk, status: "in_progress", assignees: [member.userId] },
    manager.auth
  );
  assert.equal(bulkOk.status, 200, "manager bulk-updates status + assignees");
  assert.equal(bulkOk.data.data.updated, 2, "both tasks reported as updated");

  const bulkTaskAAfter = await axios.get(`${BASE}/tasks/${bulkTaskA.data.data.task._id}`, manager.auth);
  assert.equal(bulkTaskAAfter.data.data.task.status, "in_progress", "bulk status applied");
  assert.equal(bulkTaskAAfter.data.data.task.assignees.length, 1, "bulk assignees applied");

  // A sublead+ caller who nonetheless can't view one of the target projects
  // (e.g. an id that no longer resolves to a project) should have that task
  // silently skipped rather than erroring the whole batch.
  const bulkWithBogusId = await axios.patch(
    `${BASE}/tasks/bulk`,
    { ids: [...idsToBulk, "000000000000000000000000"], status: "review" },
    manager.auth
  );
  assert.equal(bulkWithBogusId.status, 200, "bulk update tolerates a nonexistent id");
  assert.equal(bulkWithBogusId.data.data.updated, 2, "nonexistent id silently excluded from the updated count");

  // --- recurrence: auto-create next occurrence on completion ---------------

  const beforeCompletion = await axios.get(`${BASE}/tasks?project=${projectId}`, manager.auth);
  const countBefore = beforeCompletion.data.data.tasks.length;

  const complete = await axios.patch(`${BASE}/tasks/${blockedId}`, { status: "completed" }, member.auth);
  assert.equal(complete.status, 200, "assignee completes the recurring task");

  const afterCompletion = await axios.get(`${BASE}/tasks?project=${projectId}`, manager.auth);
  assert.equal(afterCompletion.data.data.tasks.length, countBefore + 1, "completing a recurring task creates one new task");

  const nextOccurrence = afterCompletion.data.data.tasks.find(
    (t) => t.title === "Blocked recurring task" && t._id !== blockedId
  );
  assert.ok(nextOccurrence, "next occurrence exists with the same title");
  assert.equal(nextOccurrence.status, "backlog", "next occurrence starts in backlog");
  assert.equal(nextOccurrence.assignees.length, 1, "next occurrence carries over assignees");
  assert.equal(nextOccurrence.blockedBy.length, 0, "next occurrence does not carry over blockedBy");
  const expectedDeadline = new Date(deadline);
  expectedDeadline.setDate(expectedDeadline.getDate() + 1);
  assert.equal(
    new Date(nextOccurrence.deadline).toISOString(),
    expectedDeadline.toISOString(),
    "next occurrence deadline is +1 day (daily recurrence) from the old deadline"
  );

  // completing a non-recurring task should NOT spawn anything
  const nonRecurring = await axios.post(`${BASE}/tasks`, { project: projectId, title: "One-off" }, manager.auth);
  const countBeforeOneOff = (await axios.get(`${BASE}/tasks?project=${projectId}`, manager.auth)).data.data.tasks
    .length;
  await axios.patch(`${BASE}/tasks/${nonRecurring.data.data.task._id}`, { status: "completed" }, manager.auth);
  const countAfterOneOff = (await axios.get(`${BASE}/tasks?project=${projectId}`, manager.auth)).data.data.tasks
    .length;
  assert.equal(countAfterOneOff, countBeforeOneOff, "completing a non-recurring task creates nothing");

  console.log("smoke-tasks-extra: all checks passed");
};

run().catch((error) => {
  console.error("smoke-tasks-extra failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
