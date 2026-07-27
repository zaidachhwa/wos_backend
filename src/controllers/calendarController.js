import TimeBlock from "../models/TimeBlock.js";
import Task from "../models/Task.js";
import Project from "../models/Project.js";
import FollowUp from "../models/FollowUp.js";
import User from "../models/User.js";
import { canActForUser } from "./timeblockController.js";

const collectItems = async (userId, fromDate, toDate) => {
  const range = { $gte: fromDate, $lte: toDate };

  const [blocks, tasks, projects, followUps] = await Promise.all([
    TimeBlock.find({ user: userId, start: range }),
    // Overlap query, not "deadline falls in range": a task created today with
    // a deadline weeks out must still show on *this* week's board even though
    // its deadline isn't in this week — the visible span is [createdAt, deadline].
    Task.find({
      assignees: userId,
      deadline: { $gte: fromDate },
      createdAt: { $lte: toDate },
    }).populate("project", "name"),
    Project.find({
      $or: [{ manager: userId }, { members: userId }],
      deadline: range,
    }),
    // ponytail: fetch all own submitted follow-ups and filter the computed
    // 09:00/18:00 timestamp in JS — per-user volume is small for an MVP.
    FollowUp.find({ user: userId, status: "submitted" }),
  ]);

  const items = [];

  for (const b of blocks) {
    items.push({
      id: String(b._id),
      type: "timeblock",
      title: b.title,
      start: b.start,
      end: b.end,
      color: b.color,
      category: b.category,
      link: "/calendar",
    });
  }

  for (const t of tasks) {
    items.push({
      id: String(t._id),
      type: "task_deadline",
      title: t.title,
      // Raw pieces, not a pre-combined instant — the server doesn't know the
      // viewer's timezone, so combining "HH:mm" with the deadline's date
      // happens client-side (see wos_frontend's calendar page), the same
      // way <input type="time"> values are always treated as local.
      start: t.deadline,
      startTime: t.startTime || null,
      endTime: t.endTime || null,
      // The frontend uses createdAt as the span's start day; a task shown
      // less than a day after creation renders as today's single-point event.
      spanStart: t.createdAt,
      label: t.labels?.[0] || null,
      projectName: t.project?.name || null,
      status: t.status,
      link: "/tasks",
    });
  }

  for (const p of projects) {
    items.push({
      id: String(p._id),
      type: "project_deadline",
      title: p.name,
      start: p.deadline,
      link: `/projects/${p._id}`,
    });
  }

  for (const f of followUps) {
    const hour = f.type === "morning" ? "09" : "18";
    const start = new Date(`${f.date}T${hour}:00:00`);
    if (start >= fromDate && start <= toDate) {
      items.push({
        id: String(f._id),
        type: "followup",
        title: `${f.type === "morning" ? "Morning" : "Evening"} follow-up`,
        start,
        link: "/follow-ups",
      });
    }
  }

  return items;
};

export const getCalendar = async (req, res) => {
  try {
    const { from, to, user } = req.query;
    if (!from || !to) {
      return res.status(400).json({ success: false, message: "from and to are required" });
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      return res.status(400).json({ success: false, message: "from and to must be valid dates" });
    }

    // Admins may view anyone's calendar; managers their reports'; else own only.
    const targetId = user || req.user._id;
    if (!(await canActForUser(req.user, targetId))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const items = await collectItems(targetId, fromDate, toDate);
    return res.json({ success: true, message: "Calendar fetched", data: { items } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

// Public ICS feed — the unguessable token IS the auth (standard "secret
// address" model, same as Google Calendar's own private ICS links).
const ICS_TITLE_PREFIX = {
  task_deadline: "Task due: ",
  project_deadline: "Project due: ",
};

const toICSDate = (d) => new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const escICS = (s) =>
  String(s)
    .replace(/\\/g, "\\\\")
    .replace(/[,;]/g, (m) => `\\${m}`)
    .replace(/\n/g, "\\n");

export const icsFeed = async (req, res) => {
  try {
    const user = await User.findOne({ icsToken: req.params.token });
    if (!user || !user.isActive) {
      return res.status(404).send("Not found");
    }
    const now = Date.now();
    const DAY = 24 * 3600 * 1000;
    const items = await collectItems(user._id, new Date(now - 30 * DAY), new Date(now + 90 * DAY));

    const events = items.map((i) =>
      [
        "BEGIN:VEVENT",
        `UID:${i.type}-${i.id}@workos`,
        `DTSTAMP:${toICSDate(new Date())}`,
        `DTSTART:${toICSDate(i.start)}`,
        `DTEND:${toICSDate(i.end || new Date(new Date(i.start).getTime() + 30 * 60000))}`,
        `SUMMARY:${escICS(`${ICS_TITLE_PREFIX[i.type] || ""}${i.title}`)}`,
        "END:VEVENT",
      ].join("\r\n")
    );

    const body = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//WorkOS//EN",
      `X-WR-CALNAME:WorkOS — ${escICS(user.name)}`,
      ...events,
      "END:VCALENDAR",
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    return res.send(body);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Something went wrong");
  }
};
