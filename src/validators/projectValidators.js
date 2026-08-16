export const validateProjectCreate = (req, res, next) => {
  const { name, manager, members, weightage } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: "name is required" });
  }
  if (!manager) {
    return res.status(400).json({ success: false, message: "manager is required" });
  }
  if (members !== undefined && !Array.isArray(members)) {
    return res.status(400).json({ success: false, message: "members must be an array" });
  }
  if (weightage !== undefined && (typeof weightage !== "number" || !Number.isFinite(weightage) || weightage < 0)) {
    return res.status(400).json({ success: false, message: "weightage must be a non-negative number" });
  }
  next();
};

export const validateModuleCreate = (req, res, next) => {
  if (!req.body.name || !String(req.body.name).trim()) {
    return res.status(400).json({ success: false, message: "name is required" });
  }
  next();
};
