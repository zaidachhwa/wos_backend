import AppraisalPeriod from "../../models/AppraisalPeriod.js";
import EmployeeAppraisal from "../../models/EmployeeAppraisal.js";
import User from "../../models/User.js";
import { notify } from "../../utils/record.js";
import { getActiveCriteria, getSettings, weightageStatus } from "./appraisalConfig.js";
import { audit } from "./appraisalAudit.js";
import { monthDueForClose, monthLabel, monthPeriod } from "./appraisalPeriod.js";
import { AppraisalError, appraisedUserFilter, ensureDrafts, finalizeAppraisal, recalculate } from "./appraisalService.js";
import { processEmailQueue, queueDueEmails } from "./appraisalEmails.js";

// Month close + email dispatch. Driven by server.js's once-a-minute tick
// (the same setInterval pattern every other WOS sweep uses — no second
// scheduler). From 00:01 IST on the 1st, the previous month is closed
// exactly once and its finalized appraisals are emailed exactly once:
//  - AppraisalPeriod's atomic open -> closing claim (with lock expiry, for
//    a run that crashed half-way) serializes closing across ticks/instances;
//  - drafts are upserts on the unique (user, month) key;
//  - finalize is conditional on status != finalized;
//  - emails go through the unique-per-appraisal log (appraisalEmails.js).

const LOCK_MS = 10 * 60 * 1000;

const claimPeriod = async (month, now) => {
  const { startAt, endAt, emailDueAt } = monthPeriod(month);
  await AppraisalPeriod.updateOne({ month }, { $setOnInsert: { month, startAt, endAt, emailDueAt, status: "open" } }, { upsert: true }).catch(
    (error) => {
      if (error.code !== 11000) throw error;
    }
  );
  return AppraisalPeriod.findOneAndUpdate(
    { month, $or: [{ status: "open" }, { status: "closing", lockedUntil: { $lt: now } }] },
    { $set: { status: "closing", lockedUntil: new Date(now.getTime() + LOCK_MS) } },
    { returnDocument: "after" }
  );
};

export const closeMonth = async (month, { now = new Date(), actor = null } = {}) => {
  const { endAt } = monthPeriod(month);
  if (now <= endAt) throw new AppraisalError("A month can only be closed after it has ended (IST)", 409);

  const period = await claimPeriod(month, now);
  if (!period) return { month, skipped: true, reason: "already closed or closing" };

  try {
    const [settings, criteria] = await Promise.all([getSettings(), getActiveCriteria()]);
    const users = await User.find(appraisedUserFilter(settings)).select("department");
    await ensureDrafts(users, month);

    const docs = await EmployeeAppraisal.find({ month, status: { $ne: "finalized" } });
    await recalculate(docs, { now, settings, criteria });

    const mode = settings.automation?.autoFinalizeMode || "complete";
    // Per department: one department with a bad allocation doesn't block the
    // rest — finalizeAppraisal re-checks each employee's own criteria set and
    // those failures land in `errors`.
    const weight = await weightageStatus(criteria, settings);
    let finalized = 0;
    const incomplete = [];
    const errors = [];
    for (const doc of docs) {
      const eligible =
        mode !== "off" &&
        doc.status !== "reopened" &&
        (mode === "complete" ? doc._complete : doc.status === "submitted" && doc._complete);
      if (!eligible) {
        if (!doc._complete) incomplete.push(String(doc.user));
        continue;
      }
      try {
        await finalizeAppraisal(doc, null, { now, settings, criteria, auto: true });
        finalized += 1;
      } catch (error) {
        errors.push({ user: String(doc.user), message: error.message });
      }
    }

    const summary = {
      appraisals: docs.length,
      finalized,
      incomplete: incomplete.length,
      weightageValid: weight.valid,
      mode,
      errors: errors.slice(0, 50),
    };
    await AppraisalPeriod.updateOne({ _id: period._id }, { $set: { status: "closed", closedAt: now, lockedUntil: null, closeSummary: summary } });
    await audit({ actor, action: "period_closed", entityType: "period", entityId: period._id, month, after: summary });

    // Tell HR what still needs them — the pending ones get emailed as soon
    // as HR finalizes them (see queueDueEmails).
    if (incomplete.length || !weight.valid || errors.length) {
      const hr = await User.find({ role: { $in: ["admin", "hr"] }, isActive: true }).select("_id");
      const body =
        `${finalized} finalized automatically; ${incomplete.length} still need HR input${errors.length ? `; ${errors.length} failed` : ""}.` +
        (weight.valid ? "" : ` Weightage problem — ${weight.message}`);
      for (const u of hr) {
        notify({ user: u._id, type: "appraisal_update", title: `${monthLabel(month)} appraisals closed`, body, link: `/appraisal?month=${month}` });
      }
    }
    return { month, ...summary };
  } catch (error) {
    // Release the claim so the next tick retries instead of waiting out the lock.
    await AppraisalPeriod.updateOne({ _id: period._id, status: "closing" }, { $set: { status: "open", lockedUntil: null } });
    throw error;
  }
};

let running = false;

// One scheduler tick. `sender` lets tests inject a fake mail transport.
export const runAppraisalScheduler = async (now = new Date(), { sender = null } = {}) => {
  if (running) return { skipped: true };
  running = true;
  try {
    const result = {};
    const due = monthDueForClose(now);
    if (due) {
      const period = await AppraisalPeriod.findOne({ month: due }).select("status lockedUntil").lean();
      if (!period || period.status === "open" || (period.status === "closing" && period.lockedUntil < now)) {
        result.close = await closeMonth(due, { now });
      }
    }
    const settings = await getSettings();
    result.queue = await queueDueEmails(now, { emailsEnabled: settings.automation?.emailsEnabled !== false });
    result.emails = await processEmailQueue(now, { maxAttempts: settings.automation?.maxEmailAttempts || 3, sender });
    return result;
  } finally {
    running = false;
  }
};
