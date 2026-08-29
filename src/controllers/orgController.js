import Department from "../models/Department.js";
import Team from "../models/Team.js";
import { resolveDepartmentScope, getManagedTeamIdsForActor } from "../utils/departmentScope.js";

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
    const scope = await resolveDepartmentScope(req.user);
    const filter = scope ? { _id: scope.departmentId } : {};
    const departments = await Department.find(filter).sort("name");
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
    if (req.user.role === "subadmin" && String(department) !== String(req.user.managedDepartment)) {
      return res
        .status(403)
        .json({ success: false, message: "You may only create teams in your managed department" });
    }
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
    const scope = await resolveDepartmentScope(req.user);
    const filter = scope ? { _id: { $in: scope.teamIds } } : {};
    const teams = await Team.find(filter).populate("department", "name").sort("name");
    return res.json({ success: true, message: "Teams fetched", data: { teams } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const updateTeam = async (req, res) => {
  try {
    const existing = await Team.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }
    if (req.user.role === "subadmin") {
      if (String(existing.department) !== String(req.user.managedDepartment)) {
        return res.status(404).json({ success: false, message: "Team not found" });
      }
      if (
        "department" in req.body &&
        (!req.body.department || String(req.body.department) !== String(req.user.managedDepartment))
      ) {
        return res
          .status(403)
          .json({ success: false, message: "You may only manage teams in your managed department" });
      }
    }

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
    return res.json({ success: true, message: "Team updated", data: { team } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

// Deliberately separate from updateTeam (admin/subadmin, renames/moves a
// team) — a manager gets exactly this one field for exactly their own team,
// not general team editing.
export const updateTeamThresholds = async (req, res) => {
  try {
    const { red, yellow } = req.body;
    if (typeof red !== "number" || typeof yellow !== "number" || !Number.isFinite(red) || !Number.isFinite(yellow)) {
      return res.status(400).json({ success: false, message: "red and yellow must be numbers" });
    }
    if (red >= yellow) {
      return res.status(400).json({ success: false, message: "red must be less than yellow" });
    }

    const team = await Team.findById(req.params.id);
    if (!team) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }
    if (req.user.role === "manager") {
      const managedTeamIds = (await getManagedTeamIdsForActor(req.user)).map(String);
      if (!managedTeamIds.includes(String(team._id))) {
        return res.status(404).json({ success: false, message: "Team not found" });
      }
    }

    team.performanceThresholds = { red, yellow };
    await team.save();
    return res.json({ success: true, message: "Thresholds updated", data: { team } });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

export const deleteTeam = async (req, res) => {
  try {
    const existing = await Team.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }
    if (
      req.user.role === "subadmin" &&
      String(existing.department) !== String(req.user.managedDepartment)
    ) {
      return res.status(404).json({ success: false, message: "Team not found" });
    }
    const team = await Team.findByIdAndDelete(req.params.id);
    return res.json({ success: true, message: "Team deleted", data: null });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
