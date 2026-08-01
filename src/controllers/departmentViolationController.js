import DepartmentViolation from "../models/DepartmentViolation.js";

export const listDepartmentViolations = async (req, res) => {
  try {
    const violations = await DepartmentViolation.find()
      .populate("project", "name")
      .populate("departments", "name")
      .sort("-flaggedAt");
    return res.json({ success: true, message: "Department violations fetched", data: { violations } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
