import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

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

const iso = (offsetHours) => new Date(Date.now() + offsetHours * 3600 * 1000).toISOString();

const run = async () => {
  const adminLogin = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  const adminAuth = { headers: { Authorization: `Bearer ${adminLogin.data.data.accessToken}` } };
  const adminId = adminLogin.data.data.user._id;

  const member = await createUser(adminAuth, "member");
  const outsider = await createUser(adminAuth, "member");

  // --- task assignment increments unreadCount for the assignee --------------

  const project = await axios.post(
    `${BASE}/projects`,
    { name: "Notif smoke project", manager: adminId, members: [member.userId] },
    adminAuth
  );
  assert.equal(project.status, 201, "project created");
  const projectId = project.data.data.project._id;

  const task = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Notif smoke task", assignee: member.userId },
    adminAuth
  );
  assert.equal(task.status, 201, "task created and assigned");
  const taskId = task.data.data.task._id;

  const firstList = await axios.get(`${BASE}/notifications`, member.auth);
  assert.equal(firstList.status, 200, "member fetches own notifications");
  assert.ok(firstList.data.data.unreadCount >= 1, "unreadCount is at least 1 after assignment");
  const assignedNotif = firstList.data.data.notifications.find((n) => n.type === "task_assigned");
  assert.ok(assignedNotif, "a task_assigned notification is present");

  // --- mark one read decrements unreadCount ----------------------------------

  const beforeUnread = firstList.data.data.unreadCount;
  const markOne = await axios.patch(`${BASE}/notifications/${assignedNotif._id}/read`, {}, member.auth);
  assert.equal(markOne.status, 200, "mark one read succeeds");
  assert.equal(markOne.data.data.notification.read, true, "notification is now read");

  const afterOne = await axios.get(`${BASE}/notifications`, member.auth);
  assert.equal(afterOne.data.data.unreadCount, beforeUnread - 1, "unreadCount decremented by one");

  // --- mark-all-read zeroes unreadCount ---------------------------------------

  const markAll = await axios.post(`${BASE}/notifications/mark-all-read`, {}, member.auth);
  assert.equal(markAll.status, 200, "mark-all-read succeeds");

  const afterAll = await axios.get(`${BASE}/notifications`, member.auth);
  assert.equal(afterAll.data.data.unreadCount, 0, "unreadCount is 0 after mark-all-read");

  // --- deadline_reminder appears for a task due in 12h, no dupe on 2nd GET ---

  const dueSoonTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Due soon task", assignee: member.userId, deadline: iso(12) },
    adminAuth
  );
  assert.equal(dueSoonTask.status, 201, "due-soon task created");
  const dueSoonTaskId = dueSoonTask.data.data.task._id;

  const withReminder = await axios.get(`${BASE}/notifications`, member.auth);
  const reminders = withReminder.data.data.notifications.filter(
    (n) => n.type === "deadline_reminder" && n.link === `/tasks/${dueSoonTaskId}`
  );
  assert.equal(reminders.length, 1, "deadline_reminder injected once for the due-soon task");

  const secondReminderGet = await axios.get(`${BASE}/notifications`, member.auth);
  const remindersAgain = secondReminderGet.data.data.notifications.filter(
    (n) => n.type === "deadline_reminder" && n.link === `/tasks/${dueSoonTaskId}`
  );
  assert.equal(remindersAgain.length, 1, "deadline_reminder does not duplicate on a second GET");

  // --- foreign notification PATCH 404s ----------------------------------------

  const foreignPatch = await axios.patch(
    `${BASE}/notifications/${assignedNotif._id}/read`,
    {},
    { ...outsider.auth, validateStatus: () => true }
  );
  assert.equal(foreignPatch.status, 404, "marking someone else's notification read 404s");

  // --- project activity feed: viewer sees task events, outsider is 403'd -----

  const projectActivity = await axios.get(`${BASE}/activity?project=${projectId}`, member.auth);
  assert.equal(projectActivity.status, 200, "project member fetches project activity");
  const entityIds = projectActivity.data.data.activity.map((a) => a.entityId);
  assert.ok(entityIds.includes(taskId), "project activity includes the first task's event");
  assert.ok(entityIds.includes(dueSoonTaskId), "project activity includes the second task's event");

  const outsiderActivity = await axios.get(`${BASE}/activity?project=${projectId}`, {
    ...outsider.auth,
    validateStatus: () => true,
  });
  assert.equal(outsiderActivity.status, 403, "non-member is forbidden from the project activity feed");

  // --- own activity feed returns actor=self items -----------------------------

  const ownActivity = await axios.get(`${BASE}/activity`, adminAuth);
  assert.equal(ownActivity.status, 200, "own activity feed fetched");
  assert.ok(
    ownActivity.data.data.activity.every((a) => String(a.actor._id) === String(adminId)),
    "own activity feed items are all actor=self"
  );
  assert.ok(ownActivity.data.data.activity.length > 0, "own activity feed is non-empty");

  console.log("smoke-notifications: all checks passed");
};

run().catch((error) => {
  console.error("smoke-notifications failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
