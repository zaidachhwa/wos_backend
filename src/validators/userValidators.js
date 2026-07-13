import { ROLES } from "../constants/roles.constants.js";

export const validateCreateUser = (req, res, next) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role) {
    return res
      .status(400)
      .json({ success: false, message: "name, email, password and role are required" });
  }
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return res.status(400).json({ success: false, message: "Invalid email" });
  }
  if (String(password).length < 8) {
    return res
      .status(400)
      .json({ success: false, message: "Password must be at least 8 characters" });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ success: false, message: "Invalid role" });
  }
  next();
};
