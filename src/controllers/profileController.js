import crypto from "node:crypto";
import bcrypt from "bcrypt";

import User from "../models/User.js";
import { isValidShiftTime } from "../utils/shiftTime.js";

export const updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if ("name" in req.body) user.name = req.body.name;
    if ("designation" in req.body) user.designation = req.body.designation;
    for (const field of ["shiftStart", "shiftEnd"]) {
      if (!(field in req.body)) continue;
      const value = req.body[field];
      if (!isValidShiftTime(value)) {
        return res.status(400).json({ success: false, message: `${field} must be in HH:MM format` });
      }
      user[field] = value;
    }
    await user.save();
    const safeUser = await User.findById(user._id).populate("department team managedDepartment managedTeam managedTeams");
    return res.json({ success: true, message: "Profile updated", data: { user: safeUser } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select("+password");
    if (!(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(401).json({ success: false, message: "Current password is incorrect" });
    }
    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();
    return res.json({ success: true, message: "Password updated", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const getIcsToken = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select("+icsToken");
    return res.json({ success: true, message: "ICS token fetched", data: { icsToken: user.icsToken } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const regenerateIcsToken = async (req, res) => {
  try {
    const icsToken = crypto.randomBytes(24).toString("hex");
    await User.findByIdAndUpdate(req.user._id, { icsToken });
    return res.json({ success: true, message: "ICS token generated", data: { icsToken } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
