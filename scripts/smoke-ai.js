import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const HAS_KEY = Boolean(process.env.GEMINI_API_KEY);

const run = async () => {
  const login = await axios.post(`${BASE}/auth/login`, { email: EMAIL, password: PASSWORD });
  const auth = {
    headers: { Authorization: `Bearer ${login.data.data.accessToken}` },
    validateStatus: () => true,
  };

  const endpoints = [
    ["daily-planner", {}],
    ["workload", {}],
    ["project-health", { projectId: "000000000000000000000000" }],
    ["chat", { message: "Which projects are delayed?" }],
  ];

  if (!HAS_KEY) {
    for (const [name, body] of endpoints) {
      const res = await axios.post(`${BASE}/ai/${name}`, body, auth);
      assert.equal(res.status, 503, `${name} returns 503 without key`);
      assert.equal(res.data.success, false, `${name} envelope success false`);
      assert.equal(res.data.message, "AI is not configured", `${name} envelope message`);
    }
    console.log("smoke-ai: all checks passed (no GEMINI_API_KEY — 503 path verified)");
    return;
  }

  const planner = await axios.post(`${BASE}/ai/daily-planner`, {}, auth);
  assert.equal(planner.status, 200, "daily-planner 200");
  assert.ok(
    typeof planner.data.data.plan === "string" && planner.data.data.plan.length > 0,
    "daily-planner returns a non-empty plan"
  );

  // need a real project for health
  const project = await axios.post(
    `${BASE}/projects`,
    { name: `AI Smoke ${Date.now()}`, manager: login.data.data.user._id },
    auth
  );
  const health = await axios.post(
    `${BASE}/ai/project-health`,
    { projectId: project.data.data.project._id },
    auth
  );
  assert.equal(health.status, 200, "project-health 200");
  const score = health.data.data.healthScore;
  assert.ok(typeof score === "number" && score >= 0 && score <= 100, "healthScore is 0-100");
  assert.ok(["low", "medium", "high"].includes(health.data.data.riskLevel), "riskLevel valid");

  console.log("smoke-ai: all checks passed (live Gemini)");
};

run().catch((error) => {
  console.error("smoke-ai failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
