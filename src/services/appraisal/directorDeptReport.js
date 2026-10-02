import EmployeeAppraisal from "../../models/EmployeeAppraisal.js";
import User from "../../models/User.js";
import Department from "../../models/Department.js";
import { emailConfigured, sendEmail } from "../resend.js";
import { monthLabel } from "./appraisalPeriod.js";
import { roundDisplay } from "./appraisalMath.js";

// ─────────────────────────────────────────────────────────────────────────
// Director Department Appraisal Report
//
// Triggered from appraisalsController.js whenever HR finalizes an appraisal.
// Logic: after each finalization, check if ALL active employees in that
// department are now finalized. If yes — and the email hasn't been sent yet
// for this month — email every director whose `department` matches.
//
// The "already sent" gate is stored as a per-month, per-dept Set in memory
// (sufficient since the process is long-lived and restarts clear monthly
// work). A full persistence layer (e.g. a new Mongo doc) would be needed
// if restart-safety matters — add it there without changing this API.
// ─────────────────────────────────────────────────────────────────────────

// In-memory guard: "dept-id:month" strings already notified this run.
const sentDeptMonths = new Set();

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const buildHtml = (dept, month, rows) => {
  const rowHtml = rows
    .map(
      (r) => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(r.name)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(r.designation || "—")}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0;text-align:center;font-weight:600">${r.score !== null ? roundDisplay(r.score) : "—"}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #e8e5e0">${esc(r.classification || "—")}</td>
    </tr>`
    )
    .join("");

  const avgScore = rows.length
    ? roundDisplay(rows.reduce((s, r) => s + (r.score || 0), 0) / rows.length)
    : "—";

  return `
<div style="font-family:Arial,sans-serif;line-height:1.6;color:#1c1b19;max-width:650px">
  <h2 style="color:#4f46e5;margin-bottom:4px">Appraisal Report — ${esc(dept.name)}</h2>
  <p style="color:#6b7280;margin-top:0">Month: <strong>${esc(monthLabel(month))}</strong> &nbsp;·&nbsp; Avg. Score: <strong>${avgScore} / 100</strong></p>
  <hr style="border:none;border-top:1px solid #e8e5e0;margin:16px 0"/>
  <p>All active members of <strong>${esc(dept.name)}</strong> have been finalized for <strong>${esc(monthLabel(month))}</strong>. Here is the full department summary:</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
    <thead>
      <tr style="background:#f3f4f6">
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e8e5e0">Employee</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e8e5e0">Designation</th>
        <th style="padding:8px 12px;text-align:center;border-bottom:2px solid #e8e5e0">Score</th>
        <th style="padding:8px 12px;text-align:left;border-bottom:2px solid #e8e5e0">Performance</th>
      </tr>
    </thead>
    <tbody>${rowHtml}</tbody>
  </table>
  <p style="margin-top:20px;font-size:12px;color:#9ca3af">
    This email was sent automatically because all ${rows.length} active employee(s) in your department have been finalized by HR.
  </p>
</div>`;
};

/**
 * After HR finalizes an appraisal, call this to check if the whole department
 * is now done. If yes, email every director of that department.
 *
 * @param {string|ObjectId} deptId  - The department whose appraisal was just finalized.
 * @param {string}          month   - "YYYY-MM" appraisal month.
 */
export const maybeSendDirectorDeptReport = async (deptId, month) => {
  if (!deptId || !month) return;
  if (!emailConfigured()) return;

  const key = `${deptId}:${month}`;
  if (sentDeptMonths.has(key)) return; // Already sent this session

  try {
    // All active, appraisable employees in this department
    const deptMembers = await User.find({
      department: deptId,
      isActive: true,
      role: { $nin: ["admin", "director", "hr"] }, // only appraisable roles
    })
      .select("_id")
      .lean();

    if (!deptMembers.length) return;
    const memberIds = deptMembers.map((m) => m._id);

    // Count finalized appraisals for this dept+month
    const finalizedCount = await EmployeeAppraisal.countDocuments({
      user: { $in: memberIds },
      month,
      status: "finalized",
    });

    if (finalizedCount < memberIds.length) return; // Not all done yet

    // All done — mark guard early to prevent concurrent double-sends
    sentDeptMonths.add(key);

    const [dept, directors, appraisals] = await Promise.all([
      Department.findById(deptId).select("name").lean(),
      User.find({ role: "director", department: deptId, isActive: true }).select("name email").lean(),
      EmployeeAppraisal.find({ user: { $in: memberIds }, month })
        .populate("user", "name designation")
        .select("user totalScore classification")
        .lean(),
    ]);

    if (!dept || !directors.length) return;

    const rows = appraisals.map((a) => ({
      name: a.user?.name || "Unknown",
      designation: a.user?.designation || "",
      score: a.totalScore,
      classification: a.classification?.label || "",
    }));

    const html = buildHtml(dept, month, rows);

    for (const dir of directors) {
      await sendEmail({
        to: dir.email,
        subject: `${dept.name} — ${monthLabel(month)} Appraisals Finalized`,
        html,
      }).catch((e) => console.error(`director dept report email failed (${dir.email}):`, e.message));
    }

    console.log(`[director-report] Sent ${dept.name} ${month} report to ${directors.length} director(s)`);
  } catch (e) {
    console.error("[director-report] Failed:", e.message);
    // Remove guard so it can retry on next finalization
    sentDeptMonths.delete(key);
  }
};
