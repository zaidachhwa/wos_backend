import assert from "node:assert";
import axios from "axios";

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role, extra = {}) => {
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  await axios.post(
    `${BASE}/users`,
    { name: `Smoke ${role}`, email, password, role, ...extra },
    adminAuth
  );
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return {
    email,
    password,
    userId: login.data.data.user._id,
    auth: { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } },
  };
};

const run = async () => {
  const adminAuth = await authFor(EMAIL, PASSWORD);

  const manager = await createUser(adminAuth, "manager");
  const member = await createUser(adminAuth, "member", { reportingManager: manager.userId });
  const secondReport = await createUser(adminAuth, "member", { reportingManager: manager.userId });

  const today = new Date().toISOString().slice(0, 10);

  // --- draft, then submit -- same doc, no duplicate -----------------------

  const draft = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Ship B5" }, submit: false },
    member.auth
  );
  assert.equal(draft.status, 200, "draft save succeeds");
  assert.equal(draft.data.data.followUp.status, "draft", "starts as draft");
  const followUpId = draft.data.data.followUp._id;

  const submitted = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Ship B5 final" }, submit: true },
    member.auth
  );
  assert.equal(submitted.status, 200, "submit succeeds");
  assert.equal(submitted.data.data.followUp.status, "submitted", "now submitted");
  assert.equal(submitted.data.data.followUp._id, followUpId, "same doc, no duplicate");

  // --- duplicate-submit same date+type upserts -----------------------------

  const resubmit = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Ship B5 final v2" }, submit: true },
    member.auth
  );
  assert.equal(resubmit.data.data.followUp._id, followUpId, "resubmit upserts the same doc");

  const memberList = await axios.get(`${BASE}/followups?date=${today}&type=morning`, member.auth);
  assert.equal(memberList.data.data.followUps.length, 1, "only one follow-up doc exists for the day/type");
  assert.equal(
    memberList.data.data.followUps[0].morning.todayPlan,
    "Ship B5 final v2",
    "latest data overwrote the subdoc"
  );

  // --- validation -----------------------------------------------------------

  const badDate = await axios.post(
    `${BASE}/followups`,
    { date: "07-10-2026", type: "morning", data: {}, submit: false },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(badDate.status, 400, "bad date format rejected");

  const badType = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "afternoon", data: {}, submit: false },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(badType.status, 400, "bad type rejected");

  // --- manager team scope: sees submission + a missing row -----------------

  const memberForbiddenTeam = await axios.get(
    `${BASE}/followups?date=${today}&type=morning&scope=team`,
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberForbiddenTeam.status, 403, "plain member cannot list team scope");

  const teamList = await axios.get(`${BASE}/followups?date=${today}&type=morning&scope=team`, manager.auth);
  assert.equal(teamList.status, 200, "manager lists team scope");
  const teamFollowUps = teamList.data.data.followUps;
  const memberRow = teamFollowUps.find((f) => f.user._id === member.userId);
  assert.ok(memberRow, "manager sees member's submission");
  assert.equal(memberRow.status, "submitted", "member row shows submitted");
  const missingRow = teamFollowUps.find((f) => f.user._id === secondReport.userId);
  assert.ok(missingRow, "manager sees a row for the report who hasn't submitted");
  assert.equal(missingRow.status, "missing", "second report shows as missing");

  // --- review ---------------------------------------------------------------

  const reviewMissing = await axios.patch(
    `${BASE}/followups/000000000000000000000000/review`,
    {},
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(reviewMissing.status, 404, "reviewing a missing follow-up 404s");

  const otherManager = await createUser(adminAuth, "manager");
  const reviewForbidden = await axios.patch(
    `${BASE}/followups/${followUpId}/review`,
    { managerComment: "Not my report" },
    { ...otherManager.auth, validateStatus: () => true }
  );
  assert.equal(reviewForbidden.status, 403, "unrelated manager cannot review another manager's report");

  const reviewed = await axios.patch(
    `${BASE}/followups/${followUpId}/review`,
    { managerComment: "Looks good" },
    manager.auth
  );
  assert.equal(reviewed.status, 200, "manager reviews the submission");
  assert.equal(reviewed.data.data.followUp.status, "reviewed", "status is reviewed");
  assert.equal(reviewed.data.data.followUp.managerComment, "Looks good", "comment saved");

  const memberSeesReview = await axios.get(`${BASE}/followups?date=${today}&type=morning`, member.auth);
  const reviewedDoc = memberSeesReview.data.data.followUps[0];
  assert.equal(reviewedDoc.status, "reviewed", "member sees reviewed status");
  assert.equal(reviewedDoc.managerComment, "Looks good", "member sees manager comment");

  // --- locked after review ---------------------------------------------------

  const postAfterReview = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "trying again" }, submit: false },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(postAfterReview.status, 409, "re-posting after review is locked");

  // --- only submitted follow-ups can be reviewed -----------------------------

  const eveningDraft = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "evening", data: { completedWork: "wip" }, submit: false },
    secondReport.auth
  );
  assert.equal(eveningDraft.status, 200, "second report saves an evening draft");

  const reviewDraftForbidden = await axios.patch(
    `${BASE}/followups/${eveningDraft.data.data.followUp._id}/review`,
    {},
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(reviewDraftForbidden.status, 409, "cannot review a draft follow-up");

  // --- EOD work log: gated on today's own evening submission, no names, tasks+modules, tomorrow-plan todo ---

  const gated = await axios.get(`${BASE}/followups/work-log`, { ...secondReport.auth, validateStatus: () => true });
  assert.equal(gated.status, 403, "work log is blocked before the evening follow-up is submitted");

  const project = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Followups ${Date.now()}`, manager: manager.userId, members: [secondReport.userId] },
    manager.auth
  );
  const projectId = project.data.data.project._id;

  const moduleRes = await axios.post(`${BASE}/projects/${projectId}/modules`, { name: "Onboarding" }, manager.auth);
  const moduleId = moduleRes.data.data.module._id;

  const task = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, module: moduleId, title: "Wire up SSO", assignees: [secondReport.userId] },
    manager.auth
  );
  await axios.patch(`${BASE}/tasks/${task.data.data.task._id}`, { status: "completed" }, secondReport.auth);

  const eveningSubmit = await axios.post(
    `${BASE}/followups`,
    {
      date: today,
      type: "evening",
      data: { completedWork: "wip", tomorrowPlan: "Finish onboarding flow\nReview PR #42" },
      submit: true,
    },
    secondReport.auth
  );
  assert.equal(eveningSubmit.status, 200, "second report submits their evening follow-up");

  const log = await axios.get(`${BASE}/followups/work-log`, secondReport.auth);
  assert.equal(log.status, 200, "work log unlocks right after the evening submission");
  const text = log.data.data.text;
  assert.match(text, /^Work log/, "starts with the Work log title");
  assert.match(text, /Team Leader : Smoke member/, "labeled with the submitter's name, not a task-by-task roster");
  assert.match(text, /Tasks :\n- Wire up SSO \(Onboarding\)/, "completed task is shown with its module, no assignee name");
  assert.match(text, /Todo :\n- Finish onboarding flow\n- Review PR #42/, "todo comes from tomorrow's plan, one bullet per line");
  assert.ok(!text.includes("Smoke member:"), "no more 'name: task' prefixing");

  console.log("smoke-followups: all checks passed");
};

run().catch((error) => {
  console.error("smoke-followups failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
