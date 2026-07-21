import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const cookieOf = (response) =>
  response.headers["set-cookie"]?.find((c) => c.startsWith("refreshToken="))?.split(";")[0];

const run = async () => {
  const login = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  assert.equal(login.data.success, true, "login succeeds");
  const accessToken = login.data.data.accessToken;
  assert.ok(accessToken, "access token returned");
  const cookie = cookieOf(login);
  assert.ok(cookie, "refresh cookie set");

  const badLogin = await axios.post(
    `${BASE}/auth/login`,
    { email: EMAIL, password: "definitely-wrong" },
    { validateStatus: () => true }
  );
  assert.equal(badLogin.status, 401, "wrong password rejected");

  const me = await axios.get(`${BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  assert.equal(me.data.data.user.email, EMAIL, "me returns the logged-in user");

  const refresh1 = await axios.post(`${BASE}/auth/refresh`, {}, { headers: { Cookie: cookie } });
  assert.ok(refresh1.data.data.accessToken, "refresh returns a new access token");
  const cookie1 = cookieOf(refresh1);
  assert.ok(cookie1, "refresh rotates the cookie");

  // Grace period: the just-replaced token still works for a short window,
  // so a raced 2nd request (2nd tab, retried call) doesn't force-logout.
  const graceRefresh = await axios.post(`${BASE}/auth/refresh`, {}, { headers: { Cookie: cookie } });
  assert.ok(graceRefresh.data.data.accessToken, "previous refresh token still works within the grace window");

  // A token from two rotations back is outside the grace window and must
  // still be rejected — the grace period isn't unlimited reuse.
  const refresh2 = await axios.post(`${BASE}/auth/refresh`, {}, { headers: { Cookie: cookie1 } });
  const cookie2 = cookieOf(refresh2);
  assert.ok(cookie2, "second rotation returns a new cookie");

  const staleRefresh = await axios.post(
    `${BASE}/auth/refresh`,
    {},
    { headers: { Cookie: cookie }, validateStatus: () => true }
  );
  assert.equal(staleRefresh.status, 401, "token older than the grace window is rejected");

  const logout = await axios.post(`${BASE}/auth/logout`, {}, { headers: { Cookie: cookie2 } });
  assert.equal(logout.data.success, true, "logout succeeds");

  const afterLogout = await axios.post(
    `${BASE}/auth/refresh`,
    {},
    { headers: { Cookie: cookie2 }, validateStatus: () => true }
  );
  assert.equal(afterLogout.status, 401, "refresh rejected after logout");

  console.log("smoke-auth: all checks passed");
};

run().catch((error) => {
  console.error("smoke-auth failed:", error.message);
  process.exit(1);
});
