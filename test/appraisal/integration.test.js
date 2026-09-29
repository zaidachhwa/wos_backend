import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// Runs the real Express app + services against a throwaway database. Never
// point this at a real one: it drops the database before and after.
const TEST_URI = process.env.TEST_MONGODB_URI || "mongodb://127.0.0.1:27017/wos_appraisal_test";
process.env.ACCESS_TOKEN_SECRET ||= "appraisal-test-secret";
process.env.REFRESH_TOKEN_SECRET ||= "appraisal-test-refresh";
process.env.CLIENT_ORIGIN ||= "http://localhost:3000";
delete process.env.RESEND_API_KEY; // belt and braces: no real mail from tests

const { default: app } = await import("../../src/app.js");
const { default: User } = await import("../../src/models/User.js");
const { default: Department } = await import("../../src/models/Department.js");
const { default: Team } = await import("../../src/models/Team.js");
const { default: Project } = await import("../../src/models/Project.js");
const { default: Task } = await import("../../src/models/Task.js");
const { default: Activity } = await import("../../src/models/Activity.js");
const { default: Attendance } = await import("../../src/models/Attendance.js");
const { default: FollowUp } = await import("../../src/models/FollowUp.js");
const { default: EmployeeAppraisal } = await import("../../src/models/EmployeeAppraisal.js");
const { default: AppraisalEmailLog } = await import("../../src/models/AppraisalEmailLog.js");
const { default: AppraisalAuditLog } = await import("../../src/models/AppraisalAuditLog.js");
const { default: AppraisalCriterion } = await import("../../src/models/AppraisalCriterion.js");
const { ensureAppraisalConfig } = await import("../../src/services/appraisal/appraisalConfig.js");
const { ensureDrafts, getOrCreateDraft } = await import("../../src/services/appraisal/appraisalService.js");
const { queueDueEmails, processEmailQueue, setEmailSender } = await import("../../src/services/appraisal/appraisalEmails.js");
const { closeMonth } = await import("../../src/services/appraisal/appraisalScheduler.js");
const { istMonthOf, shiftMonth, monthPeriod } = await import("../../src/services/appraisal/appraisalPeriod.js");

const MONTH = shiftMonth(istMonthOf(), -1); // a month that has already ended
const PERIOD = monthPeriod(MONTH);
const inMonth = (day, time = "10:00:00") => new Date(`${MONTH}-${String(day).padStart(2, "0")}T${time}+05:30`);

let server;
let api;
const users = {};
const as = (who) => ({ headers: { Authorization: `Bearer ${jwt.sign({ sub: String(users[who]._id) }, process.env.ACCESS_TOKEN_SECRET)}` } });
const call = async (fn) => {
  try {
    return await fn();
  } catch (error) {
    if (error.response) return error.response;
    throw error;
  }
};

const MANUAL = ["discipline", "policy_compliance", "helping_nature", "professionalism", "critical_behaviour"];

const rateAll = async (appraisalId, ratingKey = "excellent") => {
  for (const key of MANUAL) {
    const r = await call(() => api.patch(`/appraisals/${appraisalId}/evaluations/${key}`, { ratingKey, comment: "ok" }, as("hr")));
    assert.equal(r.status, 200, r.data?.message);
  }
};

const appraisalFor = (who) => EmployeeAppraisal.findOne({ user: users[who]._id, month: MONTH });

