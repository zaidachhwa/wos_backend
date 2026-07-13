export const validateTaskCreate = (req, res, next) => {
  const { project, title } = req.body;
  if (!project) {
    return res.status(400).json({ success: false, message: "project is required" });
  }
  if (!title || !String(title).trim()) {
    return res.status(400).json({ success: false, message: "title is required" });
  }
  next();
};

export const validateComment = (req, res, next) => {
  if (!req.body.text || !String(req.body.text).trim()) {
    return res.status(400).json({ success: false, message: "text is required" });
  }
  next();
};
