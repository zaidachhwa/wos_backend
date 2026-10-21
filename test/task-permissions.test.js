import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// Who may create tasks, and who may see team members' task dates
// (task list + calendar). Throwaway DB, dropped after.
const TEST_URI = process.env.TEST_MONGODB_URI_TASKPERM || "mongodb://127.0.0.1:27017/wos_task_perm_test";
process.env.ACCESS_TOKEN_SECRET ||= "taskperm-test-secret";
process.env.REFRESH_TOKEN_SECRET ||= "taskperm-test-refresh";
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
const range = { from: new Date(Date.now() - 7 * 864e5).toISOString(), to: new Date(Date.now() + 30 * 864e5).toISOString() };
const deadline = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);

before(async () => {
  await mongoose.connect(TEST_URI);
  assert.match(mongoose.connection.name, /test/);
  await mongoose.connection.dropDatabase();
  const eng = await Department.create({ name: "Engineering" });
  const ops = await Department.create({ name: "Operations" });
  const team = await Team.create({ name: "Platform", department: eng._id });
  const mk = (name, role, extra = {}) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: "x", role, ...extra });
  u.admin = await mk("Admin", "admin");
  u.hr = await mk("Hr", "hr");
  u.director = await mk("Director", "director");
  u.lead = await mk("Lead", "manager", { department: eng._id, team: team._id, managedTeam: team._id });
  u.sublead = await mk("Sublead", "sublead", { department: eng._id, managedTeams: [team._id] });
  u.coord = await mk("Coord", "technical_coordinator", { department: eng._id });
  u.member = await mk("Member", "member", { department: eng._id, team: team._id });
  u.pm = await mk("Pm", "member", { department: eng._id, team: team._id });
  u.outsider = await mk("Outsider", "member", { department: ops._id });
  u.navy = await Project.create({ name: "Navy", manager: u.pm._id, members: [u.member._id] });
  u.other = await Project.create({ name: "Other", manager: u.admin._id, members: [u.member._id] });
  // A task with dates assigned to the member, created by admin.
  await Task.create({ project: u.other._id, title: "Dated work", assignees: [u.member._id], deadline, createdBy: u.admin._id });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/api` });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (mongoose.connection.name?.includes("test")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

const newTask = (who, project, assignees, title = `T-${who}`) =>
  call(() => api.post("/tasks", { project: project._id, title, assignees: assignees.map((a) => a._id), deadline }, as(who)));

describe("who can create tasks", () => {
  test("a team member can no longer create a task, not even for themselves", async () => {
    const r = await newTask("member", u.other, [u.member]);
    assert.equal(r.status, 403);
  });
  test("a team member who manages the project (Project Manager) can", async () => {
    const r = await newTask("pm", u.navy, [u.member]);
    assert.equal(r.status, 201, r.data?.message);
    assert.equal(r.data.data.task.approvalStatus, "not_required");
    assert.equal((await newTask("pm", u.other, [u.member])).status, 403, "only in projects they manage");
  });
  test("Team Lead, Sub Lead, Technical Coordinator and HR can assign to members", async () => {
    for (const who of ["lead", "sublead", "coord", "hr"]) {
      const r = await newTask(who, u.other, [u.member]);
      assert.equal(r.status, 201, `${who}: ${r.data?.message}`);
    }
  });
  test("the Director still assigns only to HR", async () => {
    assert.equal((await newTask("director", u.other, [u.member])).status, 403);
    assert.equal((await newTask("director", u.other, [u.hr])).status, 201);
  });
});

describe("team members' task dates are visible to their leads", () => {
  const sees = async (who, title = "Dated work") => {
    const r = await call(() => api.get("/tasks", { params: { assignee: String(u.member._id) }, ...as(who) }));
    return (r.data?.data?.tasks || []).some((t) => t.title === title && t.deadline);
  };
  const calendar = (who) => call(() => api.get("/calendar", { params: { ...range, user: String(u.member._id) }, ...as(who) }));

  test("task list shows the member's dated tasks to every lead role", async () => {
    for (const who of ["admin", "hr", "lead", "sublead", "coord"]) assert.ok(await sees(who), who);
    // A Project Manager sees the member's tasks in the project they manage
    // (not in unrelated projects).
    assert.ok(await sees("pm", "T-pm"), "pm: own project");
    assert.equal(await sees("pm"), false, "pm: not other projects");
  });

  test("calendar: Admin, HR, Team Lead, Sub Lead, Coordinator and Project Manager can open the member's calendar", async () => {
    for (const who of ["admin", "hr", "lead", "sublead", "coord", "pm"]) {
      const r = await calendar(who);
      assert.equal(r.status, 200, who);
      assert.ok(r.data.data.items.some((i) => i.type === "task_deadline" && i.title === "Dated work"), who);
    }
  });

  test("calendar people picker and boundaries", async () => {
    const coordPeople = (await api.get("/calendar/people", as("coord"))).data.data.users.map((x) => x.name);
    assert.ok(coordPeople.includes("Member") && !coordPeople.includes("Outsider"), "coordinator: own department only");
    assert.equal((await calendar("outsider")).status, 403, "an unrelated member can't");
    assert.equal((await api.get("/calendar/people", as("member"))).data.data.users.length, 0);
  });
});
