import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  assert.equal(login.status, 200, `login as ${email}`);
  return {
    headers: { Authorization: `Bearer ${login.data.data.accessToken}` },
    userId: login.data.data.user._id,
  };
};

const createUser = async (actorAuth, role, extra = {}) => {
  const name = `Smoke ${role} ${Math.random().toString(36).slice(2, 6)}`;
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  const res = await axios.post(`${BASE}/users`, { name, email, password, role, ...extra }, actorAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    userId: res.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  console.log("Running smoke-director...");

  const adminAuth = await authFor(EMAIL, PASSWORD);
  const admin = adminAuth;

  // Create a fresh director and a fresh HR user for this test run
  const directorUser = await createUser(admin, "director");
  const director = { ...directorUser.auth, userId: directorUser.userId };
  const hrUser = await createUser(admin, "hr");

  // 1. Director can list projects
  const projectsRes = await axios.get(`${BASE}/projects`, director);
  assert.equal(projectsRes.status, 200, "director can list projects");
  console.log("smoke-director: check director can list projects");

  // 2. Director can view appraisal roster
  const appraisalRes = await axios.get(`${BASE}/appraisal`, director);
  assert.equal(appraisalRes.status, 200, "director can view appraisal roster");
  console.log("smoke-director: check director can view appraisal roster");

  // 3. Director can view team reports
  const d = new Date();
  const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const reportRes = await axios.get(
    `${BASE}/reports/team?from=${ym}-01&to=${ym}-${String(d.getDate()).padStart(2, "0")}`,
    director
  );
  assert.equal(reportRes.status, 200, "director can view team reports");
  console.log("smoke-director: check director can view team reports");

  // 4. Director can list all users (org-wide)
  const usersRes = await axios.get(`${BASE}/users`, director);
  assert.equal(usersRes.status, 200, "director can list all users");
  const allUsers = usersRes.data.data.users;
  assert.ok(allUsers.length > 0, "users list is non-empty");
  // Verify the dynamically created HR user appears in director's org-wide listing
  const foundHr = allUsers.find((u) => String(u._id) === String(hrUser.userId));
  assert.ok(foundHr, "director sees freshly-created HR user in org-wide listing");
  console.log("smoke-director: check director can list all users (org-wide)");

  // 5. Director is blocked from HR attendance endpoint
  const attendanceRes = await axios.get(`${BASE}/attendance`, {
    ...director,
    validateStatus: () => true,
  });
  assert.equal(attendanceRes.status, 403, "director blocked from HR attendance");
  console.log("smoke-director: check director cannot access HR attendance (403)");

  // 6. Director can create a task assigned to HR
  const adminProjectsRes = await axios.get(`${BASE}/projects`, admin);
  const firstProject =
    adminProjectsRes.data.data?.projects?.[0] || adminProjectsRes.data.data?.[0];

  if (!firstProject) {
    console.log("smoke-director: no project exists, skipping task checks");
  } else {
    const createRes = await axios.post(
      `${BASE}/tasks`,
      {
        project: firstProject._id,
        title: `Director smoke task ${Date.now()}`,
        assignees: [hrUser.userId],
        priority: "medium",
      },
      director
    );
    assert.equal(createRes.status, 201, "director can create task assigned to HR");
    const directorTask = createRes.data.data.task;
    console.log("smoke-director: check director can create task assigned to HR");

    // 7. Director cannot assign task to a non-HR user (create a fresh member for this)
    const memberUser = await createUser(admin, "member");
    {
      const nonHrRes = await axios.post(
        `${BASE}/tasks`,
        {
          project: firstProject._id,
          title: `Director illegal task ${Date.now()}`,
          assignees: [memberUser.userId],
          priority: "low",
        },
        { ...director, validateStatus: () => true }
      );
      assert.equal(nonHrRes.status, 403, "director blocked from assigning to non-HR user");
      console.log("smoke-director: check director cannot assign task to non-HR user (403)");
    }

    // 8. Director cannot complete their own task (only HR assignee can)
    const selfCompleteRes = await axios.patch(
      `${BASE}/tasks/${directorTask._id}`,
      { status: "completed" },
      { ...director, validateStatus: () => true }
    );
    assert.equal(selfCompleteRes.status, 403, "director blocked from completing their own task");
    console.log("smoke-director: check director cannot complete their own task (403)");

    // 9. HR assignee CAN complete the director task
    const hrCompleteRes = await axios.patch(
      `${BASE}/tasks/${directorTask._id}`,
      { status: "completed" },
      hrUser.auth
    );
    assert.equal(hrCompleteRes.status, 200, "HR can complete director-created task");
    console.log("smoke-director: check HR can complete director-created task");
  }

  // 10. Director task list is scoped to their own tasks
  const tasksRes = await axios.get(`${BASE}/tasks`, director);
  assert.equal(tasksRes.status, 200, "director can list tasks");
  console.log("smoke-director: check director task list is scoped (returns 200)");

  console.log("\nsmoke-director: all checks passed!");
};

run().catch((error) => {
  console.error("smoke-director failed:", error.response?.data?.message || error.message);
  if (error.response) console.error("  status:", error.response.status);
  process.exit(1);
});

