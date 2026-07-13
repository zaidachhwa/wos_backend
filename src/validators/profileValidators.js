export const validateProfileUpdate = (req, res, next) => {
  if ("name" in req.body && !String(req.body.name).trim()) {
    return res.status(400).json({ success: false, message: "name cannot be empty" });
  }
  next();
};

export const validateChangePassword = (req, res, next) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword) {
    return res.status(400).json({ success: false, message: "currentPassword is required" });
  }
  if (!newPassword || String(newPassword).length < 8) {
    return res.status(400).json({ success: false, message: "newPassword must be at least 8 characters" });
  }
  next();
};
