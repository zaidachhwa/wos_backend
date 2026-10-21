import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import axios from "axios";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

// Director 20% + Special Bonus, anonymous feedback, bonus requests, team
// availability and "getting free" emails. Throwaway DB, dropped after.
const TEST_URI = process.env.TEST_MONGODB_URI_PEOPLE || "mongodb://127.0.0.1:27017/wos_people_features_test";
process.env.ACCESS_TOKEN_SECRET ||= "people-test-secret";
process.env.REFRESH_TOKEN_SECRET ||= "people-test-refresh";
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
const { default: AnonymousFeedback } = await import("../src/models/AnonymousFeedback.js");
const { composeFinalScore } = await import("../src/services/appraisal/appraisalEngine.js");
const { ensureAppraisalConfig } = await import("../src/services/appraisal/appraisalConfig.js");
const { getOrCreateDraft } = await import("../src/services/appraisal/appraisalService.js");
const { istMonthOf } = await import("../src/services/appraisal/appraisalPeriod.js");
const { bonusWindow } = await import("../src/controllers/feedbackController.js");
const { runAvailabilityAlerts } = await import("../src/services/availabilityAlerts.js");
const { istDayStr } = await import("../src/utils/istTime.js");

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
const MONTH = istMonthOf();
// A task deadline N IST days from today (stored as a UTC-midnight date, like the date picker).
const dueInDays = (n) => new Date(`${istDayStr(new Date(Date.now() + n * 24 * 3600 * 1000))}T00:00:00Z`);

