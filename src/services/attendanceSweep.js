import User from "../models/User.js";
import FollowUp from "../models/FollowUp.js";
import Attendance from "../models/Attendance.js";
import { notify } from "../utils/record.js";
import { localDay } from "../controllers/notificationController.js";
import { getMorningDeadline } from "../utils/attendanceConfig.js";

// Roles that actually do task work — same set the HR portal's employee
// picker and appraisal roster exclusion use. Admin/hr/subadmin aren't
// tracked for attendance.
export const TRACKED_ROLES = ["manager", "sublead", "member", "qa"];

// The premise: the first thing anyone does on arriving is submit their
// morning follow-up, so its presence/timing IS the attendance record.
// Runs once a day, well after the deadline has passed (see server.js) —
// for every tracked-role user:
//   - no morning follow-up submitted at all today -> "leave" (shown to HR
//     as "Absent" via source: "auto")
//   - submitted, but after their deadline (their own User.morningDeadline
//     override if HR set one, else the org default) -> "late"
//   - submitted on time -> nothing recorded
// Never overwrites an entry that already exists for that user/date (HR's
// own manual marking, or a previous run of this same sweep, always wins),
// so a same-day rerun after a restart is a safe no-op.
export const runMorningAttendanceSweep = async (now = new Date()) => {
  const today = localDay(now);
  const orgDeadline = getMorningDeadline();

  const [users, followUps, existing] = await Promise.all([
    User.find({ isActive: true, role: { $in: TRACKED_ROLES } }).select("name morningDeadline"),
    FollowUp.find({ date: today, type: "morning" }).select("user status submittedAt"),
    Attendance.find({ date: today }).select("user type"),
  ]);

  const followUpByUser = new Map(followUps.map((f) => [String(f.user), f]));
  const alreadyMarkedUsers = new Set(existing.map((a) => String(a.user)));

  let absent = 0;
  let late = 0;
  for (const user of users) {
    const id = String(user._id);
    if (alreadyMarkedUsers.has(id)) continue; // manual entry or earlier sweep run already covers today

    const deadline = user.morningDeadline || orgDeadline;
    const deadlineAt = new Date(`${today}T${deadline}:00+05:30`);

    const f = followUpByUser.get(id);
    const submitted = f && f.status !== "draft" && f.submittedAt;

    let type = null;
    if (!submitted) {
      type = "leave";
    } else if (new Date(f.submittedAt) > deadlineAt) {
      type = "late";
    }
    if (!type) continue;

    await Attendance.create({
      user: user._id,
      date: today,
      type,
      note:
        type === "leave"
          ? "Absent — no morning follow-up submitted"
          : `Late — morning follow-up submitted after ${deadline}`,
      markedBy: null,
      source: "auto",
    });
    notify({
      user: user._id,
      type: `attendance_${type}`,
      title:
        type === "late"
          ? `You were marked late on ${today} — morning follow-up submitted after ${deadline}`
          : `You were marked absent on ${today} — no morning follow-up submitted`,
      link: "/appraisal",
    });
    if (type === "leave") absent += 1;
    else late += 1;
  }

  return { checked: users.length, absent, late };
};
