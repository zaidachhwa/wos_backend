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
