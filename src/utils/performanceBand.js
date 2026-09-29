// Score -> Red/Yellow/Green band for the legacy appraisal view
// (appraisalController.js), from the team's configured thresholds.
export const bandFor = (score, thresholds) => {
  if (score === null || score === undefined || !thresholds) return null;
  if (score < thresholds.red) return "red";
  if (score < thresholds.yellow) return "yellow";
  return "green";
};
