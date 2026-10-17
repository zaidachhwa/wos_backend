import { ROLES } from "../constants/roles.constants.js";

export const validateRoleCreate = (req, res, next) => {
  const { name, baseRole } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: "Role name is required" });
  }

  if (baseRole && !ROLES.includes(baseRole)) {
    return res.status(400).json({
      success: false,
      message: `Invalid base role. Allowed roles: ${ROLES.join(", ")}`,
    });
  }

  next();
};

export const validateRoleUpdate = (req, res, next) => {
  const { name, baseRole } = req.body;
  if (name !== undefined && !String(name).trim()) {
    return res.status(400).json({ success: false, message: "Role name cannot be empty" });
  }

  if (baseRole && !ROLES.includes(baseRole)) {
    return res.status(400).json({
      success: false,
      message: `Invalid base role. Allowed roles: ${ROLES.join(", ")}`,
    });
  }

  next();
};
