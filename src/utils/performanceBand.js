// Single source of truth for score -> band, shared by appraisalController.js
// (display) and memoSweep.js (memo decisions) so the two can never disagree
// on what counts as Red.
export const bandFor = (score, thresholds) => {
  if (score === null || score === undefined || !thresholds) return null;
  if (score < thresholds.red) return "red";
  if (score < thresholds.yellow) return "yellow";
  return "green";
};
