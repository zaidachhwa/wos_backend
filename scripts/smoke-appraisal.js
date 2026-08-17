import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` }, userId: login.data.data.user._id };
};

const createUser = async (adminAuth, role, extra = {}) => {
  const name = `Smoke ${role} ${Math.random().toString(36).slice(2, 6)}`;
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  await axios.post(`${BASE}/users`, { name, email, password, role, ...extra }, adminAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { userId: login.data.data.user._id, auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } } };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  const project = (
    await axios.post(
      `${BASE}/projects`,
      { name: `Smoke Appraisal Project ${Date.now()}`, type: "internal", manager: adminAuth.userId },
      adminAuth
    )
  ).data.data.project;

  const projectModule = (
    await axios.post(`${BASE}/projects/${project._id}/modules`, { name: "Smoke module" }, adminAuth)
  ).data.data.module;

  const member = await createUser(adminAuth, "member");

  // 6 completed tasks: 1 bug, 1 client-change flag (distinct tasks) -> 4 clean.
  // defectCount = 2, totalTasks = 6 -> score = round(100 - 2/6*100) = 67.
  const taskIds = [];
  for (let i = 0; i < 6; i += 1) {
    const type = i === 0 ? "bug" : "task";
    const body = {
      project: project._id,
      title: `Smoke appraisal task ${i}`,
      assignees: [member.userId],
      priority: "low",
      status: "todo",
      type,
      modules: type === "bug" ? [projectModule._id] : [],
      isClientChange: i === 1,
    };
    const created = (await axios.post(`${BASE}/tasks`, body, adminAuth)).data.data.task;
    taskIds.push(created._id);
  }

  for (const id of taskIds) {
    await axios.patch(`${BASE}/tasks/${id}`, { status: "completed" }, adminAuth);
  }

  const month = new Date().toISOString().slice(0, 7);
  const { data } = await axios.get(`${BASE}/appraisal`, { params: { month }, ...adminAuth });
  const row = data.data.rows.find((r) => r.user._id === member.userId);
  assert.ok(row, "member should appear in appraisal roster");
  assert.strictEqual(row.totalTasks, 6, `expected 6 completed tasks, got ${row.totalTasks}`);
  assert.strictEqual(row.bugs, 1, `expected 1 bug, got ${row.bugs}`);
  assert.strictEqual(row.clientChanges, 1, `expected 1 client change, got ${row.clientChanges}`);
  assert.strictEqual(row.score, 67, `expected score 67, got ${row.score}`);

  // Below the MIN_TASKS_FOR_SCORE floor, score must read null, not 0/100.
  const thin = await createUser(adminAuth, "member");
  const thinTask = (
    await axios.post(
      `${BASE}/tasks`,
      {
        project: project._id,
        title: "Smoke thin task",
        assignees: [thin.userId],
        priority: "low",
        status: "todo",
        type: "bug",
        modules: [projectModule._id],
      },
      adminAuth
    )
  ).data.data.task;
  await axios.patch(`${BASE}/tasks/${thinTask._id}`, { status: "completed" }, adminAuth);
  const { data: thinData } = await axios.get(`${BASE}/appraisal`, { params: { month }, ...adminAuth });
  const thinRow = thinData.data.rows.find((r) => r.user._id === thin.userId);
  assert.strictEqual(thinRow.score, null, `expected null score below task floor, got ${thinRow.score}`);

  console.log("smoke-appraisal: OK");
};

run().catch((error) => {
  console.error(error.response?.data || error.message || error);
  process.exit(1);
});
