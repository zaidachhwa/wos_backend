import Team from "../models/Team.js";
import User from "../models/User.js";

export const getManagedTeamIds = async (departmentId) => {
  const teams = await Team.find({ department: departmentId }, "_id");
  return teams.map((t) => t._id);
};

// Which teams this actor manages, purely from their own assignment field —
// no visibility computation, just "what's theirs". Hierarchy: sub-admin owns
// a whole department, manager owns one team in it, sub-lead owns an
// explicitly assigned set of teams (can span more than one).
export const getManagedTeamIdsForActor = async (user) => {
  if (user.role === "subadmin") return getManagedTeamIds(user.managedDepartment);
  if (user.role === "manager") return user.managedTeam ? [user.managedTeam] : [];
  if (user.role === "sublead") return user.managedTeams?.length ? [...user.managedTeams] : [];
  return [];
};

// Which individual accounts an actor may create/edit/deactivate — narrower
// than resolveDepartmentScope's userIds below: a manager or sub-lead manages
// their team's *members*, not other managers/sub-leads who happen to share
// the team. Sub-admin keeps its original reach (everyone but admin/subadmin
// in-department) so existing sub-admin behavior (e.g. picking an existing
// manager as a new member's reportingManager) is unaffected.
const MANAGEABLE_ROLE_FILTER = {
  subadmin: { $nin: ["admin", "subadmin"] },
  manager: { $in: ["member"] },
  sublead: { $in: ["member"] },
};

export const getManagedUserIds = async (user) => {
  const roleFilter = MANAGEABLE_ROLE_FILTER[user.role];
  if (!roleFilter) return [];
  const teamIds = await getManagedTeamIdsForActor(user);
  if (!teamIds.length) return [];
  const users = await User.find({ team: { $in: teamIds }, role: roleFilter }, "_id");
  return users.map((u) => u._id);
};

// Shared by reportController.teamReport, aiController's workload/chat context
// builders — all three had the identical admin/manager ternary before this
// helper existed; this is that ternary generalized with a third branch.
// Deliberately untouched by the manager/sub-lead team-scoping change below:
// a manager's reports here are still their direct reports (reportingManager),
// which can legitimately span multiple teams — see
// 2026-07-29-followup-team-scope-fix-design.md.
export const reportScopeFilter = async (user) => {
  if (user.role === "admin") {
    return { role: { $ne: "admin" }, isActive: true };
  }
  if (user.role === "subadmin") {
    return { _id: { $in: await getManagedUserIds(user) }, isActive: true };
  }
  return { reportingManager: user._id, isActive: true };
};

// Resolves ANY role's department/team-visibility scope — the single source
// of truth every controller below calls instead of branching on role itself.
// - admin: null (unrestricted)
// - subadmin: their managedDepartment (whole department)
// - manager: their managedTeam (exactly one team)
// - sublead with managedTeams assigned: exactly those teams (can be several)
// - sublead without an assignment yet, and member: their own team's whole
//   department (segregation's default boundary is department, per
//   2026-07-30-department-segregation-design.md) — unchanged fallback so an
//   unassigned sub-lead isn't suddenly scoped to nothing.
export const resolveDepartmentScope = async (user) => {
  if (user.role === "admin") return null;

  if (user.role === "subadmin") {
    const teamIds = await getManagedTeamIds(user.managedDepartment);
    const userIds = await getManagedUserIds(user);
    return { departmentId: user.managedDepartment, teamIds, userIds };
  }

  if (user.role === "manager") {
    if (!user.managedTeam) return { departmentId: null, teamIds: [], userIds: [] };
    const team = await Team.findById(user.managedTeam, "department");
    const teamIds = [user.managedTeam];
    const users = await User.find({ team: { $in: teamIds } }, "_id");
    return { departmentId: team?.department || null, teamIds, userIds: users.map((u) => u._id) };
  }

  if (user.role === "sublead" && user.managedTeams?.length) {
    const teamIds = [...user.managedTeams];
    const teams = await Team.find({ _id: { $in: teamIds } }, "department");
    const departmentIds = [...new Set(teams.map((t) => String(t.department)))];
    const users = await User.find({ team: { $in: teamIds } }, "_id");
    return {
      // null when the assigned teams span more than one department — callers
      // that need a single department (e.g. listDepartments) just see "all".
      departmentId: departmentIds.length === 1 ? departmentIds[0] : null,
      teamIds,
      userIds: users.map((u) => u._id),
    };
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
