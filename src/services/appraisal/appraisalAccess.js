import { APPRAISAL_MANAGE_ROLES, APPRAISAL_VIEW_ALL_ROLES, TEAM_LEAD_ROLES } from "../../constants/appraisal.constants.js";
import { getManagedUserIds } from "../../utils/departmentScope.js";

// Server-side appraisal visibility — the frontend hides things too, but
// only these checks count.
//   admin/hr        full read + write
//   director        full read (matches its read access to the legacy roster)
//   manager/sublead/subadmin  read their managed people's FINALIZED appraisals
//   everyone        read their own FINALIZED appraisals
export const canManage = (user) => APPRAISAL_MANAGE_ROLES.includes(user.role);
export const canViewAll = (user) => APPRAISAL_VIEW_ALL_ROLES.includes(user.role);
export const isTeamLead = (user) => TEAM_LEAD_ROLES.includes(user.role);

export const managedIdSet = async (user) => (isTeamLead(user) ? new Set((await getManagedUserIds(user)).map(String)) : new Set());

export const canViewAppraisal = async (user, appraisal) => {
  if (canViewAll(user)) return true;
  if (appraisal.status !== "finalized") return false;
  const subject = String(appraisal.user?._id || appraisal.user);
  if (subject === String(user._id)) return true;
  return (await managedIdSet(user)).has(subject);
};

// What a non-HR viewer (the employee, their lead) gets: scores, ratings and
// improvement areas — not HR's working notes, override reasons, the raw
// calculation trail or the reopen history.
export const sanitizeAppraisal = (appraisal, user) => {
  const obj = appraisal.toObject ? appraisal.toObject() : { ...appraisal };
  if (canViewAll(user)) return obj;
  delete obj.evaluations;
  delete obj.reopenHistory;
  delete obj.configSnapshot;
  delete obj.missingInputs;
  if (obj.hrInputs) obj.hrInputs = { leaves: obj.hrInputs.leaves, lateMarks: obj.hrInputs.lateMarks, scoreFrom: obj.hrInputs.scoreFrom ?? null, scoreTo: obj.hrInputs.scoreTo ?? null };
  obj.entries = (obj.entries || []).map((e) => ({
    criterionKey: e.criterionKey,
    name: e.name,
    type: e.type,
    group: e.group,
    weightage: e.weightage,
    ratingLabel: e.ratingLabel,
    performancePct: e.performancePct,
    score: e.score,
    maxScore: e.maxScore,
  }));
  if (obj.metricsSnapshot) {
    const m = obj.metricsSnapshot;
    obj.metricsSnapshot = {
      tasks: m.tasks && { ...m.tasks, list: undefined },
      projects: m.projects && { list: (m.projects.list || []).map((p) => ({ name: p.name, total: p.total, completed: p.completed })) },
      bugs: m.bugs && { counted: m.bugs.counted, list: (m.bugs.list || []).filter((b) => b.counted).map((b) => ({ title: b.title, severityLabel: b.severityLabel, date: b.date })) },
      clientChanges: m.clientChanges && { total: m.clientChanges.total, penalized: m.clientChanges.penalized },
    };
  }
  return obj;
};
