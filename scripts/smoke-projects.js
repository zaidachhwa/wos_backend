import assert from "node:assert";
import axios from "axios";

// B3: projects + modules. B4 extends this file with task flows (assign,
// kanban transitions, comments) — keep new assertions appended below in
// their own labeled sections rather than a new file.

const BASE = process.env.API_URL || "http://localhost:5000/api";
const EMAIL = process.env.SEED_ADMIN_EMAIL;
const PASSWORD = process.env.SEED_ADMIN_PASSWORD;

const authFor = async (email, password) => {
  const login = await axios.post(`${BASE}/auth/login`, { email, password });
  return { headers: { Authorization: `Bearer ${login.data.data.accessToken}` } };
};

const createUser = async (adminAuth, role) => {
  const email = `${role}+${Date.now()}+${Math.random().toString(36).slice(2)}@wos.local`;
  const password = "smokepass123";
  await axios.post(`${BASE}/users`, { name: `Smoke ${role}`, email, password, role }, adminAuth);
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

  // Setup: a manager, a project member, and an unrelated outsider member.
  const manager = await createUser(adminAuth, "manager");
  const member = await createUser(adminAuth, "member");
  const outsider = await createUser(adminAuth, "member");
  const outsiderSublead = await createUser(adminAuth, "sublead");

  // --- Project create + visibility ---------------------------------------

  const created = await axios.post(
    `${BASE}/projects`,
    { name: `Smoke Project ${Date.now()}`, manager: manager.userId, members: [member.userId] },
    manager.auth
  );
  assert.equal(created.status, 201, "manager creates a project with a member");
  const projectId = created.data.data.project._id;

  const memberForbiddenCreate = await axios.post(
    `${BASE}/projects`,
    { name: "Should fail", manager: manager.userId },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberForbiddenCreate.status, 403, "plain member cannot create a project");

  const missingName = await axios.post(
    `${BASE}/projects`,
    { manager: manager.userId },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(missingName.status, 400, "project create requires name");

  const memberList = await axios.get(`${BASE}/projects`, member.auth);
  assert.ok(
    memberList.data.data.projects.some((p) => p._id === projectId),
    "member sees a project they're on in the list"
  );

  const outsiderList = await axios.get(`${BASE}/projects`, outsider.auth);
  assert.ok(
    !outsiderList.data.data.projects.some((p) => p._id === projectId),
    "unrelated member does not see the project in the list"
  );

  const outsiderGet = await axios.get(`${BASE}/projects/${projectId}`, {
    ...outsider.auth,
    validateStatus: () => true,
  });
  assert.equal(outsiderGet.status, 403, "unrelated member cannot fetch the project directly");

  const memberGet = await axios.get(`${BASE}/projects/${projectId}`, member.auth);
  assert.equal(memberGet.status, 200, "member on the project can fetch it");
  assert.equal(memberGet.data.data.project.progress, 0, "0 tasks -> progress 0");
  assert.deepEqual(memberGet.data.data.project.modules, [], "no modules yet");

  const missingProjectGet = await axios.get(`${BASE}/projects/000000000000000000000000`, {
    ...manager.auth,
    validateStatus: () => true,
  });
  assert.equal(missingProjectGet.status, 404, "missing project 404s");

  // --- Modules -------------------------------------------------------------

  const moduleCreated = await axios.post(
    `${BASE}/projects/${projectId}/modules`,
    { name: "Backend module" },
    manager.auth
  );
  assert.equal(moduleCreated.status, 201, "manager creates a module");
  const moduleId = moduleCreated.data.data.module._id;

  const moduleForbidden = await axios.post(
    `${BASE}/projects/${projectId}/modules`,
    { name: "Should fail" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(moduleForbidden.status, 403, "plain member cannot create a module");

  const moduleList = await axios.get(`${BASE}/projects/${projectId}/modules`, member.auth);
  assert.equal(moduleList.status, 200, "project member can list modules");
  assert.equal(moduleList.data.data.modules[0].taskCount, 0, "fresh module has 0 tasks");
  assert.equal(moduleList.data.data.modules[0].progress, 0, "fresh module progress is 0");

  const moduleListForbidden = await axios.get(`${BASE}/projects/${projectId}/modules`, {
    ...outsider.auth,
    validateStatus: () => true,
  });
  assert.equal(moduleListForbidden.status, 403, "non-viewer cannot list modules");

  // --- PATCH role rules ------------------------------------------------------

  const projectPatchForbidden = await axios.patch(
    `${BASE}/projects/${projectId}`,
    { name: "Hacked" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(projectPatchForbidden.status, 403, "plain member cannot patch the project");

  const projectPatchByManager = await axios.patch(
    `${BASE}/projects/${projectId}`,
    { status: "active" },
    manager.auth
  );
  assert.equal(projectPatchByManager.status, 200, "project manager can patch their project");
  assert.equal(projectPatchByManager.data.data.project.status, "active");

  const modulePatchForbidden = await axios.patch(
    `${BASE}/projects/${projectId}/modules/${moduleId}`,
    { name: "Hacked" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(modulePatchForbidden.status, 403, "plain member cannot patch a module");

  const modulePatchByManager = await axios.patch(
    `${BASE}/projects/${projectId}/modules/${moduleId}`,
    { status: "active" },
    manager.auth
  );
  assert.equal(modulePatchByManager.status, 200, "manager can patch a module");

  // --- Sublead outsider (project-viewer fold-in fix) ----------------------

  const subleadOutsiderModuleCreate = await axios.post(
    `${BASE}/projects/${projectId}/modules`,
    { name: "Should fail" },
    { ...outsiderSublead.auth, validateStatus: () => true }
  );
  assert.equal(
    subleadOutsiderModuleCreate.status,
    403,
    "sublead who can't view the project can't create a module on it"
  );

  const subleadOutsiderModulePatch = await axios.patch(
    `${BASE}/projects/${projectId}/modules/${moduleId}`,
    { name: "Hacked" },
    { ...outsiderSublead.auth, validateStatus: () => true }
  );
  assert.equal(
    subleadOutsiderModulePatch.status,
    403,
    "sublead who can't view the project can't patch a module on it"
  );

  const subleadOutsiderTaskCreate = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Should fail" },
    { ...outsiderSublead.auth, validateStatus: () => true }
  );
  assert.equal(
    subleadOutsiderTaskCreate.status,
    403,
    "sublead who can't view the project can't create a task on it"
  );

  // --- Tasks: create, assign, kanban transitions, comments ----------------

  const taskMissingTitle = await axios.post(
    `${BASE}/tasks`,
    { project: projectId },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(taskMissingTitle.status, 400, "task create requires title");

  const taskWrongModule = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, module: "000000000000000000000000", title: "Bad module" },
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(taskWrongModule.status, 400, "task module must belong to the project");

  const taskCreated = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, module: moduleId, title: "Build API", assignee: member.userId },
    manager.auth
  );
  assert.equal(taskCreated.status, 201, "manager creates a task assigned to member");
  assert.equal(taskCreated.data.data.task.status, "backlog", "new task starts in backlog");
  const taskId = taskCreated.data.data.task._id;

  const outsiderTaskGet = await axios.get(`${BASE}/tasks/${taskId}`, {
    ...outsider.auth,
    validateStatus: () => true,
  });
  assert.equal(outsiderTaskGet.status, 403, "non-viewer cannot fetch the task");

  const memberTaskList = await axios.get(`${BASE}/tasks?assignee=me`, member.auth);
  assert.ok(
    memberTaskList.data.data.tasks.some((t) => t._id === taskId),
    "assignee=me lists the member's task"
  );

  const outsiderTaskList = await axios.get(`${BASE}/tasks`, outsider.auth);
  assert.ok(
    !outsiderTaskList.data.data.tasks.some((t) => t._id === taskId),
    "outsider does not see the foreign task in their list"
  );

  const toInProgress = await axios.patch(`${BASE}/tasks/${taskId}`, { status: "in_progress" }, member.auth);
  assert.equal(toInProgress.status, 200, "assignee moves task backlog -> in_progress");
  assert.equal(toInProgress.data.data.task.status, "in_progress");

  const memberReassignForbidden = await axios.patch(
    `${BASE}/tasks/${taskId}`,
    { assignee: outsider.userId },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberReassignForbidden.status, 403, "plain assignee cannot reassign the task");

  const memberTitleForbidden = await axios.patch(
    `${BASE}/tasks/${taskId}`,
    { title: "Hacked title" },
    { ...member.auth, validateStatus: () => true }
  );
  assert.equal(memberTitleForbidden.status, 403, "plain assignee cannot edit title");

  const toCompleted = await axios.patch(
    `${BASE}/tasks/${taskId}`,
    { status: "completed", actualHours: 4 },
    member.auth
  );
  assert.equal(toCompleted.status, 200, "assignee moves task in_progress -> completed");
  assert.equal(toCompleted.data.data.task.status, "completed");

  const commentMissingText = await axios.post(
    `${BASE}/tasks/${taskId}/comments`,
    {},
    { ...manager.auth, validateStatus: () => true }
  );
  assert.equal(commentMissingText.status, 400, "comment requires text");

  const commentByManager = await axios.post(`${BASE}/tasks/${taskId}/comments`, { text: "Nice work" }, manager.auth);
  assert.equal(commentByManager.status, 201, "manager (project viewer) comments on the task");

  const taskAfterComment = await axios.get(`${BASE}/tasks/${taskId}`, manager.auth);
  assert.ok(
    taskAfterComment.data.data.task.comments.some((c) => c.text === "Nice work"),
    "comment appears on the task"
  );
  // Notification-read assertions deferred to B7 (no /api/notifications yet);
  // the comment landing on the task is the observable proxy here.

  // --- Fractional project progress ----------------------------------------
  // module now has 1 completed (taskId) + 1 not-completed task -> 0.5,
  // plus one module-less completed task -> 1. Mean of the two units = 0.75.

  const secondModuleTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, module: moduleId, title: "Second module task" },
    manager.auth
  );
  assert.equal(secondModuleTask.status, 201, "creates a second (incomplete) task in the module");

  const noModuleTask = await axios.post(
    `${BASE}/tasks`,
    { project: projectId, title: "Standalone task" },
    manager.auth
  );
  assert.equal(noModuleTask.status, 201, "creates a module-less task");

  const completeNoModuleTask = await axios.patch(
    `${BASE}/tasks/${noModuleTask.data.data.task._id}`,
    { status: "completed" },
    manager.auth
  );
  assert.equal(completeNoModuleTask.status, 200, "completes the module-less task");

  const projectWithProgress = await axios.get(`${BASE}/projects/${projectId}`, manager.auth);
  assert.ok(
    Math.abs(projectWithProgress.data.data.project.progress - 0.75) < 0.001,
    `project progress should be ~0.75, got ${projectWithProgress.data.data.project.progress}`
  );

  // --- Delete ------------------------------------------------------------

  const deleteByManagerForbidden = await axios.delete(`${BASE}/projects/${projectId}`, {
    ...manager.auth,
    validateStatus: () => true,
  });
  assert.equal(deleteByManagerForbidden.status, 403, "project manager cannot delete (admin only)");

  const deleteByAdmin = await axios.delete(`${BASE}/projects/${projectId}`, adminAuth);
  assert.equal(deleteByAdmin.status, 200, "admin deletes the project");

  console.log("smoke-projects: all checks passed");
};

run().catch((error) => {
  console.error("smoke-projects failed:", error.response?.data?.message || error.message);
  process.exit(1);
});
