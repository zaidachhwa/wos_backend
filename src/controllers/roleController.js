import mongoose from "mongoose";

import Role from "../models/Role.js";
import User from "../models/User.js";
import Department from "../models/Department.js";

const DEFAULT_ROLES = [
  { name: "Software Engineer", baseRole: "member", description: "Develops and maintains software applications." },
  { name: "Senior Software Engineer", baseRole: "member", description: "Leads technical design and architecture for complex features." },
  { name: "Tech Lead", baseRole: "sublead", description: "Guides team members and oversees engineering delivery." },
  { name: "Engineering Manager", baseRole: "manager", description: "Manages engineering teams, roadmaps, and personnel." },
  { name: "QA Engineer", baseRole: "qa", description: "Executes manual and automated quality assurance tests." },
  { name: "QA Lead", baseRole: "qa", description: "Coordinates testing strategies and QA processes." },
  { name: "UI/UX Designer", baseRole: "member", description: "Creates user interfaces, wireframes, and design systems." },
  { name: "Product Manager", baseRole: "manager", description: "Defines product requirements, scopes, and priorities." },
  { name: "HR Specialist", baseRole: "hr", description: "Handles recruitment, employee relations, and appraisals." },
  { name: "Operations Lead", baseRole: "subadmin", description: "Oversees department operations and resources." },
];

const seedDefaultRoles = async (userId) => {
  try {
    const count = await Role.countDocuments();
    if (count > 0) return;

    // Check if there are existing distinct designations in the database
    const existingDesignations = await User.find({ designation: { $nin: ["", null] } }).distinct("designation");
    const rolesToCreate = [...DEFAULT_ROLES];

    for (const d of existingDesignations) {
      const clean = String(d).trim();
      if (clean && !rolesToCreate.some((r) => r.name.toLowerCase() === clean.toLowerCase())) {
        rolesToCreate.push({
          name: clean,
          baseRole: "member",
          description: `Imported from existing employee designation.`,
        });
      }
    }

    const docs = rolesToCreate.map((r) => ({
      ...r,
      createdBy: userId || null,
      updatedBy: userId || null,
    }));

    await Role.insertMany(docs, { ordered: false });
  } catch (err) {
    // Ignore duplicate key errors if raced
    console.error("Default roles seeding notice:", err.message);
  }
};

export const listRoles = async (req, res) => {
  try {
    const { department, isActive, search } = req.query;

    // Auto-seed if needed
    const count = await Role.countDocuments();
    if (count === 0) {
      await seedDefaultRoles(req.user?._id);
    }

    const query = {};

    if (isActive !== undefined && isActive !== "") {
      query.isActive = isActive === "true";
    }

    if (department) {
      if (department === "none" || department === "null") {
        query.department = null;
      } else if (mongoose.isValidObjectId(department)) {
        query.$or = [{ department }, { department: null }];
      }
    }

    if (search && String(search).trim()) {
      const s = String(search).trim();
      query.$or = [
        { name: { $regex: s, $options: "i" } },
        { description: { $regex: s, $options: "i" } },
      ];
    }

    const roles = await Role.find(query)
      .populate("department", "name")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .sort({ name: 1 })
      .lean();

    // Calculate active user count per role
    // Match by designation (case-insensitive)
    const activeUsers = await User.find({ isActive: true, designation: { $nin: ["", null] } })
      .select("designation")
      .lean();

    const countMap = {};
    for (const u of activeUsers) {
      const key = (u.designation || "").trim().toLowerCase();
      if (key) {
        countMap[key] = (countMap[key] || 0) + 1;
      }
    }

    const enrichedRoles = roles.map((r) => ({
      ...r,
      userCount: countMap[r.name.trim().toLowerCase()] || 0,
    }));

    return res.json({
      success: true,
      message: "Roles fetched",
      data: { roles: enrichedRoles },
    });
  } catch (error) {
    console.error("Error in listRoles:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch roles" });
  }
};

export const getRoleById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid role ID" });
    }

    const role = await Role.findById(id)
      .populate("department", "name")
      .populate("createdBy", "name email")
      .populate("updatedBy", "name email")
      .lean();

    if (!role) {
      return res.status(404).json({ success: false, message: "Role not found" });
    }

    const userCount = await User.countDocuments({
      isActive: true,
      designation: { $regex: `^${role.name.trim()}$`, $options: "i" },
    });

    return res.json({
      success: true,
      data: { role: { ...role, userCount } },
    });
  } catch (error) {
    console.error("Error in getRoleById:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch role" });
  }
};

