import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const HAS_KEY = Boolean(process.env.RESEND_API_KEY);

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role, extra = {}) => {
  const name = `Smoke ${role} ${Math.random().toString(36).slice(2, 6)}`;
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  const res = await axios.post(`${BASE}/users`, { name, email, password, role, ...extra }, adminAuth);
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    name,
    userId: res.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);
  const member = await createUser(adminAuth, "member");

  const memberForbidden = await axios.post(
    `${BASE}/followups/send-evening-reminders`,
    {},
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberForbidden.status, 403, "only admin can trigger the evening reminder sweep");

  const sweep = await axios.post(`${BASE}/followups/send-evening-reminders`, {}, adminAuth);
  assert.equal(sweep.status, 200, "admin can trigger the sweep");

  if (!HAS_KEY) {
    assert.equal(sweep.data.data.skipped, true, "sweep no-ops without RESEND_API_KEY");
    assert.equal(sweep.data.data.sent, 0, "no emails sent without a configured key");
    console.log("smoke-followup-reminders: all checks passed (no RESEND_API_KEY — no-op path verified)");
    return;
  }

  // With a real key: a member who hasn't submitted today's evening
  // follow-up is eligible and gets emailed exactly once even if the sweep
  // is triggered twice in a row (idempotency marker).
  assert.ok(sweep.data.data.eligible >= 1, "at least the freshly-created member is eligible");
  const firstSent = sweep.data.data.sent;
  assert.ok(firstSent >= 1, "at least one email was sent");

  const secondSweep = await axios.post(`${BASE}/followups/send-evening-reminders`, {}, adminAuth);
  assert.equal(secondSweep.data.data.sent, 0, "re-running the sweep the same day re-sends nobody (idempotent)");

  console.log("smoke-followup-reminders: all checks passed (live Resend)");
};

run().catch((error) => {
  console.error("smoke-followup-reminders failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
