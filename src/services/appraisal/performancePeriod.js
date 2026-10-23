// Evaluation frequency period bounds and expected periods calculation.
// All dates are IST calendar days ("YYYY-MM-DD"); the arithmetic below runs on
// UTC midnights purely as a calendar, so no timezone shift can creep in.
//
//   daily    — the single day
//   weekly   — Monday to Saturday (Sunday belongs to the week before it)
//   biweekly — two working weeks: 1st Monday to 2nd Saturday, 3rd Monday to
//              4th Saturday (a 5th week in the month joins the second period)
//   monthly  — the calendar month (1st to last day), marked once per working
//              week (same Monday–Saturday slots as weekly); the month's score
//              is the average of those weekly marks
//
// A week (and so a biweekly period) belongs to the month its Monday falls in,
// so days before a month's first Monday count towards the previous month.

const pad = (n) => String(n).padStart(2, "0");

export const toYMD = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const daysInMonth = (year, month1Indexed) => new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();

const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);

const parseYMD = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

const addDays = (date, n) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + n));

// Monday of the working week containing `date` (Sunday maps to the Monday before).
const mondayOf = (date) => {
  const dow = date.getUTCDay(); // 0=Sun, 1=Mon...
  return addDays(date, dow === 0 ? -6 : 1 - dow);
};

// First Monday on or after the 1st of the month.
const firstMondayOfMonth = (year, month1Indexed) => {
  const first = new Date(Date.UTC(year, month1Indexed - 1, 1));
  const dow = first.getUTCDay();
  return addDays(first, (8 - dow) % 7);
};

// Mondays of every working week belonging to the month.
const mondaysOfMonth = (monthStr) => {
  const [year, month] = monthStr.split("-").map(Number);
  const mondays = [];
  for (let m = firstMondayOfMonth(year, month); m.getUTCMonth() === month - 1; m = addDays(m, 7)) mondays.push(m);
  return mondays;
};

const weekPeriod = (monday, frequency = "weekly") => {
  const start = toYMD(monday);
  const end = toYMD(addDays(monday, 5));
  const month = start.slice(0, 7);
  const n = mondaysOfMonth(month).findIndex((m) => toYMD(m) === start) + 1;
  return { frequency, startDate: start, endDate: end, month, label: `Week ${n} (${start} to ${end})` };
};

// The biweekly periods of a month: weeks 1–2, then weeks 3–4 (+5).
const biweeklyPeriodsOfMonth = (monthStr) => {
  const mondays = mondaysOfMonth(monthStr);
  const groups = [mondays.slice(0, 2), mondays.slice(2)];
  return groups.map((weeks, i) => {
    const start = toYMD(weeks[0]);
    const end = toYMD(addDays(weeks[weeks.length - 1], 5));
    return { frequency: "biweekly", startDate: start, endDate: end, month: monthStr, label: `Period ${i + 1} (${start} to ${end})` };
  });
};

const monthPeriod = (monthStr) => {
  const [year, month] = monthStr.split("-").map(Number);
  return {
    frequency: "monthly",
    startDate: `${monthStr}-01`,
    endDate: `${monthStr}-${pad(daysInMonth(year, month))}`,
    month: monthStr,
    label: `Month of ${monthStr}`,
  };
};

// The whole calendar month a monthly criterion's weekly marks roll up into.
export const getMonthBounds = (monthStr) => monthPeriod(monthStr);

export const getPeriodBounds = (frequency, dateStr) => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) dateStr = istToday();

  switch (frequency) {
    case "daily":
      return { frequency: "daily", startDate: dateStr, endDate: dateStr, month: dateStr.slice(0, 7), label: dateStr };

    case "weekly":
      return weekPeriod(mondayOf(parseYMD(dateStr)));

    case "biweekly": {
      const monday = toYMD(mondayOf(parseYMD(dateStr)));
      const periods = biweeklyPeriodsOfMonth(monday.slice(0, 7));
      return monday >= periods[1].startDate ? periods[1] : periods[0];
    }

    case "monthly":
    default:
      return weekPeriod(mondayOf(parseYMD(dateStr)), "monthly");
  }
};

export const getExpectedPeriodsForMonth = (frequency, monthStr) => {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) monthStr = istToday().slice(0, 7);

  switch (frequency) {
    case "daily": {
      const [year, month] = monthStr.split("-").map(Number);
      const periods = [];
      for (let d = 1; d <= daysInMonth(year, month); d++) periods.push(getPeriodBounds("daily", `${monthStr}-${pad(d)}`));
      return periods;
    }

    case "weekly":
      return mondaysOfMonth(monthStr).map(weekPeriod);

    case "biweekly":
      return biweeklyPeriodsOfMonth(monthStr);

    case "monthly":
    default:
      return mondaysOfMonth(monthStr).map((m) => weekPeriod(m, "monthly"));
  }
};
