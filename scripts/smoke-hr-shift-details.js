import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const HR_EMAIL = "hr@wos.local";
const HR_PASSWORD = "Passw0rd!";

const run = async () => {
  console.log("Running smoke-hr-shift-details...");
  const hrLogin = await axios.post(`${BASE}/auth/login`, { email: HR_EMAIL, password: HR_PASSWORD });
  assert.equal(hrLogin.status, 200, "HR login succeeds");
  const auth = { headers: { Authorization: `Bearer ${hrLogin.data.data.accessToken}` } };

  // 1. HR lists users
  const listRes = await axios.get(`${BASE}/users`, auth);
  assert.equal(listRes.status, 200, "HR lists users");
  const users = listRes.data.data.users;
  assert(users.length > 0, "Users list is non-empty");

  const member = users.find((u) => u.role === "member");
  assert(member, "Found a member user");

  // 2. HR updates member shift times & deadline & details
  const updateRes = await axios.patch(
    `${BASE}/users/${member._id}`,
    {
      shiftStart: "09:30",
      shiftEnd: "18:30",
      morningDeadline: "10:15",
      designation: "Senior Frontend Engineer",
    },
    auth
  );
  assert.equal(updateRes.status, 200, "HR updates member shift and designation");
  assert.equal(updateRes.data.data.user.shiftStart, "09:30");
  assert.equal(updateRes.data.data.user.shiftEnd, "18:30");
  assert.equal(updateRes.data.data.user.morningDeadline, "10:15");
  assert.equal(updateRes.data.data.user.designation, "Senior Frontend Engineer");

  // 3. HR gets user by ID
  const getRes = await axios.get(`${BASE}/users/${member._id}`, auth);
  assert.equal(getRes.status, 200, "HR gets user profile");
  assert.equal(getRes.data.data.user.shiftStart, "09:30");
  assert.equal(getRes.data.data.user.morningDeadline, "10:15");

  // 4. Bad shift format should fail
  const badShiftRes = await axios.patch(
    `${BASE}/users/${member._id}`,
    { shiftStart: "invalid" },
    { ...auth, validateStatus: () => true }
  );
  assert.equal(badShiftRes.status, 400, "Malformed shift format rejected");

  // 5. HR cannot modify admin account
  const admin = users.find((u) => u.role === "admin");
  if (admin) {
    const adminEditRes = await axios.patch(
      `${BASE}/users/${admin._id}`,
      { designation: "Hacked" },
      { ...auth, validateStatus: () => true }
    );
    assert.equal(adminEditRes.status, 403, "HR forbidden from modifying admin accounts");
  }

  console.log("smoke-hr-shift-details: all checks passed!");
};

run().catch((error) => {
  console.error("smoke-hr-shift-details failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