export const createRole = async (req, res) => {
  try {
    const { name, description, department, baseRole, isActive } = req.body;

    const trimmedName = String(name).trim();

    // Check for duplicate name
    const existing = await Role.findOne({
      name: { $regex: `^${trimmedName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`, $options: "i" },
    });

    if (existing) {
      return res.status(400).json({ success: false, message: `A role with the name "${trimmedName}" already exists` });
    }

    let deptId = null;
    if (department && mongoose.isValidObjectId(department)) {
      const dept = await Department.findById(department);
      if (dept) deptId = dept._id;
    }

    const role = new Role({
      name: trimmedName,
      description: description ? String(description).trim() : "",
      department: deptId,
      baseRole: baseRole || "member",
      isActive: isActive !== undefined ? Boolean(isActive) : true,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await role.save();
    await role.populate("department", "name");

    return res.status(201).json({
      success: true,
      message: "Role created successfully",
      data: { role: { ...role.toObject(), userCount: 0 } },
    });
  } catch (error) {
    console.error("Error in createRole:", error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Role name already exists" });
    }
    return res.status(500).json({ success: false, message: "Failed to create role" });
  }
};

export const updateRole = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid role ID" });
    }

    const role = await Role.findById(id);
    if (!role) {
      return res.status(404).json({ success: false, message: "Role not found" });
    }

    const { name, description, department, baseRole, isActive } = req.body;

    const oldName = role.name;

    if (name !== undefined) {
      const trimmedName = String(name).trim();
      if (!trimmedName) {
        return res.status(400).json({ success: false, message: "Role name cannot be empty" });
      }

      if (trimmedName.toLowerCase() !== oldName.toLowerCase()) {
        const existing = await Role.findOne({
          _id: { $ne: id },
          name: { $regex: `^${trimmedName.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}$`, $options: "i" },
        });

        if (existing) {
          return res.status(400).json({ success: false, message: `A role with the name "${trimmedName}" already exists` });
        }
      }

      role.name = trimmedName;
    }

    if (description !== undefined) {
      role.description = String(description).trim();
    }

    if (department !== undefined) {
      if (!department || department === "null" || department === "none") {
        role.department = null;
      } else if (mongoose.isValidObjectId(department)) {
        const dept = await Department.findById(department);
        role.department = dept ? dept._id : null;
      }
    }

    if (baseRole !== undefined) {
      role.baseRole = baseRole;
    }

    if (isActive !== undefined) {
      role.isActive = Boolean(isActive);
    }

    role.updatedBy = req.user._id;

    await role.save();
    await role.populate("department", "name");

    // If the name was renamed, optionally sync designations of users who were using the old name
    if (name && String(name).trim() !== oldName) {
      await User.updateMany(
        { designation: { $regex: `^${oldName.trim()}$`, $options: "i" } },
        { $set: { designation: role.name } }
      );
    }

    const userCount = await User.countDocuments({
      isActive: true,
      designation: { $regex: `^${role.name.trim()}$`, $options: "i" },
    });

    return res.json({
      success: true,
      message: "Role updated successfully",
      data: { role: { ...role.toObject(), userCount } },
    });
  } catch (error) {
    console.error("Error in updateRole:", error);
    if (error.code === 11000) {
      return res.status(400).json({ success: false, message: "Role name already exists" });
    }
    return res.status(500).json({ success: false, message: "Failed to update role" });
  }
};

export const deleteRole = async (req, res) => {
  try {
    const { id } = req.params;
    const { force } = req.query;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, message: "Invalid role ID" });
    }

    const role = await Role.findById(id);
    if (!role) {
      return res.status(404).json({ success: false, message: "Role not found" });
    }

    // Check if any active users have this designation
    const assignedUsersCount = await User.countDocuments({
      isActive: true,
      designation: { $regex: `^${role.name.trim()}$`, $options: "i" },
    });

    if (assignedUsersCount > 0 && force !== "true") {
      return res.status(409).json({
        success: false,
        message: `Cannot delete role "${role.name}" because it is currently assigned to ${assignedUsersCount} active user(s). Consider deactivating it instead, or delete with force=true.`,
        assignedUsersCount,
      });
    }

    await Role.findByIdAndDelete(id);

    return res.json({
      success: true,
      message: `Role "${role.name}" deleted successfully`,
    });
  } catch (error) {
    console.error("Error in deleteRole:", error);
    return res.status(500).json({ success: false, message: "Failed to delete role" });
  }
};
