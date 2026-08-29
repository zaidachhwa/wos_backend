import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const run = async () => {
  const login = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  const auth = { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };

  const memberEmail = `member+${Date.now()}@wos.local`;
  const created = await axios.post(
    `${BASE}/users`,
    { name: "Test Member", email: memberEmail, password: "memberpass123", role: "member", shiftStart: "09:00", shiftEnd: "18:00" },
    auth
  );
  assert.equal(created.status, 201, "admin creates a user");
  assert.equal(created.data.data.user.shiftStart, "09:00", "shift start set at creation");
  assert.equal(created.data.data.user.shiftEnd, "18:00", "shift end set at creation");

  const badShift = await axios.post(
    `${BASE}/users`,
    { name: "Bad Shift", email: `badshift+${Date.now()}@wos.local`, password: "memberpass123", role: "member", shiftStart: "9am" },
    { ...auth, validateStatus: () => true }
  );
  assert.equal(badShift.status, 400, "a malformed shift time is rejected at creation");

  const dup = await axios.post(
    `${BASE}/users`,
    { name: "Dup", email: memberEmail, password: "memberpass123", role: "member" },
    { ...auth, validateStatus: () => true }
  );
  assert.equal(dup.status, 409, "duplicate email rejected");

  const badRole = await axios.post(
    `${BASE}/users`,
    { name: "Bad", email: `bad+${Date.now()}@wos.local`, password: "memberpass123", role: "boss" },
    { ...auth, validateStatus: () => true }
  );
  assert.equal(badRole.status, 400, "invalid role rejected");

  const memberLogin = await axios.post(`${BASE}/auth/login`, {
    email: memberEmail,
    password: "memberpass123",
  });
  assert.equal(memberLogin.data.data.user.role, "member", "created member can log in");

  const forbidden = await axios.get(`${BASE}/users`, {
    headers: { Authorization: `Bearer ${memberLogin.data.data.accessToken}` },
    validateStatus: () => true,
  });
  assert.equal(forbidden.status, 403, "member cannot list users");

  const memberId = created.data.data.user._id;

  const updatedShift = await axios.patch(`${BASE}/users/${memberId}`, { shiftStart: "10:00", shiftEnd: "19:00" }, auth);
  assert.equal(updatedShift.data.data.user.shiftStart, "10:00", "admin can edit another user's shift start");
  assert.equal(updatedShift.data.data.user.shiftEnd, "19:00", "admin can edit another user's shift end");

  const badShiftUpdate = await axios.patch(
    `${BASE}/users/${memberId}`,
    { shiftStart: "25:00" },
    { ...auth, validateStatus: () => true }
  );
  assert.equal(badShiftUpdate.status, 400, "a malformed shift time is rejected on update");

  await axios.patch(`${BASE}/users/${memberId}`, { isActive: false }, auth);
  const inactiveLogin = await axios.post(
    `${BASE}/auth/login`,
    { email: memberEmail, password: "memberpass123" },
    { validateStatus: () => true }
  );
  assert.equal(inactiveLogin.status, 401, "deactivated user cannot log in");

  console.log("smoke-users: all checks passed");
};

run().catch((error) => {
  console.error("smoke-users failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
