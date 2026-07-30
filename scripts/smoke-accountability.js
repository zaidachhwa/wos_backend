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

  console.log("smoke-accountability: all checks passed");
};

run().catch((error) => {
  console.error("smoke-accountability failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
