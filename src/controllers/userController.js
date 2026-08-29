import bcrypt from "bcrypt";

import User from "../models/User.js";
import Team from "../models/Team.js";
import Memo from "../models/Memo.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";
import { getManagedTeamIdsForActor, getManagedUserIds, resolveDepartmentScope } from "../utils/departmentScope.js";
import { isValidShiftTime } from "../utils/shiftTime.js";

// Which target roles each scoped (non-admin) actor may create/edit/deactivate.
// Sub-admin manages its whole department, including the managers who run
// each team within it (their own managedTeam is scope-checked separately
// below — a sub-admin can't hand a manager a team outside their department).
// Manager and sub-lead manage their team's *members* only — not other
// managers/sub-leads/sub-admins who happen to share the team.
const MANAGEABLE_ROLES = {
  subadmin: ["manager", "sublead", "member"],
  manager: ["member"],
  sublead: ["member"],
};

// Would this update deactivate or demote the last remaining active admin,
// locking everyone out of admin-only actions? Checked before isActive:false
// or role changes take effect.
const wouldRemoveLastAdmin = async (target, updates) => {
  if (target.role !== "admin" || !target.isActive) return false;
  const losingAdmin = updates.isActive === false || (updates.role && updates.role !== "admin");
  if (!losingAdmin) return false;
  const otherActiveAdmins = await User.countDocuments({
    _id: { $ne: target._id },
    role: "admin",
    isActive: true,
  });
  return otherActiveAdmins === 0;
};

