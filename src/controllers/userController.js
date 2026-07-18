import bcrypt from "bcrypt";

import User from "../models/User.js";

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
    const { name, email, password, role, designation, department, team, reportingManager } =
      req.body;
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
      department: department || null,
      team: team || null,
      reportingManager: reportingManager || null,
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
    const users = await User.find().populate("department team reportingManager", "name email");
    return res.json({ success: true, message: "Users fetched", data: { users } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const listDirectory = async (req, res) => {
  try {
    const users = await User.find()
      .select("name role designation department team")
      .populate("department", "name")
      .populate("team", "name");
    return res.json({ success: true, message: "Directory fetched", data: { users } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateUser = async (req, res) => {
  try {
    const allowed = [
      "name",
      "designation",
      "role",
      "department",
      "team",
      "reportingManager",
      "isActive",
    ];
    const updates = {};
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    const target = await User.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
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
