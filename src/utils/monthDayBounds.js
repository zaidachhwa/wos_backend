// "YYYY-MM" -> "YYYY-MM-DD" string bounds for fields stored as plain date
// strings (Attendance.date, FollowUp.date) — string comparison works
// correctly against ISO-format dates, no Date parsing needed.
export const monthDayBounds = (monthStr) => {
  const m = monthStr || new Date().toISOString().slice(0, 7);
  const [y, mo] = m.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { dayStart: `${m}-01`, dayEnd: `${m}-${String(lastDay).padStart(2, "0")}` };
};