export const createUser = async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      role,
      designation,
      department,
      team,
      reportingManager,
      managedDepartment,
      managedTeam,
      managedTeams,
      shiftStart,
      shiftEnd,
      joinedAt,
    } = req.body;

    if (!isValidShiftTime(shiftStart ?? null) || !isValidShiftTime(shiftEnd ?? null)) {
      return res.status(400).json({ success: false, message: "shiftStart/shiftEnd must be in HH:MM format" });
    }

    const allowedRoles = MANAGEABLE_ROLES[req.user.role];
    let resolvedDepartment = department || null;

    if (allowedRoles) {
      if (!allowedRoles.includes(role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      const managedTeamIds = (await getManagedTeamIdsForActor(req.user)).map(String);
      if (!team || !managedTeamIds.includes(String(team))) {
        return res
          .status(403)
          .json({ success: false, message: "team must be one of your managed teams" });
      }
      if (role === "manager" && !managedTeamIds.includes(String(managedTeam))) {
        return res
          .status(403)
          .json({ success: false, message: "managedTeam must be one of your managed teams" });
      }
      if (reportingManager) {
        const managedUserIds = (await getManagedUserIds(req.user)).map(String);
        if (!managedUserIds.includes(String(reportingManager))) {
          return res
            .status(403)
            .json({ success: false, message: "reportingManager must be one of your managed users" });
        }
      }
      // Department is derived from the assigned team, not chosen directly —
      // works for subadmin (whole department), manager (one team), and
      // sublead (whose managed teams could in principle sit in different
      // departments) alike.
      const teamDoc = await Team.findById(team, "department");
      resolvedDepartment = teamDoc?.department || null;
    }

    const existing = await User.findOne({ email: String(email).toLowerCase() });
    if (existing) {
      return res.status(409).json({ success: false, message: "Email already in use" });
    }
    const user = await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 10),
      role,
      designation,
      department: resolvedDepartment,
      team: team || null,
      reportingManager: reportingManager || null,
      managedDepartment: role === "subadmin" ? managedDepartment : null,
      managedTeam: role === "manager" ? managedTeam : null,
      managedTeams: role === "sublead" ? managedTeams || [] : [],
      shiftStart: shiftStart || null,
      shiftEnd: shiftEnd || null,
      joinedAt: joinedAt || null,
    });
    const safeUser = await User.findById(user._id);
    return res.status(201).json({ success: true, message: "User created", data: { user: safeUser } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "Email already in use" });
    }
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listUsers = async (req, res) => {
  try {
    const pageParams = paginationParams(req.query);
    const baseFilter = MANAGEABLE_ROLES[req.user.role]
      ? { _id: { $in: await getManagedUserIds(req.user) } }
      : {};
    const total = await User.countDocuments(baseFilter);
    let query = User.find(baseFilter).populate(
      "department team reportingManager managedDepartment managedTeam managedTeams",
      "name email"
    );
    if (pageParams) query = query.skip(pageParams.skip).limit(pageParams.limit);
    const users = await query;
    return res.json({
      success: true,
      message: "Users fetched",
      data: { users, pagination: paginationMeta(total, pageParams) },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const listDirectory = async (req, res) => {
  try {
    const scope = await resolveDepartmentScope(req.user);
    const filter = scope ? { $or: [{ team: { $in: scope.teamIds } }, { _id: req.user._id }] } : {};
    const users = await User.find(filter)
      .select("name role designation department team")
      .populate("department", "name")
      .populate("team", "name");
    return res.json({ success: true, message: "Directory fetched", data: { users } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Single-user profile fetch, open to any authenticated role — visibility is
// the same department scope listDirectory already enforces, so a user can
// open a profile only for someone they could already see in the team list.
export const getUserById = async (req, res) => {
  try {
    const scope = await resolveDepartmentScope(req.user);
    const filter = scope
      ? { _id: req.params.id, $or: [{ team: { $in: scope.teamIds } }, { _id: req.user._id }] }
      : { _id: req.params.id };
    const user = await User.findOne(filter)
      .select(
        "name email role designation department team managedDepartment managedTeam managedTeams reportingManager isActive createdAt shiftStart shiftEnd nextReviewDate terminationPending"
      )
      .populate("department", "name")
      .populate("team", "name")
      .populate("managedTeam", "name")
      .populate("managedTeams", "name")
      .populate("reportingManager", "name role");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, message: "User fetched", data: { user } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

const ALLOWED_UPDATE_FIELDS = {
  admin: [
    "name",
    "designation",
    "role",
    "department",
    "team",
    "reportingManager",
    "isActive",
    "managedDepartment",
    "managedTeam",
    "managedTeams",
    "shiftStart",
    "shiftEnd",
    "joinedAt",
  ],
  subadmin: ["name", "designation", "role", "team", "isActive", "managedTeam", "shiftStart", "shiftEnd"],
  manager: ["name", "designation", "role", "team", "isActive", "shiftStart", "shiftEnd"],
  sublead: ["name", "designation", "role", "team", "isActive", "shiftStart", "shiftEnd"],
};

export const updateUser = async (req, res) => {
  try {
    const allowed = ALLOWED_UPDATE_FIELDS[req.user.role] || [];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    for (const field of ["shiftStart", "shiftEnd"]) {
      if (field in updates && !isValidShiftTime(updates[field] ?? null)) {
        return res.status(400).json({ success: false, message: `${field} must be in HH:MM format` });
      }
    }
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const allowedRoles = MANAGEABLE_ROLES[req.user.role];
    if (allowedRoles) {
      if (!allowedRoles.includes(target.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      if (updates.role && !allowedRoles.includes(updates.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      const managedUserIds = (await getManagedUserIds(req.user)).map(String);
      if (!managedUserIds.includes(String(target._id))) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      if ("team" in updates) {
        const managedTeamIds = (await getManagedTeamIdsForActor(req.user)).map(String);
        if (!updates.team || !managedTeamIds.includes(String(updates.team))) {
          return res
            .status(403)
            .json({ success: false, message: "team must be one of your managed teams" });
        }
      }
      // Only validate scope when managedTeam is actually being set to a team —
      // the frontend always sends this key (null for non-manager roles) to
      // clear it, which the resultingRole branch below already handles.
      if (updates.managedTeam) {
        const managedTeamIds = (await getManagedTeamIdsForActor(req.user)).map(String);
        if (!managedTeamIds.includes(String(updates.managedTeam))) {
          return res
            .status(403)
            .json({ success: false, message: "managedTeam must be one of your managed teams" });
        }
      }
      const resultingRole = "role" in updates ? updates.role : target.role;
      if (resultingRole === "manager") {
        const resultingManagedTeam = "managedTeam" in updates ? updates.managedTeam : target.managedTeam;
        if (!resultingManagedTeam) {
          return res.status(400).json({
            success: false,
            message: "managedTeam is required for the manager role",
          });
        }
      } else {
        updates.managedTeam = null;
      }
    } else {
      // admin — no scope restriction, but must keep managedDepartment/
      // managedTeam/managedTeams consistent with whatever role results.
      const resultingRole = "role" in updates ? updates.role : target.role;

      if (resultingRole === "subadmin") {
        const resultingManagedDepartment =
          "managedDepartment" in updates ? updates.managedDepartment : target.managedDepartment;
        if (!resultingManagedDepartment) {
          return res.status(400).json({
            success: false,
            message: "managedDepartment is required for the subadmin role",
          });
        }
      } else {
        updates.managedDepartment = null;
      }

      if (resultingRole === "manager") {
        const resultingManagedTeam = "managedTeam" in updates ? updates.managedTeam : target.managedTeam;
        if (!resultingManagedTeam) {
          return res.status(400).json({
            success: false,
            message: "managedTeam is required for the manager role",
          });
        }
      } else {
        updates.managedTeam = null;
      }

      if (resultingRole !== "sublead") {
        updates.managedTeams = [];
      }
    }

    if (await wouldRemoveLastAdmin(target, updates)) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot remove the last active admin" });
    }
    const user = await User.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    return res.json({ success: true, message: "User updated", data: { user } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteUser = async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const allowedRoles = MANAGEABLE_ROLES[req.user.role];
    if (allowedRoles) {
      if (!allowedRoles.includes(target.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      const managedUserIds = (await getManagedUserIds(req.user)).map(String);
      if (!managedUserIds.includes(String(target._id))) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
    }

    if (await wouldRemoveLastAdmin(target, { isActive: false })) {
      return res
        .status(400)
        .json({ success: false, message: "Cannot remove the last active admin" });
    }
    target.isActive = false;
    await target.save();
    return res.json({ success: true, message: "User deleted", data: { user: target } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

const canManageTarget = async (actor, targetId) => {
  if (actor.role === "admin") return true;
  const allowedRoles = MANAGEABLE_ROLES[actor.role];
  if (!allowedRoles) return false;
  const managedUserIds = (await getManagedUserIds(actor)).map(String);
  return managedUserIds.includes(String(targetId));
};

export const listUserMemos = async (req, res) => {
  try {
    if (!(await canManageTarget(req.user, req.params.id))) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const memos = await Memo.find({ user: req.params.id }).sort("-createdAt");
    return res.json({ success: true, message: "Memos fetched", data: { memos } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Admin-only (route-gated): voids every existing memo and clears the
// termination flag — a clean strike-count reset. nextReviewDate is left
// as-is; a reset undoes the count and the flag, not a delay that already
// took effect.
export const resetUserMemos = async (req, res) => {
  try {
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    await Memo.updateMany({ user: target._id, voided: false }, { $set: { voided: true } });
    target.terminationPending = false;
    await target.save();
    return res.json({ success: true, message: "Memos reset", data: { user: target } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};
