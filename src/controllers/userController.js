import bcrypt from "bcrypt";

import User from "../models/User.js";
import { paginationParams, paginationMeta } from "../utils/pagination.js";
import { getManagedTeamIds, getManagedUserIds, resolveDepartmentScope } from "../utils/departmentScope.js";

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
    const { name, email, password, role, designation, department, team, reportingManager, managedDepartment } =
      req.body;

    if (req.user.role === "subadmin") {
      if (["admin", "manager", "subadmin"].includes(role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      const managedTeamIds = (await getManagedTeamIds(req.user.managedDepartment)).map(String);
      if (!team || !managedTeamIds.includes(String(team))) {
        return res
          .status(403)
          .json({ success: false, message: "team must be one of your managed teams" });
      }
      if (reportingManager) {
        const managedUserIds = (await getManagedUserIds(req.user)).map(String);
        if (!managedUserIds.includes(String(reportingManager))) {
          return res
            .status(403)
            .json({ success: false, message: "reportingManager must be one of your managed users" });
        }
      }
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
      department: req.user.role === "subadmin" ? req.user.managedDepartment : department || null,
      team: team || null,
      reportingManager: reportingManager || null,
      managedDepartment: ["manager", "subadmin"].includes(role) ? managedDepartment : null,
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
    const baseFilter =
      req.user.role === "subadmin"
        ? { _id: { $in: await getManagedUserIds(req.user) } }
        : {};
    const total = await User.countDocuments(baseFilter);
    let query = User.find(baseFilter).populate(
      "department team reportingManager managedDepartment",
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
      .select("name email role designation department team managedDepartment reportingManager isActive createdAt")
      .populate("department", "name")
      .populate("team", "name")
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

export const updateUser = async (req, res) => {
  try {
    const allowed =
      req.user.role === "subadmin"
        ? ["name", "designation", "role", "team", "isActive"]
        : [
            "name",
            "designation",
            "role",
            "department",
            "team",
            "reportingManager",
            "isActive",
            "managedDepartment",
          ];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (req.user.role === "subadmin") {
      if (["admin", "manager", "subadmin"].includes(target.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      if (updates.role && ["admin", "manager", "subadmin"].includes(updates.role)) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
      const managedUserIds = (await getManagedUserIds(req.user)).map(String);
      if (!managedUserIds.includes(String(target._id))) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      if ("team" in updates) {
        const managedTeamIds = (await getManagedTeamIds(req.user.managedDepartment)).map(String);
        if (!updates.team || !managedTeamIds.includes(String(updates.team))) {
          return res
            .status(403)
            .json({ success: false, message: "team must be one of your managed teams" });
        }
      }
    } else {
      const resultingRole = "role" in updates ? updates.role : target.role;
      if (["manager", "subadmin"].includes(resultingRole)) {
        const resultingManagedDepartment =
          "managedDepartment" in updates ? updates.managedDepartment : target.managedDepartment;
        if (!resultingManagedDepartment) {
          return res.status(400).json({
            success: false,
            message: "managedDepartment is required for the manager/subadmin roles",
          });
        }
      } else {
        // Role isn't (staying) manager/subadmin — clear any stale managedDepartment
        // so a later re-promotion can't silently inherit a previous department.
        updates.managedDepartment = null;
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

    if (req.user.role === "subadmin") {
      if (["admin", "manager", "subadmin"].includes(target.role)) {
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
