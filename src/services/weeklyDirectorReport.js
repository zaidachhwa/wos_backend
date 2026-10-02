import Task from "../../models/Task.js";
import User from "../../models/User.js";
import BugReport from "../../models/BugReport.js";
import Project from "../../models/Project.js";
import Department from "../../models/Department.js";
import { emailConfigured, sendEmail } from "../resend.js";
import { istDayStr, istClock } from "../../utils/istTime.js";

// ────────────────────────────────────────────────────────────────
// Weekly Director Report — Tasks, Bugs & Projects per department.
// Runs every Monday morning (via server.js's setInterval scheduler).
// Each director only receives data for their own department(s).
// ────────────────────────────────────────────────────────────────

const DAY = 24 * 3600 * 1000;
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => {
  const dt = new Date(d);
  return `${dt.getDate()} ${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][dt.getMonth()]} ${dt.getFullYear()}`;
};

// Last 7 calendar days (Sun→Sat of previous week or just rolling 7 days)
const lastWeekRange = (now) => {
  const to = new Date(now);
  to.setHours(23, 59, 59, 999);
  to.setDate(to.getDate() - 1); // yesterday
  const from = new Date(to);
  from.setDate(from.getDate() - 6);
  from.setHours(0, 0, 0, 0);
  return { from, to, fromStr: istDayStr(from), toStr: istDayStr(to) };
};

const buildDeptReport = async (deptId, { from, to, fromStr, toStr }) => {
  const dept = await Department.findById(deptId).select("name").lean();
  if (!dept) return null;

  const members = await User.find({ department: deptId, isActive: true }).select("_id name designation role").lean();
  const memberIds = members.map((m) => m._id);
  if (!memberIds.length) return null;

  const [completedTasks, openTasks, bugs, projects] = await Promise.all([
    Task.find({
      assignees: { $in: memberIds },
      status: "completed",
      updatedAt: { $gte: from, $lte: to },
    }).select("title assignees estimatedHours actualHours priority project deadline").populate("project", "name").lean(),

    Task.find({
      assignees: { $in: memberIds },
      status: { $ne: "completed" },
      approvalStatus: { $ne: "pending" },
    }).select("title assignees status priority deadline project").populate("project", "name").lean(),

    BugReport.find({
      employee: { $in: memberIds },
      date: { $gte: fromStr, $lte: toStr },
    }).select("title severity status employee").populate("employee", "name").lean(),

    Project.find({
      members: { $in: memberIds },
      status: { $nin: ["archived", "cancelled"] },
    }).select("name status deadline weightage").lean(),
  ]);

  // Per-member task summary
  const memberMap = new Map(members.map((m) => [String(m._id), m]));
  const byMember = {};
  for (const m of members) byMember[String(m._id)] = { done: 0, open: 0, blocked: 0 };

  for (const t of completedTasks) {
    for (const a of t.assignees) {
      if (byMember[String(a)]) byMember[String(a)].done++;
    }
  }
  for (const t of openTasks) {
    for (const a of t.assignees) {
      if (byMember[String(a)]) {
        byMember[String(a)].open++;
        if (t.status === "blocked") byMember[String(a)].blocked++;
      }
    }
  }

  return { dept, members, memberMap, byMember, completedTasks, openTasks, bugs, projects };
};

const buildReportHtml = (data, { fromStr, toStr }) => {
  const { dept, members, memberMap, byMember, completedTasks, openTasks, bugs, projects } = data;
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Member table
  const memberRows = members
    .map((m) => {
      const s = byMember[String(m._id)];
      return `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(m.name)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-align:center">${esc(m.designation || m.role)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-align:center;color:#10b981"><strong>${s.done}</strong></td>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-align:center">${s.open}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-align:center;color:${s.blocked ? "#ef4444" : "#6b7280"}">${s.blocked}</td>
      </tr>`;
    })
    .join("");

  // Bug summary
  const bugRows = bugs.length
    ? bugs
        .slice(0, 20)
        .map(
          (b) =>
            `<tr>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(b.title)}</td>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(b.employee?.name || "")}</td>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-transform:capitalize">${esc(b.severity)}</td>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-transform:capitalize">${esc(b.status)}</td>
            </tr>`
        )
        .join("")
    : `<tr><td colspan="4" style="padding:12px;color:#6b7280;text-align:center">No bugs reported this week</td></tr>`;

  // Project summary
  const projectRows = projects.length
    ? projects
        .map(
          (p) =>
            `<tr>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(p.name)}</td>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-transform:capitalize">${esc(p.status)}</td>
              <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${p.deadline ? fmtDate(p.deadline) : "—"}</td>
            </tr>`
        )
        .join("")
    : `<tr><td colspan="3" style="padding:12px;color:#6b7280;text-align:center">No active projects</td></tr>`;

  const table = (headers, rows) => `
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
      <thead>
        <tr style="background:#f3f4f6">
          ${headers.map((h) => `<th style="padding:8px 12px;text-align:left;font-weight:600;border-bottom:2px solid #e8e5e0">${h}</th>`).join("")}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  return `
<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1c1b19;max-width:700px">
  <h2 style="color:#4f46e5;margin-bottom:4px">Weekly Department Report</h2>
  <p style="color:#6b7280;margin-top:0"><strong>${esc(dept.name)}</strong> · ${fromStr} to ${toStr}</p>
  <hr style="border:none;border-top:1px solid #e8e5e0;margin:16px 0"/>

  <h3 style="margin-bottom:4px">👥 Team Task Summary</h3>
  ${table(["Member", "Designation", "Tasks Done", "Open", "Blocked"], memberRows)}

  <h3 style="margin:24px 0 4px">🐛 Bugs This Week (${bugs.length})</h3>
  ${table(["Title", "Employee", "Severity", "Status"], bugRows)}

  <h3 style="margin:24px 0 4px">📁 Active Projects (${projects.length})</h3>
  ${table(["Project", "Status", "Deadline"], projectRows)}

  <p style="margin-top:24px;font-size:12px;color:#9ca3af">
    This report was automatically generated by WOS. It covers tasks completed and bugs reported between ${fromStr} and ${toStr}.
  </p>
</div>`;
};

// Main entry point — called by server.js's scheduler on Mondays
export const sendWeeklyDirectorReports = async (now = new Date()) => {
  if (!emailConfigured()) return { skipped: true, reason: "email not configured" };

  const range = lastWeekRange(now);
  // Find all directors with a department assignment
  const directors = await User.find({ role: "director", isActive: true, department: { $ne: null } })
    .select("name email department")
    .lean();

  if (!directors.length) return { sent: 0 };

  let sent = 0;
  const errors = [];
  for (const director of directors) {
    try {
      const data = await buildDeptReport(director.department, range);
      if (!data) continue;
      const html = buildReportHtml(data, range);
      await sendEmail({
        to: director.email,
        subject: `Weekly Report: ${data.dept.name} — ${range.fromStr} to ${range.toStr}`,
        html,
      });
      sent++;
    } catch (e) {
      errors.push({ director: director.email, error: e.message });
      console.error(`weekly director report failed for ${director.email}:`, e.message);
    }
  }

  return { sent, errors };
};