before(async () => {
  await mongoose.connect(TEST_URI);
  assert.match(mongoose.connection.name, /test/);
  await mongoose.connection.dropDatabase();
  await ensureAppraisalConfig();
  const eng = await Department.create({ name: "Engineering" });
  const ops = await Department.create({ name: "Operations" });
  const team = await Team.create({ name: "Platform", department: eng._id });
  const mk = (name, role, extra = {}) => User.create({ name, email: `${name.toLowerCase()}@test.local`, password: "x", role, ...extra });
  u.admin = await mk("Admin", "admin");
  u.hr = await mk("Hr", "hr");
  u.director = await mk("Director", "director");
  u.lead = await mk("Lead", "manager", { department: eng._id, team: team._id, managedTeam: team._id });
  u.coord = await mk("Coord", "technical_coordinator", { department: eng._id });
  u.opsCoord = await mk("OpsCoord", "technical_coordinator", { department: ops._id });
  u.busy = await mk("Busy", "member", { department: eng._id, team: team._id });
  u.idle = await mk("Idle", "member", { department: eng._id, team: team._id });
  u.pm = await mk("Pm", "member", { department: ops._id });
  u.project = await Project.create({ name: "Navy", manager: u.pm._id, members: [u.busy._id] });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  api = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}/api` });
});

after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  if (mongoose.connection.name?.includes("test")) await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

describe("final score: (criteria + director 20) → 100, then + bonus", () => {
  test("98 + director 15 → 94.17; + 5% bonus → 99.17", () => {
    assert.equal(Number(composeFinalScore({ baseScore: 98, directorScore: 15, bonusPct: 0 }).totalScore.toFixed(2)), 94.17);
    const r = composeFinalScore({ baseScore: 98, directorScore: 15, bonusPct: 5 });
    assert.equal(Number(r.totalScore.toFixed(2)), 99.17);
  });
  test("bonus can take the total past 100; classification uses it capped at 100", () => {
    const r = composeFinalScore({ baseScore: 100, directorScore: 20, bonusPct: 10 });
    assert.equal(r.totalScore, 110);
    assert.equal(r.classificationScore, 100);
  });
});

describe("rating + increment on the appraisal", () => {
  test("a member gets the employee rate; a team lead and a project manager get the leader rate", async () => {
    const draft = async (who) => {
      const d = await getOrCreateDraft(u[who]._id, MONTH);
      return (await call(() => api.get(`/appraisals/${d._id}`, as("hr")))).data.data.appraisal;
    };
    for (const [who, group] of [["idle", "member"], ["lead", "leader"], ["pm", "leader"], ["coord", "leader"]]) {
      const a = await draft(who);
      assert.equal(a.increment.group, group, who);
      const expected = group === "leader" ? a.classification.leaderIncrementPct : a.classification.employeeIncrementPct;
      assert.equal(a.increment.pct, expected, who);
    }
  });

  test("an untouched old 3-band setup is upgraded once; a customised one is left alone", async () => {
    const { default: AppraisalSettings } = await import("../src/models/AppraisalSettings.js");
    const { upgradeLegacyClassifications } = await import("../src/services/appraisal/appraisalConfig.js");
    const legacy = [
      { key: "needs_improvement", label: "Needs Improvement", min: 0, max: 35 },
      { key: "consistent", label: "Consistent", min: 36, max: 75 },
      { key: "excellent", label: "Excellent Performance", min: 76, max: 100 },
    ];
    await AppraisalSettings.updateOne({}, { $set: { classifications: legacy } });
    assert.equal(await upgradeLegacyClassifications(), true);
    assert.equal((await AppraisalSettings.findOne().lean()).classifications.length, 8);
    assert.equal(await upgradeLegacyClassifications(), false, "second run is a no-op");

    await AppraisalSettings.updateOne({}, { $set: { classifications: [{ ...legacy[0], max: 40 }, { ...legacy[1], min: 41 }, legacy[2]] } });
    assert.equal(await upgradeLegacyClassifications(), false, "customised bands are not overwritten");
  });
});

describe("Director's assessment and Special Bonus", () => {
  let appraisal;
  test("only the Director (or admin) can give the 0–20 assessment", async () => {
    appraisal = await getOrCreateDraft(u.busy._id, MONTH);
    assert.equal((await call(() => api.patch(`/appraisals/${appraisal._id}/director-assessment`, { score: 15 }, as("hr")))).status, 403);
    assert.equal((await call(() => api.patch(`/appraisals/${appraisal._id}/director-assessment`, { score: 25 }, as("director")))).status, 400);
    const r = await call(() => api.patch(`/appraisals/${appraisal._id}/director-assessment`, { score: 15, comment: "Solid" }, as("director")));
    assert.equal(r.status, 200, r.data?.message);
    const a = r.data.data.appraisal;
    assert.equal(a.directorAssessment.score, 15);
    assert.equal(Number(a.convertedScore.toFixed(4)), Number((((a.baseScore + 15) / 120) * 100).toFixed(4)));
    assert.ok(!a.missingInputs.includes("Director's assessment (out of 20)"));
  });

  test("HR, Director and Admin can add a Special Bonus %; it is added after conversion", async () => {
    assert.equal((await call(() => api.patch(`/appraisals/${appraisal._id}/special-bonus`, { pct: 5 }, as("hr")))).status, 400, "reason required");
    const r = await call(() => api.patch(`/appraisals/${appraisal._id}/special-bonus`, { pct: 5, reason: "Shipped Navy early" }, as("hr")));
    assert.equal(r.status, 200, r.data?.message);
    const a = r.data.data.appraisal;
    assert.equal(Number(a.totalScore.toFixed(4)), Number((a.convertedScore + 5).toFixed(4)));
    assert.equal((await call(() => api.patch(`/appraisals/${appraisal._id}/special-bonus`, { pct: 1, reason: "x x x" }, as("busy")))).status, 403);
  });

  test("bulk grid applies role rules per field", async () => {
    const r = await call(() =>
      api.patch("/appraisals/director-inputs", { month: MONTH, rows: [{ userId: u.idle._id, directorScore: 10, bonusPct: 2, bonusReason: "Great" }] }, as("hr"))
    );
    assert.equal(r.status, 200);
    assert.equal(r.data.data.results[0].ok, false, "HR can't set the director score");
    const ok = await call(() => api.patch("/appraisals/director-inputs", { month: MONTH, rows: [{ userId: u.idle._id, directorScore: 10 }] }, as("director")));
    assert.equal(ok.data.data.results[0].ok, true);
    const list = await api.get("/appraisals", { params: { month: MONTH }, ...as("director") });
    assert.equal(list.data.data.rows.find((row) => String(row.user._id) === String(u.idle._id)).directorScore, 10);
  });
});

describe("anonymous feedback", () => {
  test("stored with no trace of the sender, readable only by HR/admin", async () => {
    const r = await call(() => api.post("/feedback", { message: "The release process is too stressful.", category: "process" }, as("busy")));
    assert.equal(r.status, 201);
    assert.equal(r.data.data, undefined, "nothing about the record is returned");

    const raw = await AnonymousFeedback.collection.findOne({});
    assert.deepEqual(Object.keys(raw).sort(), ["_id", "category", "day", "message", "status"]);
    assert.equal(typeof raw._id, "string", "random UUID, not a time-stamped ObjectId");
    assert.ok(!JSON.stringify(raw).includes(String(u.busy._id)));

    assert.equal((await call(() => api.get("/feedback", as("busy")))).status, 403);
    assert.equal((await call(() => api.get("/feedback", as("director")))).status, 403);
    const list = await api.get("/feedback", as("hr"));
    assert.equal(list.data.data.feedback.length, 1);
    assert.equal(list.data.data.feedback[0].message, "The release process is too stressful.");
  });
});

describe("special bonus requests", () => {
  test("window is the 25th to the last day of the month (IST)", () => {
    assert.equal(bonusWindow(new Date("2026-10-24T18:29:00Z")).open, false); // 24 Oct 23:59 IST
    assert.equal(bonusWindow(new Date("2026-10-24T18:30:00Z")).open, true); // 25 Oct 00:00 IST
    const oct31 = bonusWindow(new Date("2026-10-31T12:00:00Z"));
    assert.equal(oct31.open, true);
    assert.equal(oct31.closesOn, "2026-10-31");
    assert.equal(bonusWindow(new Date("2026-10-31T18:30:00Z")).open, false); // 1 Nov IST
  });

  test("once per month inside the window; visible to HR/Admin/Director", async () => {
    const reason = "I led the Navy release and covered two on-call weeks.";
    const first = await call(() => api.post("/bonus-requests", { reason }, as("busy")));
    if (!bonusWindow().open) {
      assert.equal(first.status, 409, "closed outside 25th–month end");
      return;
    }
    assert.equal(first.status, 201);
    assert.equal((await call(() => api.post("/bonus-requests", { reason }, as("busy")))).status, 409, "only once");
    assert.equal((await call(() => api.get("/bonus-requests", as("busy")))).status, 403);
    assert.equal((await api.get("/bonus-requests", as("director"))).data.data.requests.length, 1);
  });
});

describe("team availability", () => {
  before(async () => {
    await Task.create({ project: u.project._id, title: "Navy API", assignees: [u.busy._id], deadline: dueInDays(3), status: "in_progress", priority: "high" });
  });

  test("team lead, project manager and coordinator each see their own people", async () => {
    const lead = (await api.get("/availability", as("lead"))).data.data;
    const leadPeople = lead.groups.flatMap((g) => g.people.map((p) => p.user.name));
    assert.ok(leadPeople.includes("Busy") && leadPeople.includes("Idle"));
    const busy = lead.groups[0].people.find((p) => p.user.name === "Busy");
    assert.equal(busy.status, "engaged");
    assert.equal(busy.daysUntilFree, 3);
    assert.equal(busy.tasks[0].priority, "high");
    assert.ok(busy.tasks[0].projectPriority);
    assert.ok(busy.projects[0].priority);
    assert.equal(busy.highestTaskPriority, "high");
    assert.equal(lead.groups[0].people.find((p) => p.user.name === "Idle").status, "free");

    const pm = (await api.get("/availability", as("pm"))).data.data;
    assert.deepEqual(pm.groups.map((g) => g.label), ["My projects"]);
    assert.deepEqual(pm.groups[0].people.map((p) => p.user.name), ["Busy"]);

    const coord = (await api.get("/availability", as("coord"))).data.data;
    assert.ok(coord.groups[0].people.some((p) => p.user.name === "Busy"));
    assert.ok(!coord.groups[0].people.some((p) => p.user.name === "Pm"), "other departments hidden");

    assert.equal((await api.get("/availability", as("idle"))).data.data.hasAccess, false);
  });

  test("coordinator emails: countdown once, no go-live spam, then 'now free'", async () => {
    const mails = [];
    const sender = async (m) => {
      mails.push(m);
      return { id: "x" };
    };
    await runAvailabilityAlerts(new Date(), { sender, ignoreHour: true });
    await runAvailabilityAlerts(new Date(), { sender, ignoreHour: true }); // re-run: no duplicates
    assert.deepEqual(
      mails.map((m) => [m.to, m.subject.split(" (")[0]]),
      [["coord@test.local", "Busy will be free in 3 days"]],
      "only the Engineering coordinator, once; already-free Idle is baselined, not emailed"
    );

    await Task.updateMany({ assignees: u.busy._id }, { $set: { status: "completed" } });
    await runAvailabilityAlerts(new Date(), { sender, ignoreHour: true });
    await runAvailabilityAlerts(new Date(), { sender, ignoreHour: true });
    assert.equal(mails.length, 2);
    assert.equal(mails[1].subject, "Busy is now free");
  });
});
