import AvailabilityAlertState from "../models/AvailabilityAlertState.js";
import User from "../models/User.js";
import { emailConfigured, sendEmail } from "./email.js";
import { computeAvailability } from "./availability.js";
import { istClock } from "../utils/istTime.js";

// Emails each Technical Coordinator, for every person in their department:
// 7, 5, 3, 2 and 1 day(s) before that person gets free, and once they are
// free. Runs hourly from 09:00 IST (server.js). Every send is claimed in
// AvailabilityAlertState *before* it goes out (atomic update), so overlapping
// runs can't double-send; a failed send releases its claim and is retried
// on the next run.

export const COUNTDOWN_DAYS = [7, 5, 3, 2, 1];
const SEND_GAP_MS = 550; // Outbound SMTP pacing gap
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const appUrl = () => (process.env.APP_URL || process.env.CLIENT_ORIGIN || "").replace(/\/$/, "");
const fmtDay = (d) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });

const buildEmail = (row, days) => {
  const name = row.user.name;
  const subject = days ? `${name} will be free in ${days} day${days === 1 ? "" : "s"} (${fmtDay(row.engagedUntil)})` : `${name} is now free`;
  const tasks = row.tasks
    .slice(-10)
    .map((t) => {
      const pri = t.priority ? ` [${esc(t.priority.toUpperCase())}]` : "";
      const proj = t.project ? ` — ${esc(t.project)}${t.projectPriority ? ` (${esc(t.projectPriority)} priority)` : ""}` : "";
      return `<li>${esc(t.title)}${pri}${proj} (due ${esc(fmtDay(t.dueAt))})</li>`;
    })
    .join("");
  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1c1b19; max-width: 600px;">
    <p><strong>${esc(name)}</strong>${row.user.designation ? ` (${esc(row.user.designation)})` : ""}
      ${days ? `will be free in <strong>${days} day${days === 1 ? "" : "s"}</strong>, after <strong>${esc(fmtDay(row.engagedUntil))}</strong>.` : "is <strong>now free</strong> — no open tasks with an upcoming deadline."}</p>
    ${tasks ? `<p>Current work:</p><ul>${tasks}</ul>` : ""}
    ${row.undatedTasks ? `<p style="color:#6f6b63">Plus ${row.undatedTasks} open task(s) without a deadline.</p>` : ""}
    <p><a href="${esc(appUrl())}/availability">Open team availability in WOS</a></p>
  </div>`;
  return { subject, html };
};

// Claim helpers — return true only for the run that actually claimed.
const claimCountdown = async (userId, freeDay, days) =>
  (await AvailabilityAlertState.updateOne({ user: userId, freeDay, sent: { $ne: days } }, { $push: { sent: days } })).modifiedCount === 1;
const releaseCountdown = (userId, freeDay, days) => AvailabilityAlertState.updateOne({ user: userId, freeDay }, { $pull: { sent: days } });
const claimFree = async (userId) =>
  (await AvailabilityAlertState.updateOne({ user: userId, freeSent: false }, { $set: { freeSent: true } })).modifiedCount === 1;
const releaseFree = (userId) => AvailabilityAlertState.updateOne({ user: userId }, { $set: { freeSent: false } });

export const runAvailabilityAlerts = async (now = new Date(), { sender = null, ignoreHour = false } = {}) => {
  const send = sender || (emailConfigured() ? sendEmail : null);
  if (!send) return { skipped: true, reason: "email not configured" };
  if (!ignoreHour && istClock(now).hours < 9) return { skipped: true, reason: "before 09:00 IST" };

  const coordinators = await User.find({ role: "technical_coordinator", isActive: true, department: { $ne: null } }).select("name email department").lean();
  const byDept = new Map();
  for (const c of coordinators) {
    const key = String(c.department);
    if (!byDept.has(key)) byDept.set(key, []);
    byDept.get(key).push(c);
  }

  let sent = 0;
  let attempted = 0;
  const errors = [];
  for (const [deptId, recipientsAll] of byDept) {
    const people = await User.find({ department: deptId, isActive: true, role: { $nin: ["admin", "director"] } }).distinct("_id");
    const rows = await computeAvailability(people, now);
    const states = new Map((await AvailabilityAlertState.find({ user: { $in: people } }).lean()).map((s) => [String(s.user), s]));

    for (const row of rows) {
      const uid = row.user._id;
      const state = states.get(String(uid));
      let event = null; // { days } countdown, or { days: 0 } now free

      if (row.status === "engaged") {
        if (!state || state.freeDay !== row.freeDay) {
          // New (or moved) engagement: start a fresh countdown.
          await AvailabilityAlertState.updateOne({ user: uid }, { $set: { freeDay: row.freeDay, sent: [], freeSent: false } }, { upsert: true });
        }
        if (COUNTDOWN_DAYS.includes(row.daysUntilFree) && (await claimCountdown(uid, row.freeDay, row.daysUntilFree))) {
          event = { days: row.daysUntilFree };
        }
      } else if (row.status === "free") {
        if (!state) {
          // First time we see someone already free: baseline only, so the
          // feature going live doesn't email "now free" for everyone.
          await AvailabilityAlertState.updateOne({ user: uid }, { $setOnInsert: { freeDay: null, sent: [], freeSent: true } }, { upsert: true });
        } else if (await claimFree(uid)) {
          event = { days: 0 };
        }
      }
      if (!event) continue;

      const recipients = recipientsAll.filter((c) => String(c._id) !== String(uid));
      const { subject, html } = buildEmail(row, event.days);
      let failures = 0;
      for (const r of recipients) {
        if (attempted > 0) await sleep(SEND_GAP_MS);
        attempted += 1;
        try {
          await send({ to: r.email, subject, html });
          sent += 1;
        } catch (error) {
          failures += 1;
          errors.push({ to: r.email, user: row.user.name, error: error.message });
          console.error(`availability alert to ${r.email} failed:`, error.message);
        }
      }
      // Nobody got it (every send failed): release so the next run retries.
      if (recipients.length && failures === recipients.length) {
        if (event.days) await releaseCountdown(uid, row.freeDay, event.days);
        else await releaseFree(uid);
      }
    }
  }
  return { sent, errors };
};
