import Department from "../models/Department.js";
import Team from "../models/Team.js";

// Departments

export const createDepartment = async (req, res) => {
  try {
    const { name, description } = req.body;
    const department = await Department.create({ name, description });
    return res
      .status(201)
      .json({ success: true, message: "Department created", data: { department } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listDepartments = async (req, res) => {
  try {
    const departments = await Department.find().sort("name");
    return res.json({ success: true, message: "Departments fetched", data: { departments } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateDepartment = async (req, res) => {
  try {
    const updates = {};
    for (const key of ["name", "description"]) {
      if (key in req.body) updates[key] = req.body[key];
    }
    const department = await Department.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!department) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }
    return res.json({ success: true, message: "Department updated", data: { department } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteDepartment = async (req, res) => {
  try {
    const department = await Department.findByIdAndDelete(req.params.id);
    if (!department) {
      return res.status(404).json({ success: false, message: "Department not found" });
    }
    return res.json({ success: true, message: "Department deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Teams

export const createTeam = async (req, res) => {
  try {
    const { name, department } = req.body;
    const dept = await Department.findById(department);
    if (!dept) {
      return res
        .status(400)
        .json({ success: false, message: "department must reference an existing department" });
    }
    const team = await Team.create({ name, department });
    return res.status(201).json({ success: true, message: "Team created", data: { team } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const listTeams = async (req, res) => {
  try {
    const teams = await Team.find().populate("department", "name").sort("name");
    return res.json({ success: true, message: "Teams fetched", data: { teams } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateTeam = async (req, res) => {
  try {
    const updates = {};
    for (const key of ["name", "department"]) {
      if (key in req.body) updates[key] = req.body[key];
    }
    if (updates.department) {
      const dept = await Department.findById(updates.department);
      if (!dept) {
        return res
          .status(400)
          .json({ success: false, message: "department must reference an existing department" });
      }
    }
    const team = await Team.findByIdAndUpdate(req.params.id, updates, {
      new: true,
      runValidators: true,
    });
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }
    return res.json({ success: true, message: "Team updated", data: { team } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteTeam = async (req, res) => {
  try {
    const team = await Team.findByIdAndDelete(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }
    return res.json({ success: true, message: "Team deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
