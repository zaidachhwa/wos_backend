// Evaluation frequency period bounds and expected periods calculation

const pad = (n) => String(n).padStart(2, "0");

export const toYMD = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

export const daysInMonth = (year, month1Indexed) => new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();

export const getPeriodBounds = (frequency, dateStr) => {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    dateStr = now.toISOString().slice(0, 10);
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  const monthStr = dateStr.slice(0, 7);
  const lastDayOfMonth = daysInMonth(year, month);

  switch (frequency) {
    case "daily":
      return {
        frequency: "daily",
        startDate: dateStr,
        endDate: dateStr,
        month: monthStr,
        label: dateStr,
      };

    case "weekly": {
      const dt = new Date(Date.UTC(year, month - 1, day));
      const dayOfWeek = dt.getUTCDay(); // 0=Sun, 1=Mon...
      const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const monday = new Date(Date.UTC(year, month - 1, day + diffToMonday));
      const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
      const start = toYMD(monday);
      const end = toYMD(sunday);
      return {
        frequency: "weekly",
        startDate: start,
        endDate: end,
        month: start.slice(0, 7),
        label: `Week ${start} to ${end}`,
      };
    }

    case "biweekly": {
      if (day <= 14) {
        return {
          frequency: "biweekly",
          startDate: `${monthStr}-01`,
          endDate: `${monthStr}-14`,
          month: monthStr,
          label: `Biweekly 1st–14th (${monthStr})`,
        };
      }
      return {
        frequency: "biweekly",
        startDate: `${monthStr}-15`,
        endDate: `${monthStr}-${pad(lastDayOfMonth)}`,
        month: monthStr,
        label: `Biweekly 15th–End (${monthStr})`,
      };
    }

    case "monthly":
    default:
      return {
        frequency: "monthly",
        startDate: `${monthStr}-01`,
        endDate: `${monthStr}-${pad(lastDayOfMonth)}`,
        month: monthStr,
        label: `Month of ${monthStr}`,
      };
  }
};

export const getExpectedPeriodsForMonth = (frequency, monthStr) => {
  if (!monthStr || !/^\d{4}-\d{2}$/.test(monthStr)) {
    const now = new Date(Date.now() + 5.5 * 3600 * 1000);
    monthStr = now.toISOString().slice(0, 7);
  }

  const [year, month] = monthStr.split("-").map(Number);
  const lastDay = daysInMonth(year, month);

  switch (frequency) {
    case "daily": {
      const periods = [];
      for (let d = 1; d <= lastDay; d++) {
        const dayStr = `${monthStr}-${pad(d)}`;
        periods.push({
          frequency: "daily",
          startDate: dayStr,
          endDate: dayStr,
          month: monthStr,
          label: dayStr,
        });
      }
      return periods;
    }

    case "weekly": {
      const periods = [];
      const seen = new Set();
      for (let d = 1; d <= lastDay; d += 7) {
        const dayStr = `${monthStr}-${pad(d)}`;
        const bounds = getPeriodBounds("weekly", dayStr);
        if (!seen.has(bounds.startDate)) {
          seen.add(bounds.startDate);
          periods.push(bounds);
        }
      }
      // Also check the last day of month to catch the final week
      const endDayStr = `${monthStr}-${pad(lastDay)}`;
      const endBounds = getPeriodBounds("weekly", endDayStr);
      if (!seen.has(endBounds.startDate)) {
        seen.add(endBounds.startDate);
        periods.push(endBounds);
      }
      return periods;
    }

    case "biweekly":
      return [
        {
          frequency: "biweekly",
          startDate: `${monthStr}-01`,
          endDate: `${monthStr}-14`,
          month: monthStr,
          label: `Period 1 (1st–14th)`,
        },
        {
          frequency: "biweekly",
          startDate: `${monthStr}-15`,
          endDate: `${monthStr}-${pad(lastDay)}`,
          month: monthStr,
          label: `Period 2 (15th–End)`,
        },
      ];

    case "monthly":
    default:
      return [
        {
          frequency: "monthly",
          startDate: `${monthStr}-01`,
          endDate: `${monthStr}-${pad(lastDay)}`,
          month: monthStr,
          label: `Monthly (${monthStr})`,
        },
      ];
  }
};
