import { resolveDepartmentScope } from "../utils/departmentScope.js";
import { monthBounds, computeMonthlyAppraisal } from "../services/monthlyAppraisal.js";
import { runMonthlyMemoSweep } from "../services/memoSweep.js";

export const getAppraisal = async (req, res) => {
  try {
    const { start, end } = monthBounds(req.query.month);

    const rosterFilter = { isActive: true, role: { $ne: "admin" } };
    const scope = await resolveDepartmentScope(req.user);
    if (scope) {
      rosterFilter.role = { $nin: ["admin", "subadmin"] };
      if (req.query.team) {
        if (!scope.teamIds.map(String).includes(String(req.query.team))) {
          return res.status(403).json({ success: false, message: "Forbidden" });
        }
        rosterFilter.team = req.query.team;
      } else {
        rosterFilter.$or = [{ team: { $in: scope.teamIds } }, { _id: req.user._id }];
      }
    } else if (req.query.team) {
      rosterFilter.team = req.query.team;
    }

    const { rows, configuration } = await computeMonthlyAppraisal({ start, end, rosterFilter });

    return res.json({
      success: true,
      message: "Appraisal fetched",
      data: { monthStart: start, monthEnd: end, configuration, rows },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};

export const runMemoSweep = async (req, res) => {
  try {
    const result = await runMonthlyMemoSweep(req.body?.month);
    return res.json({ success: true, message: "Memo sweep completed", data: result });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Something went wrong" });
  }
};
