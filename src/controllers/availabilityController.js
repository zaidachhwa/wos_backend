import { computeAvailability, visiblePeople } from "../services/availability.js";

// Team Lead / Project Manager / Technical Coordinator panel: who is engaged
// until when, and when each person gets free. Grouped by the capacity the
// viewer sees them in (a person can appear under more than one group).
export const getAvailability = async (req, res) => {
  try {
    const groups = await visiblePeople(req.user);
    const allIds = [...new Set(groups.flatMap((g) => g.userIds))];
    const rows = await computeAvailability(allIds);
    const byId = new Map(rows.map((r) => [String(r.user._id), r]));
    const data = groups.map((g) => ({
      label: g.label,
      people: g.userIds.map((id) => byId.get(id)).filter(Boolean).sort((a, b) => {
        const order = { overdue: 0, engaged: 1, free: 2 };
        return order[a.status] - order[b.status] || (a.engagedUntil || 0) - (b.engagedUntil || 0);
      }),
    }));
    const summary = {
      total: rows.length,
      free: 0,
      engaged: 0,
      overdue: 0,
      freeWithin7Days: 0,
      highPriorityTasks: 0,
      highPriorityProjects: 0,
    };
    for (const r of rows) {
      summary[r.status] += 1;
      if (r.status === "engaged" && r.daysUntilFree <= 7) summary.freeWithin7Days += 1;
      if (r.highestTaskPriority === "high") summary.highPriorityTasks += 1;
      if (r.highestProjectPriority === "high") summary.highPriorityProjects += 1;
    }
    return res.json({ success: true, message: "Availability fetched", data: { groups: data, summary, hasAccess: groups.length > 0 } });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
