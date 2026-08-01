import Team from "../models/Team.js";
import User from "../models/User.js";

export const getManagedTeamIds = async (departmentId) => {
  const teams = await Team.find({ department: departmentId }, "_id");
  return teams.map((t) => t._id);
};

// Every user currently on any team in a sub-admin's managed department.
// Admin/subadmin accounts are excluded even if their team happens to sit in
// that department — sub-admins never manage other elevated accounts.
export const getManagedUserIds = async (subadminUser) => {
  const teamIds = await getManagedTeamIds(subadminUser.managedDepartment);
  const users = await User.find(
    { team: { $in: teamIds }, role: { $nin: ["admin", "subadmin"] } },
    "_id"
  );
  return users.map((u) => u._id);
};

// Shared by reportController.teamReport, aiController's workload/chat context
// builders — all three had the identical admin/manager ternary before this
// helper existed; this is that ternary generalized with a third branch.
export const reportScopeFilter = async (user) => {
  if (user.role === "admin") {
    return { role: { $ne: "admin" }, isActive: true };
  }
  if (user.role === "subadmin") {
    return { _id: { $in: await getManagedUserIds(user) }, isActive: true };
  }
  return { reportingManager: user._id, isActive: true };
};

// Resolves ANY role's department-visibility scope — the single source of
// truth every controller below calls instead of branching on role itself.
// - admin: null (unrestricted)
// - manager, subadmin: their managedDepartment (one department each)
// - sublead, member: their own team's department (not just their own team —
//   segregation's boundary is department, per 2026-07-30-department-segregation-design.md)
// - no team and not manager/subadmin: sees only themselves (fail closed)
export const resolveDepartmentScope = async (user) => {
  if (user.role === "admin") return null;
  if (["manager", "subadmin"].includes(user.role)) {
    const teamIds = await getManagedTeamIds(user.managedDepartment);
    const userIds = await getManagedUserIds(user);
    return { departmentId: user.managedDepartment, teamIds, userIds };
  }
  if (!user.team) {
    return { departmentId: null, teamIds: [], userIds: [user._id] };
  }
  const team = await Team.findById(user.team, "department");
  if (!team) {
    return { departmentId: null, teamIds: [], userIds: [user._id] };
  }
  const teamIds = await getManagedTeamIds(team.department);
  const users = await User.find({ team: { $in: teamIds } }, "_id");
  return { departmentId: team.department, teamIds, userIds: users.map((u) => u._id) };
};
