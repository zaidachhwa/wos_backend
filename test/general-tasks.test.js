import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// Director "General" tasks. Throwaway DB, dropped after.
const TEST_URI = process.env.TEST_MONGODB_URI_GENERAL || "mongodb://127.0.0.1:27017/wos_general_tasks_test";
process.env.ACCESS_TOKEN_SECRET ||= "general-test-secret";
process.env.REFRESH_TOKEN_SECRET ||= "general-test-refresh";
process.env.CLIENT_ORIGIN ||= "http://localhost:3000";
delete process.env.RESEND_API_KEY;

const { default: app } = await import("../src/app.js");
const { default: User } = await import("../src/models/User.js");
const { default: GeneralTask } = await import("../src/models/GeneralTask.js");
const { assignmentStatus } = await import("../src/controllers/generalTaskController.js");

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
const hoursFromNow = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();

before(async () => {
  await mongoose.connect(TEST_URI);
  assert.match(mongoose.connection.name, /test/);
  await mongoose.connection.dropDatabase();
  const mk = (name, role) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: "x", role });
  u.director = await mk("Director", "director");
  u.hr = await mk("Hr", "hr");
  u.member = await mk("Member", "member");
  u.lead = await mk("Lead", "manager");
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/api` });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (mongoose.connection.name?.includes("test")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("status rules", () => {
  test("completed / delayed / overdue / pending", () => {
    const due = new Date("2026-10-15T17:00:00+05:30");
    assert.equal(assignmentStatus(due, new Date("2026-10-15T16:00:00+05:30")), "completed");
    assert.equal(assignmentStatus(due, new Date("2026-10-15T17:30:00+05:30")), "delayed");
    assert.equal(assignmentStatus(due, null, new Date("2026-10-15T18:00:00+05:30")), "overdue");
    assert.equal(assignmentStatus(due, null, new Date("2026-10-15T10:00:00+05:30")), "pending");
  });
});

describe("general tasks", () => {
  let taskId;

  test("only the director (or admin) can create; any employee can be assigned", async () => {
    const body = { title: "Submit Q3 summary", description: "One page", dueAt: hoursFromNow(24), assignees: [u.member._id, u.hr._id, u.lead._id] };
    assert.equal((await call(() => api.post("/general-tasks", body, as("hr")))).status, 403);
    const r = await call(() => api.post("/general-tasks", body, as("director")));
    assert.equal(r.status, 201, r.data?.message);
    assert.equal(r.data.data.task.assignments.length, 3);
    assert.equal(r.data.data.task.stats.pending, 3);
    taskId = r.data.data.task._id;
  });

  test("validation: title, due time and at least one assignee", async () => {
    assert.equal((await call(() => api.post("/general-tasks", { title: "", dueAt: hoursFromNow(1), assignees: [u.member._id] }, as("director")))).status, 400);
    assert.equal((await call(() => api.post("/general-tasks", { title: "x", assignees: [u.member._id] }, as("director")))).status, 400);
    assert.equal((await call(() => api.post("/general-tasks", { title: "x", dueAt: hoursFromNow(1), assignees: [] }, as("director")))).status, 400);
  });

  test("assignees see it in their own panel and complete it individually", async () => {
    const mine = await api.get("/general-tasks", as("member"));
    assert.equal(mine.data.data.tasks.length, 1);
    assert.equal(mine.data.data.tasks[0].myStatus, "pending");

    const done = await call(() => api.post(`/general-tasks/${taskId}/done`, { done: true }, as("member")));
    assert.equal(done.status, 200);
    assert.equal(done.data.data.task.stats.completed, 1);
    assert.equal(done.data.data.task.stats.pending, 2, "the other assignees are unaffected");

    // Someone not assigned can't complete it.
    const other = await User.create({ name: "Other", email: "other@test.local", password: "x", role: "member" });
    u.other = other;
    assert.equal((await call(() => api.post(`/general-tasks/${taskId}/done`, {}, as("other")))).status, 404);
    assert.equal((await api.get("/general-tasks", as("other"))).data.data.tasks.length, 0);
  });

  test("director stats: completed, delayed and overdue, overall and per person", async () => {
    // A task already past due: HR finishes late, Lead never does.
    const past = await GeneralTask.create({
      title: "Old task",
      dueAt: new Date(Date.now() - 2 * 3600 * 1000),
      createdBy: u.director._id,
      assignments: [{ user: u.hr._id }, { user: u.lead._id }],
    });
    await api.post(`/general-tasks/${past._id}/done`, {}, as("hr"));

    const r = await api.get("/general-tasks", { params: { scope: "created" }, ...as("director") });
    const s = r.data.data.stats;
    assert.deepEqual(s, { total: 5, completed: 1, delayed: 1, overdue: 1, pending: 2 });
    const lead = r.data.data.byPerson.find((p) => p.user.name === "Lead");
    assert.equal(lead.overdue, 1);

    const overdueOnly = await api.get("/general-tasks", { params: { scope: "created", status: "overdue" }, ...as("director") });
    assert.deepEqual(overdueOnly.data.data.tasks.map((t) => t.title), ["Old task"]);

    const hrView = await api.get("/general-tasks", as("hr"));
    assert.equal(hrView.data.data.stats.delayed, 1);
    assert.equal((await call(() => api.get("/general-tasks", { params: { scope: "created" }, ...as("hr") }))).status, 403);
  });

  test("editing keeps existing assignees' progress; only the creator can edit/delete", async () => {
    const r = await call(() => api.patch(`/general-tasks/${taskId}`, { assignees: [u.member._id, u.other._id] }, as("director")));
    assert.equal(r.status, 200, r.data?.message);
    const member = r.data.data.task.assignments.find((a) => a.user.name === "Member");
    assert.equal(member.status, "completed", "Member's done state survives the edit");
    assert.equal(r.data.data.task.assignments.length, 2);

    assert.equal((await call(() => api.patch(`/general-tasks/${taskId}`, { title: "x" }, as("member")))).status, 403);
    assert.equal((await call(() => api.delete(`/general-tasks/${taskId}`, as("director")))).status, 200);
  });
});
