import AppraisalAuditLog from "../../models/AppraisalAuditLog.js";

// Awaited (unlike utils/record.js's fire-and-forget activity feed): an
// appraisal change without its audit row is worse than a slower request.
// Still never throws — a logging failure must not undo the change it logs.
export const audit = async ({ actor = null, action, entityType, entityId = null, subject = null, month = null, before = null, after = null, meta = null }) => {
  try {
    await AppraisalAuditLog.create({
      actor: actor?._id || actor,
      action,
      entityType,
      entityId,
      subject,
      month,
      before,
      after,
      meta,
    });
  } catch (error) {
    console.error("appraisal audit write failed:", error.message);
  }
};

// Shallow before/after diff of the listed fields — keeps audit rows small
// and readable ("weightage: 15 -> 20") instead of whole-document dumps.
export const diffFields = (before, after, fields) => {
  const b = {};
  const a = {};
  for (const f of fields) {
    const bv = before?.[f];
    const av = after?.[f];
    if (JSON.stringify(bv) !== JSON.stringify(av)) {
      b[f] = bv ?? null;
      a[f] = av ?? null;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
};
