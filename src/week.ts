// ISO 8601 weeks in UTC. A week string matches the schema's week pattern.

export const WEEK_PATTERN = /^20[2-9][0-9]-W(0[1-9]|[1-4][0-9]|5[0-3])$/;

const DAY_MS = 86_400_000;

// The Monday 00:00 UTC that starts the ISO week of the date.
function mondayOf(date: Date): number {
  const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return day - weekday * DAY_MS;
}

export function isoWeek(date: Date): string {
  const monday = mondayOf(date);
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const firstThursday = mondayOf(new Date(Date.UTC(year, 0, 4))) + 3 * DAY_MS;
  const week = 1 + Math.round((thursday.getTime() - firstThursday) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// [start, end) of a week, in milliseconds since the epoch.
export function weekRange(week: string): { start: number; end: number } | null {
  if (!WEEK_PATTERN.test(week)) return null;
  const year = Number(week.slice(0, 4));
  const number = Number(week.slice(6));
  const start = mondayOf(new Date(Date.UTC(year, 0, 4))) + (number - 1) * 7 * DAY_MS;
  // Week 53 exists only in some years.
  if (isoWeek(new Date(start)) !== week) return null;
  return { start, end: start + 7 * DAY_MS };
}

// The ISO week before the week of the date.
export function previousWeek(date: Date): string {
  return isoWeek(new Date(mondayOf(date) - DAY_MS));
}

// "YYYY-MM-DD HH:MM:SS" in UTC, for the Analytics Engine SQL API.
export function sqlDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}
