import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

const TEST_URI = process.env.TEST_MONGODB_URI_HTO || "mongodb://127.0.0.1:27017/wos_hto_test";
process.env.ACCESS_TOKEN_SECRET ||= "hto-test-secret";
process.env.REFRESH_TOKEN_SECRET ||= "hto-test-refresh";
process.env.CLIENT_ORIGIN ||= "http://localhost:3000";
delete process.env.RESEND_API_KEY;
delete process.env.SMTP_HOST;
delete process.env.SMTP_SERVICE;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: Department } = await import("../src/models/Department.js");
const { default: Team } = await import("../src/models/Team.js");
const { default: Project } = await import("../src/models/Project.js");
const { default: Task } = await import("../src/models/Task.js");
const { default: BonusRequest } = await import("../src/models/BonusRequest.js");
const { bonusWindow } = await import("../src/controllers/feedbackController.js");

let server;
let api;
const u = {};
const as = (who) => ({ headers: { Authorization: `Bearer ${jwt.sign({ sub: String(u[who]._id) }, process.env.ACCESS_TOKEN_SECRET)}` } });
const call = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (error.response) return error.response;
    throw error;
  }
};

before(async () => {
  await mongoose.connect(TEST_URI);
  assert.match(mongoose.connection.name, /test/);
  await mongoose.connection.dropDatabase();

  const dept = await Department.create({ name: "Engineering" });
  const team = await Team.create({ name: "Platform", department: dept._id });
  const mk = (name, role, extra = {}) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: "password123", role, ...extra });

  u.admin = await mk("Admin", "admin");
  u.hto = await mk("Hto", "head_of_technical_operations", { designation: "Head - Technical Operations" });
  u.member = await mk("Member", "member", { department: dept._id, team: team._id });
  u.project = await Project.create({ name: "Core", manager: u.admin._id, members: [u.member._id] });

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/api` });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (mongoose.connection.name?.includes("test")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("Head of Technical Operations Admin permissions", () => {
  test("HTO can create and delete departments", async () => {
    const res = await call(() => api.post("/departments", { name: "Infra Ops" }, as("hto")));
    assert.equal(res.status, 201);
    const deptId = res.data.data.department._id;

    const delRes = await call(() => api.delete(`/departments/${deptId}`, as("hto")));
    assert.equal(delRes.status, 200);
  });

  test("HTO can create, edit, and delete projects", async () => {
    const res = await call(() =>
      api.post("/projects", { name: "Infra Migration", type: "internal", status: "planning", manager: u.hto._id }, as("hto"))
    );
    assert.equal(res.status, 201);
    const projId = res.data.data.project._id;

    const editRes = await call(() => api.patch(`/projects/${projId}`, { status: "active" }, as("hto")));
    assert.equal(editRes.status, 200);

    const delRes = await call(() => api.delete(`/projects/${projId}`, as("hto")));
    assert.equal(delRes.status, 200);
  });

  test("HTO can create, assign and delete tasks", async () => {
    const res = await call(() =>
      api.post("/tasks", { project: u.project._id, title: "Configure Kubernetes", assignees: [u.member._id], priority: "high" }, as("hto"))
    );
    assert.equal(res.status, 201);
    const taskId = res.data.data.task._id;

    const delRes = await call(() => api.delete(`/tasks/${taskId}`, as("hto")));
    assert.equal(delRes.status, 200);
  });

  test("HTO can access admin dashboard", async () => {
    const res = await call(() => api.get("/dashboard", as("hto")));
    assert.equal(res.status, 200);
    assert.ok(res.data.data.totals, "HTO receives the admin dashboard totals");
    assert.ok(res.data.data.generalTasksOverview, "HTO receives generalTasksOverview");
  });
});

describe("Head of Technical Operations Special Bonus restriction", () => {
  test("HTO CANNOT view other employees' special bonus requests (GET /api/bonus-requests forbidden)", async () => {
    // Seed a bonus request from member
    const win = bonusWindow();
    await BonusRequest.create({ user: u.member._id, month: win.month, reason: "Shipped the big migration ahead of schedule" });

    // Admin CAN view it
    const adminRes = await call(() => api.get("/bonus-requests", as("admin")));
    assert.equal(adminRes.status, 200);
    assert.ok(adminRes.data.data.requests.length >= 1);

    // HTO is FORBIDDEN
    const htoRes = await call(() => api.get("/bonus-requests", as("hto")));
    assert.equal(htoRes.status, 403);
    assert.match(htoRes.data.message, /cannot view special bonus requests of other/i);
  });

  test("HTO CAN still view and manage their own bonus request (/api/bonus-requests/mine)", async () => {
    const res = await call(() => api.get("/bonus-requests/mine", as("hto")));
    assert.equal(res.status, 200);
    assert.ok(res.data.data.window);
  });
});
