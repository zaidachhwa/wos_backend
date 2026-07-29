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
    { project: projectId, modules: [moduleId], title: "Wire up SSO", assignees: [secondReport.userId] },
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

  // --- sublead team scope: team-membership match, not reportingManager ------

  const dept = await axios.post(`${BASE}/departments`, { name: `Followups Smoke Dept ${Date.now()}` }, adminAuth);
  const deptId = dept.data.data.department._id;
  const otherDept = await axios.post(
    `${BASE}/departments`,
    { name: `Followups Smoke Other Dept ${Date.now()}` },
    adminAuth
  );
  const otherDeptId = otherDept.data.data.department._id;

  const team = await axios.post(
    `${BASE}/teams`,
    { name: `Followups Smoke Team ${Date.now()}`, department: deptId },
    adminAuth
  );
  const teamId = team.data.data.team._id;
  const otherTeam = await axios.post(
    `${BASE}/teams`,
    { name: `Followups Smoke Other Team ${Date.now()}`, department: otherDeptId },
    adminAuth
  );
  const otherTeamId = otherTeam.data.data.team._id;

  const sublead = await createUser(adminAuth, "sublead", { team: teamId, department: deptId });
  // No reportingManager set on teammate/deptMember2 — proves the fix reads team
  // membership, not reportingManager.
  const teammate = await createUser(adminAuth, "member", { team: teamId, department: deptId });
  const deptMember2 = await createUser(adminAuth, "member", { team: teamId, department: deptId });
  const outsiderMember = await createUser(adminAuth, "member", { team: otherTeamId, department: otherDeptId });
  const subadmin = await createUser(adminAuth, "subadmin", { managedDepartment: deptId });

  const teammateFollowUp = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Sublead scope check" }, submit: true },
    teammate.auth
  );
  assert.equal(teammateFollowUp.status, 200, "teammate submits a morning follow-up");
  const teammateFollowUpId = teammateFollowUp.data.data.followUp._id;

  const deptMember2FollowUp = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Subadmin scope check" }, submit: true },
    deptMember2.auth
  );
  assert.equal(deptMember2FollowUp.status, 200, "second in-department member submits a morning follow-up");
  const deptMember2FollowUpId = deptMember2FollowUp.data.data.followUp._id;

  const outsiderFollowUp = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Outsider check" }, submit: true },
    outsiderMember.auth
  );
  assert.equal(outsiderFollowUp.status, 200, "outsider submits a morning follow-up");
  const outsiderFollowUpId = outsiderFollowUp.data.data.followUp._id;

  const subleadOwnFollowUp = await axios.post(
    `${BASE}/followups`,
    { date: today, type: "morning", data: { todayPlan: "Sublead's own plan" }, submit: true },
    sublead.auth
  );
  assert.equal(subleadOwnFollowUp.status, 200, "sublead submits their own morning follow-up");
  const subleadOwnFollowUpId = subleadOwnFollowUp.data.data.followUp._id;

  const subleadTeamList = await axios.get(
    `${BASE}/followups?date=${today}&type=morning&scope=team`,
    sublead.auth
  );
  assert.equal(subleadTeamList.status, 200, "sublead lists team scope");
  const subleadRows = subleadTeamList.data.data.followUps;
  const teammateRow = subleadRows.find((f) => f.user._id === teammate.userId);
  assert.ok(teammateRow, "sublead sees teammate's submission via team match, despite no reportingManager link");
  assert.equal(teammateRow.status, "submitted", "teammate row shows submitted");
  assert.ok(
    !subleadRows.some((f) => f.user._id === outsiderMember.userId),
    "sublead's team list excludes a member on a different team"
  );
  assert.ok(
    subleadRows.some((f) => f.user._id === sublead.userId),
    "sublead's own submission appears in their own team list (self-inclusive by design)"
  );

  const subleadNoTeam = await createUser(adminAuth, "sublead");
  const subleadNoTeamList = await axios.get(
    `${BASE}/followups?date=${today}&type=morning&scope=team`,
    subleadNoTeam.auth
  );
  assert.equal(subleadNoTeamList.status, 200, "sublead with no team assigned still gets 200, not an error");
  assert.deepEqual(
    subleadNoTeamList.data.data.followUps,
    [],
    "sublead with no team sees an empty list, not every teamless user"
  );

  // --- subadmin team scope: department-wide via getManagedUserIds -----------

  const subadminTeamList = await axios.get(
    `${BASE}/followups?date=${today}&type=morning&scope=team`,
    subadmin.auth
  );
  assert.equal(
    subadminTeamList.status,
    200,
    "subadmin can list team scope (previously 403, role wasn't gated in at all)"
  );
  const subadminRows = subadminTeamList.data.data.followUps;
  assert.ok(
    subadminRows.some((f) => f.user._id === deptMember2.userId),
    "subadmin sees a user in their managed department"
  );
  assert.ok(
    !subadminRows.some((f) => f.user._id === outsiderMember.userId),
    "subadmin's list excludes a user outside their managed department"
  );

  // --- review rights extended to match the new viewing scope -----------------

  const subleadReviews = await axios.patch(
    `${BASE}/followups/${teammateFollowUpId}/review`,
    { managerComment: "Sublead review" },
    sublead.auth
  );
  assert.equal(subleadReviews.status, 200, "sublead can review a teammate's submission via team match");
  assert.equal(subleadReviews.data.data.followUp.status, "reviewed", "status is reviewed");

  const subleadReviewsOutsiderForbidden = await axios.patch(
    `${BASE}/followups/${outsiderFollowUpId}/review`,
    { managerComment: "Not my team" },
    { ...sublead.auth, validateStatus: () => true }
  );
  assert.equal(subleadReviewsOutsiderForbidden.status, 403, "sublead cannot review a follow-up outside their team");

  const subleadReviewsOwnForbidden = await axios.patch(
    `${BASE}/followups/${subleadOwnFollowUpId}/review`,
    { managerComment: "Self review" },
    { ...sublead.auth, validateStatus: () => true }
  );
  assert.equal(
    subleadReviewsOwnForbidden.status,
    403,
    "sublead cannot review their own follow-up, even though it's self-inclusive in their team list"
  );

  const subadminReviews = await axios.patch(
    `${BASE}/followups/${deptMember2FollowUpId}/review`,
    { managerComment: "Subadmin review" },
    subadmin.auth
  );
  assert.equal(subadminReviews.status, 200, "subadmin can review a managed user's submission");
  assert.equal(subadminReviews.data.data.followUp.status, "reviewed", "status is reviewed");

  const subadminReviewsOutsiderForbidden = await axios.patch(
    `${BASE}/followups/${outsiderFollowUpId}/review`,
    { managerComment: "Not my department" },
    { ...subadmin.auth, validateStatus: () => true }
  );
  assert.equal(
    subadminReviewsOutsiderForbidden.status,
    403,
    "subadmin cannot review a follow-up outside their managed department"
  );

  console.log("smoke-followups: all checks passed");
};

run().catch((error) => {
  console.error("smoke-followups failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
