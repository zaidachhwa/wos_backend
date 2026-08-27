import Attendance from "../models/Attendance.js";
import User from "../models/User.js";
import { notify } from "../utils/record.js";
import { monthDayBounds } from "../utils/monthDayBounds.js";
import { getMorningDeadline, setMorningDeadline, getOfficeLocation, setOfficeLocation } from "../utils/attendanceConfig.js";
import { runMorningAttendanceSweep, TRACKED_ROLES } from "../services/attendanceSweep.js";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TYPES = ["late", "leave"];
const DEADLINE_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

// HR marks an employee late or on leave for a given day. Upserts on
// (user, date, type) so re-marking the same day just updates the note
// instead of erroring or duplicating — and flips source back to "manual",
// so correcting an auto-generated entry (see attendanceSweep.js) is just a
// normal re-mark, not a separate "override" action.
export const createAttendance = async (req, res) => {
  try {
    const { user, date, type, note = "" } = req.body;
    if (!user || !date || !type) {
      return res.status(400).json({ success: false, message: "user, date and type are required" });
    }
    if (!DATE_RE.test(date)) {
      return res.status(400).json({ success: false, message: "date must be YYYY-MM-DD" });
    }
    if (!TYPES.includes(type)) {
      return res.status(400).json({ success: false, message: "type must be late or leave" });
    }
    const target = await User.findById(user);
    if (!target) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const record = await Attendance.findOneAndUpdate(
      { user, date, type },
      { $set: { note, markedBy: req.user._id, source: "manual" } },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    notify({
      user,
      type: `attendance_${type}`,
      title: type === "late" ? `You were marked late on ${date}` : `You were marked on leave on ${date}`,
      body: note,
      link: "/appraisal",
    });

    return res.status(201).json({ success: true, message: "Attendance recorded", data: { record } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const listAttendance = async (req, res) => {
  try {
    const { month, user } = req.query;
    const { dayStart, dayEnd } = monthDayBounds(month);
    const filter = { date: { $gte: dayStart, $lte: dayEnd } };
    if (user) filter.user = user;

    const records = await Attendance.find(filter)
      .sort("-date")
      .populate("user", "name role designation team")
      .populate("markedBy", "name");

    return res.json({ success: true, message: "Attendance fetched", data: { records } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const deleteAttendance = async (req, res) => {
  try {
    const record = await Attendance.findByIdAndDelete(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, message: "Attendance record not found" });
    }
    return res.json({ success: true, message: "Attendance record deleted" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Monthly rollup: every tracked-role user, even ones with zero entries, so
// HR sees clean-record employees alongside flagged ones. ?format=csv mirrors
// reportController's team report export.
export const attendanceReport = async (req, res) => {
  try {
    const { month } = req.query;
    const { dayStart, dayEnd } = monthDayBounds(month);

    const [users, rows] = await Promise.all([
      User.find({ isActive: true, role: { $in: TRACKED_ROLES } })
        .select("name role designation team")
        .populate("team", "name"),
      Attendance.aggregate([
        { $match: { date: { $gte: dayStart, $lte: dayEnd } } },
        { $group: { _id: { user: "$user", type: "$type" }, count: { $sum: 1 } } },
      ]),
    ]);

    const countsByUser = new Map();
    for (const row of rows) {
      const id = String(row._id.user);
      const entry = countsByUser.get(id) || { lates: 0, leaves: 0 };
      if (row._id.type === "late") entry.lates = row.count;
      else if (row._id.type === "leave") entry.leaves = row.count;
      countsByUser.set(id, entry);
    }

    const report = users.map((u) => {
      const counts = countsByUser.get(String(u._id)) || { lates: 0, leaves: 0 };
      return {
        user: {
          _id: u._id,
          name: u.name,
          role: u.role,
          designation: u.designation,
          team: u.team ? { _id: u.team._id, name: u.team.name } : null,
        },
        lates: counts.lates,
        leaves: counts.leaves,
      };
    });
    report.sort((a, b) => b.lates + b.leaves - (a.lates + a.leaves));

    if (req.query.format === "csv") {
      const header = "Name,Role,Team,Late marks,Leaves";
      const csv = [
        header,
        ...report.map((r) =>
          [
            `"${r.user.name.replace(/"/g, '""')}"`,
            r.user.role,
            r.user.team?.name || "",
            r.lates,
            r.leaves,
          ].join(",")
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="attendance-report-${dayStart.slice(0, 7)}.csv"`);
      return res.send(csv);
    }

    return res.json({ success: true, message: "Attendance report fetched", data: { dayStart, dayEnd, report } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Readable by anyone authenticated (see routes) so employees know their own
// submit-by time and that a location lock is in effect; only hr/admin can
// change it. officeLat/officeLng are null until HR sets them up — the
// follow-up submit path skips the geofence entirely until then.
export const getAttendanceConfig = async (req, res) => {
  const office = getOfficeLocation();
  return res.json({
    success: true,
    message: "Attendance config fetched",
    data: {
      morningDeadline: getMorningDeadline(),
      officeLat: office?.lat ?? null,
      officeLng: office?.lng ?? null,
      officeRadiusMeters: office?.radiusMeters ?? 300,
    },
  });
};

// Every field is optional — HR can update just the deadline, just the
// office location, or both in one call.
export const updateAttendanceConfig = async (req, res) => {
  try {
    const { morningDeadline, officeLat, officeLng, officeRadiusMeters } = req.body;
    let updatedDeadline = getMorningDeadline();
    if (morningDeadline !== undefined) {
      if (!DEADLINE_RE.test(morningDeadline || "")) {
        return res.status(400).json({ success: false, message: "morningDeadline must be HH:mm" });
      }
      updatedDeadline = await setMorningDeadline(morningDeadline);
    }

    let updatedOffice = getOfficeLocation();
    if (officeLat !== undefined || officeLng !== undefined || officeRadiusMeters !== undefined) {
      const lat = officeLat !== undefined ? Number(officeLat) : updatedOffice?.lat;
      const lng = officeLng !== undefined ? Number(officeLng) : updatedOffice?.lng;
      const radiusMeters = officeRadiusMeters !== undefined ? Number(officeRadiusMeters) : updatedOffice?.radiusMeters;
      if (
        (officeLat !== undefined && (!Number.isFinite(lat) || lat < -90 || lat > 90)) ||
        (officeLng !== undefined && (!Number.isFinite(lng) || lng < -180 || lng > 180)) ||
        (officeRadiusMeters !== undefined && (!Number.isFinite(radiusMeters) || radiusMeters <= 0))
      ) {
        return res.status(400).json({ success: false, message: "Invalid office location or radius" });
      }
      updatedOffice = await setOfficeLocation({ lat, lng, radiusMeters });
    }

    return res.json({
      success: true,
      message: "Attendance config updated",
      data: {
        morningDeadline: updatedDeadline,
        officeLat: updatedOffice?.lat ?? null,
        officeLng: updatedOffice?.lng ?? null,
        officeRadiusMeters: updatedOffice?.radiusMeters ?? 300,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Every tracked employee with their effective morning-follow-up deadline —
// null means "using the org default" (see getAttendanceConfig). Backs the
// HR portal's per-employee deadline editor.
export const listUserDeadlines = async (req, res) => {
  try {
    const users = await User.find({ isActive: true, role: { $in: TRACKED_ROLES } })
      .select("name role designation team morningDeadline")
      .populate("team", "name")
      .sort("name");
    return res.json({ success: true, message: "Deadlines fetched", data: { users } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Sets (or, with morningDeadline: null, clears) one employee's individual
// deadline override — everyone has their own shift/start time, so this is
// what the attendance sweep checks per-person before falling back to the
// org default (see services/attendanceSweep.js).
export const setUserMorningDeadline = async (req, res) => {
  try {
    const { morningDeadline } = req.body;
    if (morningDeadline !== null && morningDeadline !== undefined && !DEADLINE_RE.test(morningDeadline)) {
      return res.status(400).json({ success: false, message: "morningDeadline must be HH:mm or null" });
    }
    const user = await User.findByIdAndUpdate(
      req.params.userId,
      { morningDeadline: morningDeadline || null },
      { new: true }
    )
      .select("name role designation team morningDeadline")
      .populate("team", "name");
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, message: "Deadline updated", data: { user } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Manual "run it right now" escape hatch around the same function
// server.js's daily interval calls — mirrors leaderboardController.runOverdueSweep.
export const runAttendanceSweepNow = async (req, res) => {
  try {
    const result = await runMorningAttendanceSweep();
    return res.json({ success: true, message: "Attendance sweep completed", data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
