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

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  const manager = await createUser(adminAuth, "manager");
  const member = await createUser(adminAuth, "member", { reportingManager: manager.userId });

  // --- admin dashboard --------------------------------------------------

  const adminDash = await axios.get(`${BASE}/dashboard`, adminAuth);
  assert.equal(adminDash.status, 200, "admin dashboard fetched");
  const adminData = adminDash.data.data;
  assert.ok(adminData.totals && typeof adminData.totals.projectsByStatus === "object", "admin totals.projectsByStatus present");
  assert.ok(typeof adminData.totals.activeUsers === "number", "admin totals.activeUsers present");
  assert.ok(Array.isArray(adminData.teams), "admin teams present");
  assert.ok(Array.isArray(adminData.recentActivity), "admin recentActivity present");

  // --- manager dashboard: pendingFollowUps + workload --------------------

  const managerDash = await axios.get(`${BASE}/dashboard`, manager.auth);
  assert.equal(managerDash.status, 200, "manager dashboard fetched");
  const managerData = managerDash.data.data;
  assert.ok(
    managerData.pendingFollowUps.morning.some((f) => f.user._id === member.userId),
    "manager sees report in pendingFollowUps.morning before they submit"
  );
  const workloadRow = managerData.workload.find((w) => w.user._id === member.userId);
  assert.ok(workloadRow, "manager workload has a row for the report");
  assert.equal(typeof workloadRow.openTasks, "number", "workload row has openTasks count");

  // --- member dashboard: followUpStatus.morning missing -> submitted ----

  const memberDashBefore = await axios.get(`${BASE}/dashboard`, member.auth);
  assert.equal(memberDashBefore.status, 200, "member dashboard fetched");
  assert.equal(
    memberDashBefore.data.data.followUpStatus.morning,
    "missing",
    "member's morning follow-up starts missing"
  );

  const today = new Date().toISOString().slice(0, 10);
  await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Ship B8" }, submit: true },
    member.auth
  );

  const memberDashAfter = await axios.get(`${BASE}/dashboard`, member.auth);
  assert.equal(
    memberDashAfter.data.data.followUpStatus.morning,
    "submitted",
    "member's morning follow-up becomes submitted"
  );
  assert.ok(Array.isArray(memberDashAfter.data.data.projects), "member dashboard has projects list");

  // now the manager should no longer see this report as pending for morning

  const managerDashAfter = await axios.get(`${BASE}/dashboard`, manager.auth);
  assert.ok(
    !managerDashAfter.data.data.pendingFollowUps.morning.some((f) => f.user._id === member.userId),
    "manager no longer sees the report as pending after they submit"
  );

  // --- profile: PATCH name reflects in /api/auth/me ----------------------

  const patchProfile = await axios.patch(`${BASE}/profile`, { name: "Smoke Member Renamed" }, member.auth);
  assert.equal(patchProfile.status, 200, "profile PATCH succeeds");
  assert.equal(patchProfile.data.data.user.name, "Smoke Member Renamed", "profile PATCH returns new name");

  const me = await axios.get(`${BASE}/auth/me`, member.auth);
  assert.equal(me.data.data.user.name, "Smoke Member Renamed", "name change reflected in /api/auth/me");

  const emptyName = await axios.patch(`${BASE}/profile`, { name: "  " }, { ...member.auth, validateStatus: () => true });
  assert.equal(emptyName.status, 400, "empty name is rejected");

  // --- password change (throwaway user) -----------------------------------

  const throwaway = await createUser(adminAuth, "member");

  const shortPassword = await axios.post(
    `${BASE}/profile/password`,
    { currentPassword: throwaway.password, newPassword: "short" },
    { ...throwaway.auth, validateStatus: () => true }
  );
  assert.equal(shortPassword.status, 400, "newPassword under 8 chars is rejected");

  const wrongCurrent = await axios.post(
    `${BASE}/profile/password`,
    { currentPassword: "definitely-wrong", newPassword: "newpassword123" },
    { ...throwaway.auth, validateStatus: () => true }
  );
  assert.equal(wrongCurrent.status, 401, "wrong currentPassword is rejected");

  const changePassword = await axios.post(
    `${BASE}/profile/password`,
    { currentPassword: throwaway.password, newPassword: "newpassword123" },
    throwaway.auth
  );
  assert.equal(changePassword.status, 200, "password change succeeds");

  const oldLogin = await axios.post(
    `${BASE}/auth/login`,
    { email: throwaway.email, password: throwaway.password },
    { validateStatus: () => true }
  );
  assert.equal(oldLogin.status, 401, "old password no longer works");

  const newLogin = await axios.post(
    `${BASE}/auth/login`,
    { email: throwaway.email, password: "newpassword123" },
    { validateStatus: () => true }
  );
  assert.equal(newLogin.status, 200, "new password logs in");

  console.log("smoke-dashboard: all checks passed");
};

run().catch((error) => {
  console.error("smoke-dashboard failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
