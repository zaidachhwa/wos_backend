export const validateProjectHealth = (req, res, next) => {
  if (!req.body.projectId) {
    return res.status(400).json({ success: false, message: "projectId is required" });
  }
  next();
};

export const validateChat = (req, res, next) => {
  if (!req.body.message || !String(req.body.message).trim()) {
    return res.status(400).json({ success: false, message: "message is required" });
  }
  next();
};
