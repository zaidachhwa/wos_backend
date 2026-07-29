import ProjectModule from "../models/ProjectModule.js";
import Task from "../models/Task.js";

const moduleProgress = (tasks) =>
  tasks.length ? tasks.filter((t) => t.status === "completed").length / tasks.length : 0;

// Progress is computed, never persisted (spec: "Deliberate simplifications").
// project progress = mean of (each module's completed/total, each unmoduled
// task counting directly as 1 or 0). ponytail: recomputed on every read —
// fine at MVP scale, revisit with a cached/denormalized field if project
// sizes make this expensive.
export const computeProjectProgress = async (projectId) => {
  const [modules, tasks] = await Promise.all([
    ProjectModule.find({ project: projectId }).select("_id").lean(),
    Task.find({ project: projectId }).select("modules status").lean(),
  ]);
  const units = modules.map((m) =>
    moduleProgress(tasks.filter((t) => (t.modules || []).some((tm) => String(tm) === String(m._id))))
  );
  for (const t of tasks) {
    if (!t.modules || !t.modules.length) units.push(t.status === "completed" ? 1 : 0);
  }
  return units.length ? units.reduce((a, b) => a + b, 0) / units.length : 0;
};

// Modules for a project, each annotated with its task count and progress.
export const modulesWithProgress = async (projectId) => {
  const [modules, tasks] = await Promise.all([
    ProjectModule.find({ project: projectId })
      .populate("assignees", "name role designation")
      .sort("name")
      .lean(),
    Task.find({ project: projectId }).select("modules status").lean(),
  ]);
  return modules.map((m) => {
    const moduleTasks = tasks.filter((t) => (t.modules || []).some((tm) => String(tm) === String(m._id)));
    return {
      ...m,
      taskCount: moduleTasks.length,
      completedCount: moduleTasks.filter((t) => t.status === "completed").length,
      progress: moduleProgress(moduleTasks),
    };
  });
};
