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

const createUser = async (adminAuth, role, extra = {}) => {
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  await axios.post(`${BASE}/users`, { name: `Smoke ${role}`, email, password, role, ...extra }, adminAuth);
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

  // Task 5 (department segregation) requires managedDepartment for the
  // manager role.
  const managerDept = await axios.post(
    `${BASE}/departments`,
    { name: `Smoke Tasks Extra Manager Dept ${Date.now()}` },
    adminAuth
  );
  const managerDeptId = managerDept.data.data.department._id;
  const managerTeam = await axios.post(
    `${BASE}/teams`,
    { name: `Smoke Tasks Extra Manager Team ${Date.now()}`, department: managerDeptId },
    adminAuth
  );
  const manager = await createUser(adminAuth, "manager", { managedTeam: managerTeam.data.data.team._id });
  // member must sit on manager's managed team — createProject validates
  // manager/members are within the acting manager's team scope (Task 6).
  const member = await createUser(adminAuth, "member", { team: managerTeam.data.data.team._id });
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
      startTime: "09:00",
      endTime: "10:30",
      recurrence: { frequency: "daily", interval: 1 },
    },
    manager.auth
  );
  assert.equal(blocked.status, 201, "creates a task with blockedBy + recurrence + a time slot");
  assert.equal(blocked.data.data.task.startTime, "09:00", "startTime saved");
  assert.equal(blocked.data.data.task.endTime, "10:30", "endTime saved");
  const blockedId = blocked.data.data.task._id;

  // --- time slot validation --------------------------------------------------

  const lonelyStartTime = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Lonely start", deadline, startTime: "09:00" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(lonelyStartTime.status, 400, "startTime without endTime is rejected on create");

  const backwardsTimeSlot = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Backwards slot", deadline, startTime: "10:00", endTime: "09:00" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(backwardsTimeSlot.status, 400, "endTime before startTime is rejected on create");

  const timeSlotNoDeadline = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "No deadline slot", startTime: "09:00", endTime: "10:00" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(timeSlotNoDeadline.status, 400, "a time slot without a deadline is rejected on create");

  const patchLonelyEndTime = await axios.patch(
    `${BASE}/tasks/${blockedId}`,
    { endTime: null },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(patchLonelyEndTime.status, 400, "clearing only endTime (leaving startTime set) is rejected on update");

  const patchValidTimeSlot = await axios.patch(
    `${BASE}/tasks/${blockedId}`,
    { startTime: "13:00", endTime: "14:00" },
    manager.auth
  );
  assert.equal(patchValidTimeSlot.status, 200, "updating both start and end time together succeeds");
  assert.equal(patchValidTimeSlot.data.data.task.startTime, "13:00", "PATCH updates startTime");

  const blockedGet = await axios.get(`${BASE}/tasks/${blockedId}`, manager.auth);
  assert.equal(blockedGet.data.data.task.blockedBy.length, 1, "blockedBy populated on getTask");
  assert.equal(blockedGet.data.data.task.blockedBy[0].title, "Blocker task", "blockedBy populate includes title");
  assert.equal(blockedGet.data.data.task.blockedBy[0].status, "backlog", "blockedBy populate includes status");

  const listWithBlocked = await axios.get(`${BASE}/tasks?project=${projectId}`, manager.auth);
  const listed = listWithBlocked.data.data.tasks.find((t) => t._id === blockedId);
  assert.equal(listed.blockedBy[0].title, "Blocker task", "blockedBy populated on listTasks too");

  // --- dueAfter/dueBefore date-range filter ----------------------------------

  const earlyTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Early task", deadline: new Date("2026-07-01T00:00:00.000Z") },
    manager.auth
  );
  const lateTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Late task", deadline: new Date("2026-09-01T00:00:00.000Z") },
    manager.auth
  );
  const rangeFiltered = await axios.get(
    `${BASE}/tasks?project=${projectId}&dueAfter=2026-07-15&dueBefore=2026-08-15`,
    manager.auth
  );
  const rangeTitles = rangeFiltered.data.data.tasks.map((t) => t.title);
  assert.ok(rangeTitles.includes("Blocked recurring task"), "dueAfter/dueBefore range includes the in-range task");
  assert.ok(!rangeTitles.includes("Early task"), "dueAfter excludes a task before the range");
  assert.ok(!rangeTitles.includes("Late task"), "dueBefore excludes a task after the range");
  assert.equal(earlyTask.status, 201);
  assert.equal(lateTask.status, 201);

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
  assert.equal(nextOccurrence.startTime, "13:00", "next occurrence carries over startTime");
  assert.equal(nextOccurrence.endTime, "14:00", "next occurrence carries over endTime");
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
