export const validateDepartmentName = (req, res, next) => {
  if (!req.body.name || !String(req.body.name).trim()) {
    return res.status(400).json({ success: false, message: "name is required" });
  }
  next();
};

export const validateTeamCreate = (req, res, next) => {
  const { name, department } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ success: false, message: "name is required" });
  }
  if (!department) {
    return res.status(400).json({ success: false, message: "department is required" });
  }
  next();
};