before(async () => {
  await mongoose.connect(TEST_URI);
  assert.match(mongoose.connection.name, /test/, "refusing to run against a non-test database");
  await mongoose.connection.dropDatabase();
  await ensureAppraisalConfig();

  const dept = await Department.create({ name: "Technology" });
  const team = await Team.create({ name: "Platform", department: dept._id });
  const mk = (name, role, extra = {}) =>
    User.create({ name, email: `${name.toLowerCase()}@test.local`, password: "x", role, department: dept._id, team: team._id, ...extra });
  users.admin = await mk("Admin", "admin");
  users.hr = await mk("Hr", "hr");
  users.lead = await mk("Lead", "manager", { managedTeam: team._id });
  users.john = await mk("John", "member");
  users.sara = await mk("Sara", "member");
  users.outsider = await mk("Outsider", "member", { team: null });
  users.qa = await mk("Qa", "qa");

  // John's work this month: one task done on time, one left overdue.
  const project = await Project.create({ name: "Navy", manager: users.lead._id, members: [users.john._id], weightage: 40 });
  const raw = (doc) => Task.collection.insertOne({ project: project._id, assignees: [users.john._id], approvalStatus: "not_required", type: "task", isClientChange: false, ...doc });
  const done = await raw({ title: "Done", status: "completed", deadline: new Date(`${MONTH}-20T00:00:00Z`), createdAt: inMonth(2), updatedAt: inMonth(10) });
  await raw({ title: "Late", status: "in_progress", deadline: new Date(`${MONTH}-15T00:00:00Z`), createdAt: inMonth(2), updatedAt: inMonth(3) });
  await Activity.collection.insertOne({ entityType: "task", entityId: done.insertedId, action: "updated", meta: { statusTo: "completed" }, createdAt: inMonth(10), updatedAt: inMonth(10) });

  // Follow-up/attendance noise that must NOT reach the appraisal.
  for (const day of [3, 4, 5]) {
    const date = `${MONTH}-0${day}`;
    await Attendance.create({ user: users.john._id, date, type: "late", source: "auto" });
    await Attendance.create({ user: users.sara._id, date, type: "leave", source: "auto" });
    await FollowUp.create({ user: users.john._id, date, type: "morning", status: "submitted", submittedAt: inMonth(day, "13:00:00") });
  }

  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/api` });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (mongoose.connection.name?.includes("test")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("HR-entered leaves and late marks", () => {
  test("HR bulk-enters leaves/late marks and the engine uses exactly those values", async () => {
    const r = await call(() => api.patch("/appraisals/inputs", { month: MONTH, rows: [{ userId: users.john._id, leaves: 2, lateMarks: 4 }] }, as("hr")));
    assert.equal(r.status, 200, r.data?.message);
    const a = await appraisalFor("john");
    assert.equal(a.hrInputs.leaves, 2);
    assert.equal(a.hrInputs.lateMarks, 4);
    const leaves = a.entries.find((e) => e.criterionKey === "leaves");
    const late = a.entries.find((e) => e.criterionKey === "late_marks");
    assert.equal(leaves.score, 4);
    assert.equal(late.score, 4);
    assert.ok(await AppraisalAuditLog.exists({ action: "leaves_entered", subject: users.john._id }));
  });

  test("follow-up auto-attendance does not change appraisal late marks", async () => {
    // John has 3 auto "late" attendance rows + 3 late follow-ups; HR said 4.
    const a = await appraisalFor("john");
    assert.equal(a.metricsSnapshot.hr.lateMarks, 4);
  });

  test("follow-up auto-attendance does not populate appraisal leaves", async () => {
    // Sara has 3 auto "absent" rows and no HR entry: leaves stay unentered.
    await call(() => api.get("/appraisals", { params: { month: MONTH }, ...as("hr") }));
    const a = await appraisalFor("sara");
    assert.equal(a.hrInputs.leaves, null);
    assert.equal(a.metricsSnapshot.hr.leaves, null);
    assert.ok(a.missingInputs.includes("Leaves"));
  });

  test("an employee cannot set their own leaves", async () => {
    const a = await appraisalFor("john");
    const r = await call(() => api.patch(`/appraisals/${a._id}/hr-inputs`, { leaves: 0 }, as("john")));
    assert.equal(r.status, 403);
  });
});

describe("task metrics", () => {
  test("uses existing task records: 1 of 2 completed on time, 1 overdue", async () => {
    const a = await appraisalFor("john");
    assert.equal(a.metricsSnapshot.tasks.total, 2);
    assert.equal(a.metricsSnapshot.tasks.completed, 1);
    assert.equal(a.metricsSnapshot.tasks.completedOnTime, 1);
    assert.equal(a.metricsSnapshot.tasks.overdue, 1);
    assert.equal(a.entries.find((e) => e.criterionKey === "task_completion").performancePct, 50);
  });
});

describe("bugs", () => {
  let bugId;
  test("a team lead can report a bug against their team member; it waits for HR review", async () => {
    const r = await call(() => api.post("/bugs", { employee: users.john._id, title: "Crash on save", severity: "major", date: `${MONTH}-12` }, as("lead")));
    assert.equal(r.status, 201, r.data?.message);
    assert.equal(r.data.data.bug.status, "reported");
    assert.equal(r.data.data.bug.reporterRole, "manager");
    bugId = r.data.data.bug._id;
  });
  test("a team lead cannot report against someone outside their team", async () => {
    const r = await call(() => api.post("/bugs", { employee: users.outsider._id, title: "x", severity: "minor", date: `${MONTH}-12` }, as("lead")));
    assert.equal(r.status, 403);
  });
  test("HR can report bugs directly (confirmed) and confirm lead reports", async () => {
    const r = await call(() => api.post("/bugs", { employee: users.john._id, title: "Data loss", severity: "critical", date: `${MONTH}-13` }, as("hr")));
    assert.equal(r.status, 201);
    assert.equal(r.data.data.bug.status, "confirmed");
    const c = await call(() => api.patch(`/bugs/${bugId}`, { status: "confirmed" }, as("hr")));
    assert.equal(c.status, 200);
    assert.ok(await AppraisalAuditLog.exists({ action: "bug_status_changed", entityId: bugId }));
  });
  test("confirmed bugs feed the penalty with configured severities (5 + 3)", async () => {
    const john = await appraisalFor("john");
    await call(() => api.post(`/appraisals/${john._id}/recalculate`, {}, as("hr")));
    const a = await appraisalFor("john");
    assert.equal(a.metricsSnapshot.bugs.penaltyPoints, 8);
    assert.equal(a.entries.find((e) => e.criterionKey === "bug_management").performancePct, 84);
  });
  test("members cannot use the bug API", async () => {
    const r = await call(() => api.get("/bugs", as("john")));
    assert.equal(r.status, 403);
  });
});

describe("access control", () => {
  test("employees cannot list appraisals, change config, or see drafts", async () => {
    assert.equal((await call(() => api.get("/appraisals", { params: { month: MONTH }, ...as("john") }))).status, 403);
    assert.equal((await call(() => api.patch("/appraisals/settings", { improvementRule: { thresholdPct: 1, maxItems: 1 } }, as("john")))).status, 403);
    const a = await appraisalFor("john");
    assert.equal((await call(() => api.get(`/appraisals/${a._id}`, as("john")))).status, 403, "draft hidden from employee");
    assert.equal((await call(() => api.get(`/appraisals/${a._id}`, as("sara")))).status, 403, "other employee");
  });
});

describe("finalization, locking and history", () => {
  let appraisalId;
  let finalizedScore;

  test("an incomplete appraisal cannot be finalized", async () => {
    const a = await appraisalFor("john");
    appraisalId = String(a._id);
    const r = await call(() => api.post(`/appraisals/${appraisalId}/finalize`, {}, as("hr")));
    assert.equal(r.status, 422);
    assert.match(r.data.message, /Missing inputs/);
  });

  test("HR evaluates and finalizes; the appraisal becomes a locked snapshot", async () => {
    await rateAll(appraisalId);
    const r = await call(() => api.post(`/appraisals/${appraisalId}/finalize`, {}, as("hr")));
    assert.equal(r.status, 200, r.data?.message);
    assert.equal(r.data.data.appraisal.status, "finalized");
    finalizedScore = r.data.data.appraisal.totalScore;
    const a = await appraisalFor("john");
    assert.equal(a.configSnapshot.bugSeverities.find((s) => s.key === "critical").penalty, 5);
    assert.equal(a.employeeSnapshot.departmentName, "Technology");
    assert.ok(await AppraisalCriterion.exists({ key: "discipline", usedInFinalized: true }));
  });

  test("finalized appraisals reject input changes", async () => {
    assert.equal((await call(() => api.patch(`/appraisals/${appraisalId}/hr-inputs`, { leaves: 0 }, as("hr")))).status, 409);
    assert.equal((await call(() => api.patch(`/appraisals/${appraisalId}/evaluations/discipline`, { ratingKey: "poor" }, as("hr")))).status, 409);
  });

  test("the employee can now see their own finalized appraisal, without HR's working notes", async () => {
    const r = await call(() => api.get(`/appraisals/${appraisalId}`, as("john")));
    assert.equal(r.status, 200);
    assert.equal(r.data.data.appraisal.evaluations, undefined);
    assert.equal(r.data.data.appraisal.entries[0].steps, undefined);
    const mine = await call(() => api.get("/appraisals/my", as("john")));
    assert.equal(mine.data.data.history.length, 1);
  });

  test("config changes (penalties, weightage) and new data never alter the finalized score", async () => {
    const cfg = (await api.get("/appraisals/config", as("hr"))).data.data;
    const severities = cfg.settings.bugSeverities.map((s) => ({ ...s, penalty: s.penalty * 2 }));
    assert.equal((await call(() => api.patch("/appraisals/settings", { bugSeverities: severities }, as("hr")))).status, 200);
    const items = cfg.criteria.map((c) => ({
      id: c._id,
      isActive: c.isActive,
      weightage: c.key === "task_completion" ? 25 : c.key === "task_timeliness" ? 10 : c.weightage,
    }));
    const alloc = await call(() => api.put("/appraisals/criteria/allocation", { items }, as("hr")));
    assert.equal(alloc.status, 200, alloc.data?.message);
    await call(() => api.post("/bugs", { employee: users.john._id, title: "Late bug", severity: "critical", date: `${MONTH}-20` }, as("hr")));
    await call(() => api.get("/appraisals", { params: { month: MONTH }, ...as("hr") }));

    const a = await appraisalFor("john");
    assert.equal(a.totalScore, finalizedScore);
    assert.equal(a.entries.find((e) => e.criterionKey === "task_completion").weightage, 20);
    assert.equal(a.configSnapshot.bugSeverities.find((s) => s.key === "critical").penalty, 5);
    assert.equal(a.hrInputs.leaves, 2);
  });

  test("weightage allocation that isn't exactly 100% is rejected", async () => {
    const cfg = (await api.get("/appraisals/config", as("hr"))).data.data;
    const items = cfg.criteria.map((c) => ({ id: c._id, isActive: c.isActive, weightage: c.key === "leaves" ? c.weightage + 1 : c.weightage }));
    const r = await call(() => api.put("/appraisals/criteria/allocation", { items }, as("hr")));
    assert.equal(r.status, 422);
  });

  test("reopen requires a reason, is audited, and re-finalizing records old vs new score", async () => {
    assert.equal((await call(() => api.post(`/appraisals/${appraisalId}/reopen`, { reason: "x" }, as("hr")))).status, 400);
    const r = await call(() => api.post(`/appraisals/${appraisalId}/reopen`, { reason: "Leaves were entered incorrectly" }, as("hr")));
    assert.equal(r.status, 200);
    assert.equal(r.data.data.appraisal.status, "reopened");
    assert.equal((await call(() => api.patch(`/appraisals/${appraisalId}/hr-inputs`, { leaves: 0 }, as("hr")))).status, 200);
    const f = await call(() => api.post(`/appraisals/${appraisalId}/finalize`, {}, as("hr")));
    assert.equal(f.status, 200, f.data?.message);

    const a = await appraisalFor("john");
    const last = a.reopenHistory.at(-1);
    assert.equal(last.oldScore, finalizedScore);
    assert.equal(last.newScore, a.totalScore);
    assert.ok(last.refinalizedAt);
    // Leaves 2 -> 0 (+1 point) and the critical bug HR added after the first
    // finalization (−1 point at the snapshot's penalty of 5) both show up.
    assert.ok(last.changes.criteriaChanged.includes("leaves"));
    assert.ok(last.changes.criteriaChanged.includes("bug_management"));
    assert.equal(a.entries.find((e) => e.criterionKey === "leaves").score, 5);
    // Reopened appraisals keep the config they were finalized under.
    assert.equal(a.configSnapshot.bugSeverities.find((s) => s.key === "critical").penalty, 5);
    for (const action of ["appraisal_reopened", "appraisal_modified_after_reopen", "leaves_changed"]) {
      assert.ok(await AppraisalAuditLog.exists({ action, subject: users.john._id }), action);
    }
  });
});

describe("duplicate prevention", () => {
  test("concurrent draft creation yields one appraisal per employee per month", async () => {
    await Promise.all([getOrCreateDraft(users.sara._id, MONTH), getOrCreateDraft(users.sara._id, MONTH), ensureDrafts([users.sara], MONTH)]);
    assert.equal(await EmployeeAppraisal.countDocuments({ user: users.sara._id, month: MONTH }), 1);
    await assert.rejects(
      EmployeeAppraisal.create({ user: users.sara._id, month: MONTH, periodStart: PERIOD.startAt, periodEnd: PERIOD.endAt }),
      (e) => e.code === 11000
    );
  });

  test("month close is claimed once even when triggered twice at once", async () => {
    const now = new Date(PERIOD.emailDueAt.getTime() + 1000);
    const [a, b] = await Promise.all([closeMonth(MONTH, { now }), closeMonth(MONTH, { now })]);
    assert.equal([a, b].filter((r) => r.skipped).length, 1);
  });
});

describe("dashboard, reports and team-lead access", () => {
  test("dashboard filters by department and reports stats", async () => {
    const dept = (await User.findById(users.john._id)).department;
    const r = await call(() => api.get("/appraisals", { params: { month: MONTH, department: String(dept), search: "john" }, ...as("hr") }));
    assert.equal(r.status, 200);
    assert.equal(r.data.data.rows.length, 1);
    assert.equal(r.data.data.stats.completed, 1);
    assert.equal(r.data.data.rows[0].department.name, "Technology");
  });

  test("department report has all five sections", async () => {
    const r = await call(() => api.get("/appraisals/reports", { params: { month: MONTH }, ...as("hr") }));
    assert.equal(r.status, 200);
    const d = r.data.data;
    const john = d.summary.find((s) => s.employee === "John");
    assert.ok(john && john.classification);
    assert.ok(d.criteria.filter((c) => c.employee === "John").length >= 12);
    assert.equal(d.automatic.find((a) => a.employee === "John").tasks, 2);
    assert.equal(d.hr.find((h) => h.employee === "John").leaves, 0); // corrected to 0 in the reopen test
    assert.ok(d.hr.find((h) => h.employee === "John").Discipline);
    assert.ok(d.departments.some((x) => x.department === "Technology" && x.employeeCount >= 1));
    const csv = await call(() => api.get("/appraisals/reports", { params: { month: MONTH, format: "csv" }, ...as("hr") }));
    assert.match(csv.data, /^Employee,Email,Department/);
  });

  test("director can read reports but not change anything", async () => {
    users.director = await User.create({ name: "Dir", email: "dir@test.local", password: "x", role: "director" });
    assert.equal((await call(() => api.get("/appraisals/reports", { params: { month: MONTH }, ...as("director") }))).status, 200);
    assert.equal((await call(() => api.patch("/appraisals/inputs", { month: MONTH, rows: [{ userId: users.john._id, leaves: 9 }] }, as("director")))).status, 403);
  });

  test("a team lead sees their member's finalized appraisal, not other teams'", async () => {
    const team = await call(() => api.get("/appraisals/team", { params: { month: MONTH }, ...as("lead") }));
    assert.equal(team.status, 200);
    assert.ok(team.data.data.appraisals.some((a) => String(a.user._id) === String(users.john._id)));
    const john = await appraisalFor("john");
    const view = await call(() => api.get(`/appraisals/${john._id}`, as("lead")));
    assert.equal(view.status, 200);
    assert.equal(view.data.data.appraisal.evaluations, undefined);
    const outsiderDraft = await getOrCreateDraft(users.outsider._id, MONTH);
    assert.equal((await call(() => api.get(`/appraisals/${outsiderDraft._id}`, as("lead")))).status, 403);
    assert.equal((await call(() => api.get("/appraisals/reports", { params: { month: MONTH }, ...as("lead") }))).status, 403);
  });
});

describe("monthly emails", () => {
  test("nothing is emailed before 00:01 IST on the 1st", async () => {
    const r = await queueDueEmails(new Date(PERIOD.emailDueAt.getTime() - 1000));
    assert.equal(r.queued, 0);
  });

  test("each finalized appraisal is emailed exactly once, even if the job runs twice", async () => {
    const sent = [];
    const sender = async (msg) => {
      sent.push(msg);
      return { id: `msg-${sent.length}` };
    };
    const now = new Date(Math.max(Date.now(), PERIOD.emailDueAt.getTime()));
    await Promise.all([queueDueEmails(now), queueDueEmails(now)]);
    await Promise.all([processEmailQueue(now, { sender }), processEmailQueue(now, { sender })]);
    await queueDueEmails(now);
    await processEmailQueue(now, { sender });

    const johnId = String(users.john._id);
    const logs = await AppraisalEmailLog.find({ user: johnId, month: MONTH });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "sent");
    assert.equal(sent.filter((m) => m.to === "john@test.local").length, 1);
    const mail = sent.find((m) => m.to === "john@test.local");
    assert.match(mail.subject, /^Monthly Performance Appraisal – /);
    assert.match(mail.html, /Overall Score:/);
  });

  test("failures are logged with bounded retries, then HR can retry", async () => {
    const sara = await appraisalFor("sara");
    await call(() => api.patch("/appraisals/inputs", { month: MONTH, rows: [{ userId: users.sara._id, leaves: 1, lateMarks: 0 }] }, as("hr")));
    await rateAll(sara._id, "poor");
    assert.equal((await call(() => api.post(`/appraisals/${sara._id}/finalize`, {}, as("hr")))).status, 200);

    let now = new Date(Math.max(Date.now(), PERIOD.emailDueAt.getTime()));
    const failing = async () => {
      throw new Error("provider down");
    };
    await queueDueEmails(now);
    for (let i = 0; i < 5; i += 1) {
      await processEmailQueue(now, { sender: failing, maxAttempts: 3 });
      now = new Date(now.getTime() + 3 * 60 * 60 * 1000); // past every backoff
    }
    let log = await AppraisalEmailLog.findOne({ appraisal: sara._id });
    assert.equal(log.status, "failed");
    assert.equal(log.attempts, 3);
    assert.match(log.lastError, /provider down/);
    assert.ok(await AppraisalAuditLog.exists({ action: "email_failed", entityId: log._id }));

    setEmailSender(async () => ({ id: "ok" }));
    try {
      const r = await call(() => api.post(`/appraisals/emails/${log._id}/retry`, {}, as("hr")));
      assert.equal(r.status, 200);
      // The endpoint processes the queue in the background — wait for it.
      for (let i = 0; i < 40; i += 1) {
        log = await AppraisalEmailLog.findOne({ appraisal: sara._id });
        if (log.status === "sent") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      setEmailSender(null);
    }
    assert.equal(log.status, "sent");
    assert.ok(await AppraisalAuditLog.exists({ action: "email_retried", entityId: log._id }));
  });

  test("low-score email lists improvement areas", async () => {
    const { buildAppraisalEmail } = await import("../../src/services/appraisal/appraisalEmails.js");
    const sara = (await appraisalFor("sara")).toObject();
    const { html } = buildAppraisalEmail(sara, "Sara");
    if (sara.classification.key !== "excellent") assert.match(html, /require improvement/);
  });
});
