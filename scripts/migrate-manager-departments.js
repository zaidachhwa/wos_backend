import mongoose from "mongoose";

import User from "../src/models/User.js";
import Project from "../src/models/Project.js";
import Team from "../src/models/Team.js";
import DepartmentViolation from "../src/models/DepartmentViolation.js";

const departmentOf = async (userId, teamCache) => {
  const user = await User.findById(userId, "team");
  if (!user?.team) return null;
  const key = String(user.team);
  if (!teamCache.has(key)) {
    const team = await Team.findById(user.team, "department");
    teamCache.set(key, team ? String(team.department) : null);
  }
  return teamCache.get(key);
};

const run = async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const teamCache = new Map();

  const managers = await User.find({ role: "manager", managedDepartment: null });
  let assigned = 0;
  let unresolved = 0;

  for (const manager of managers) {
    const managedProjects = await Project.find({ manager: manager._id }, "members");
    const departmentCounts = new Map();

    for (const project of managedProjects) {
      for (const memberId of project.members) {
        const dept = await departmentOf(memberId, teamCache);
        if (dept) departmentCounts.set(dept, (departmentCounts.get(dept) || 0) + 1);
      }
    }

    let inferred = null;
    if (departmentCounts.size > 0) {
      inferred = [...departmentCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    } else {
      inferred = await departmentOf(manager._id, teamCache);
    }

    if (inferred) {
      manager.managedDepartment = inferred;
      await manager.save();
      assigned += 1;
    } else {
      unresolved += 1;
    }
  }

  const allProjects = await Project.find({}, "manager members");
  let flagged = 0;
  for (const project of allProjects) {
    const departments = new Set();
    const managerDept = await departmentOf(project.manager, teamCache);
    if (managerDept) departments.add(managerDept);
    for (const memberId of project.members) {
      const dept = await departmentOf(memberId, teamCache);
      if (dept) departments.add(dept);
    }
    if (departments.size > 1) {
      await DepartmentViolation.create({ project: project._id, departments: [...departments] });
      flagged += 1;
    }
  }

  console.log(`Managers auto-assigned: ${assigned}`);
  console.log(`Managers left unresolved (no signal): ${unresolved}`);
  console.log(`Projects flagged as cross-department: ${flagged}`);
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error("migrate-manager-departments failed:", error.message);
  process.exit(1);
});
