import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// HR permissions: add/approve tasks, add departments/teams, and per-project
// hours in the evening follow-up team view. Throwaway DB, dropped after.
const TEST_URI = process.env.TEST_MONGODB_URI_HR || "mongodb://127.0.0.1:27017/wos_hr_perm_test";
process.env.ACCESS_TOKEN_SECRET ||= "hr-perm-test-secret";
process.env.REFRESH_TOKEN_SECRET ||= "hr-perm-test-refresh";
process.env.CLIENT_ORIGIN ||= "http://localhost:3000";
delete process.env.RESEND_API_KEY;

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: Department } = await import("../src/models/Department.js");
const { default: Team } = await import("../src/models/Team.js");
const { default: Project } = await import("../src/models/Project.js");
const { default: FollowUp } = await import("../src/models/FollowUp.js");

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
  const mk = (name, role, extra = {}) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: "x", role, ...extra });
  u.admin = await mk("Admin", "admin");
  u.hr = await mk("Hr", "hr");
  u.lead = await mk("Lead", "manager", { department: dept._id, team: team._id, managedTeam: team._id });
  u.member = await mk("Member", "member", { department: dept._id, team: team._id, reportingManager: u.lead._id });
  u.project = await Project.create({ name: "Navy", manager: u.lead._id, members: [u.member._id] });
  u.project2 = await Project.create({ name: "WOS", manager: u.lead._id, members: [u.member._id] });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/api` });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (mongoose.connection.name?.includes("test")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("HR and tasks", () => {
  test("HR can add a task for a team member (no approval needed)", async () => {
    const r = await call(() =>
      api.post("/tasks", { project: u.project._id, title: "HR-assigned onboarding", assignees: [u.member._id], priority: "medium" }, as("hr"))
    );
    assert.equal(r.status, 201, r.data?.message);
    assert.equal(r.data.data.task.approvalStatus, "not_required");
    const edit = await call(() => api.patch(`/tasks/${r.data.data.task._id}`, { priority: "high" }, as("hr")));
    assert.equal(edit.status, 200, "HR can edit a task HR created");
  });

  test("HR can approve and reject tasks proposed by team members", async () => {
    const propose = (title) => api.post("/tasks", { project: u.project._id, title, priority: "low" }, as("member"));
    const a = (await propose("Proposal A")).data.data.task;
    const b = (await propose("Proposal B")).data.data.task;
    assert.equal(a.approvalStatus, "pending");

    const pending = await api.get("/tasks", { params: { approvalStatus: "pending" }, ...as("hr") });
    assert.ok(pending.data.data.tasks.some((t) => t._id === a._id), "HR sees the pending queue");

    const ok = await call(() => api.patch(`/tasks/${a._id}/approve`, {}, as("hr")));
    assert.equal(ok.status, 200, ok.data?.message);
    assert.equal(ok.data.data.task.approvalStatus, "approved");
    const no = await call(() => api.patch(`/tasks/${b._id}/reject`, { approvalComment: "Duplicate" }, as("hr")));
    assert.equal(no.status, 200);
    assert.equal(no.data.data.task.approvalStatus, "rejected");
  });

  test("HR still can't edit tasks HR didn't create", async () => {
    const t = (await api.post("/tasks", { project: u.project._id, title: "Lead task", assignees: [u.member._id] }, as("lead"))).data.data.task;
    const r = await call(() => api.patch(`/tasks/${t._id}`, { priority: "high" }, as("hr")));
    assert.equal(r.status, 403);
  });
});

describe("HR and org structure", () => {
  test("HR can add and rename departments and teams, but not delete them", async () => {
    const d = await call(() => api.post("/departments", { name: "Operations" }, as("hr")));
    assert.equal(d.status, 201, d.data?.message);
    const deptId = d.data.data.department._id;
    assert.equal((await call(() => api.patch(`/departments/${deptId}`, { name: "Ops" }, as("hr")))).status, 200);
    const t = await call(() => api.post("/teams", { name: "Support", department: deptId }, as("hr")));
    assert.equal(t.status, 201, t.data?.message);
    assert.equal((await call(() => api.delete(`/departments/${deptId}`, as("hr")))).status, 403);
    assert.equal((await call(() => api.delete(`/teams/${t.data.data.team._id}`, as("hr")))).status, 403);
  });
});

describe("HR and evening follow-ups", () => {
  test("team view includes project names and hours for the evening follow-up", async () => {
    const date = "2026-09-15";
    await FollowUp.create({
      user: u.member._id,
      date,
      type: "evening",
      status: "submitted",
      submittedAt: new Date(),
      evening: {
        completedWork: "x",
        projects: [
          { project: u.project._id, hours: 3, minutes: 30, totalMinutes: 210 },
          { project: u.project2._id, hours: 2, minutes: 0, totalMinutes: 120 },
        ],
      },
    });
    const r = await api.get("/followups", { params: { scope: "team", date, type: "evening" }, ...as("hr") });
    const row = r.data.data.followUps.find((f) => String(f.user._id) === String(u.member._id));
    assert.deepEqual(
      row.evening.projects.map((p) => [p.project.name, p.totalMinutes]),
      [
        ["Navy", 210],
        ["WOS", 120],
      ]
    );
  });
});
