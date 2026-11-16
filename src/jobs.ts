// The scheduled jobs (docs/design/intake.md): an hourly health job and a
// weekly aggregation job. Both read Analytics Engine through the SQL API and
// write small JSON documents to KV. No IP and no secret is ever written.
import { buildStats, INDEX_SCHEMA, type StatsIndex, validateRow } from "./stats.ts";
import { countValue, querySql, SqlError } from "./sql.ts";
import { isoWeek, previousWeek, sqlDateTime, WEEK_PATTERN, weekRange } from "./week.ts";

export const HEALTH_KEY = "health/latest.json";
export const INDEX_KEY = "aggregates/index.json";
export const HEALTH_SCHEMA = "frostyard.problem-intake-health/1";

export const HEALTH_CRON = "17 * * * *";
// Cloudflare counts the days of the week from 1 = Sunday to 7 = Saturday, so
// Monday is 2 (https://developers.cloudflare.com/workers/configuration/cron-triggers/).
// test/node/wrangler-config.test.mjs reads the field with that numbering.
export const WEEKLY_CRON = "23 3 * * 2";

// A run also writes each missing week of this many weeks before the previous
// week, after the first week in the index (docs/specs/stats.md, rule 1).
// Analytics Engine keeps data for 3 months, so 8 weeks are still there.
export const CATCH_UP_WEEKS = 8;

const HOUR_MS = 3_600_000;
const WEEK_MS = 7 * 86_400_000;

export function weekKey(week: string): string {
  return `aggregates/${week}.json`;
}

function failureSql(start: number, end: number): string {
  return (
    "SELECT SUM(_sample_interval) AS n FROM problem_intake_health " +
    `WHERE blob1 = 'forward_failed' AND timestamp >= toDateTime('${sqlDateTime(start)}') ` +
    `AND timestamp < toDateTime('${sqlDateTime(end)}') FORMAT JSON`
  );
}

async function failures(env: Env, start: number, end: number): Promise<number> {
  const rows = await querySql(env, failureSql(start, end));
  if (rows.length === 0) return 0;
  const row = rows[0];
  // SUM over no rows can come back as null.
  const raw = row !== null && typeof row === "object" ? (row as { n?: unknown }).n : undefined;
  if (rows.length !== 1 || raw === undefined) throw new SqlError("malformed");
  if (raw === null) return 0;
  const n = countValue(raw);
  if (n === null) throw new SqlError("malformed");
  return n;
}

export interface HealthDocument {
  schema: typeof HEALTH_SCHEMA;
  checked_at: string;
  forward_failures: { last_hour: number; last_day: number };
}

export async function runHealthJob(env: Env, now: number): Promise<HealthDocument> {
  const document: HealthDocument = {
    schema: HEALTH_SCHEMA,
    checked_at: new Date(now).toISOString(),
    forward_failures: {
      last_hour: await failures(env, now - HOUR_MS, now),
      last_day: await failures(env, now - 24 * HOUR_MS, now),
    },
  };
  await env.STATS.put(HEALTH_KEY, JSON.stringify(document));
  return document;
}

export function weeklySql(start: number, end: number): string {
  return (
    "SELECT blob1 AS kind, blob2 AS image_id, blob3 AS image_version, blob6 AS class, blob7 AS app_id, " +
    "SUM(_sample_interval) AS n FROM problem_reports " +
    `WHERE timestamp >= toDateTime('${sqlDateTime(start)}') AND timestamp < toDateTime('${sqlDateTime(end)}') ` +
    "GROUP BY kind, image_id, image_version, class, app_id FORMAT JSON"
  );
}

export async function readIndex(env: Env): Promise<StatsIndex> {
  const raw = await env.STATS.get(INDEX_KEY, "json");
  const weeks =
    raw !== null && typeof raw === "object" && Array.isArray((raw as { weeks?: unknown }).weeks)
      ? (raw as { weeks: unknown[] }).weeks.filter((w): w is string => typeof w === "string" && WEEK_PATTERN.test(w))
      : [];
  return { schema: INDEX_SCHEMA, weeks };
}

// The weeks a run writes, oldest first: the previous week, and each earlier
// week of the catch-up window that is after the first indexed week and not in
// the index. An empty index means the first run: only the previous week.
export function weeksToRun(previous: string, indexed: readonly string[]): string[] {
  const start = (weekRange(previous) as { start: number; end: number }).start;
  const first = [...indexed].sort()[0];
  const weeks: string[] = [];
  for (let back = CATCH_UP_WEEKS; back >= 1; back--) {
    const week = isoWeek(new Date(start - back * WEEK_MS));
    if (first !== undefined && week > first && !indexed.includes(week)) weeks.push(week);
  }
  weeks.push(previous);
  return weeks;
}

async function writeWeek(env: Env, week: string): Promise<void> {
  const range = weekRange(week) as { start: number; end: number };
  const rows = (await querySql(env, weeklySql(range.start, range.end))).map(validateRow);
  await env.STATS.put(weekKey(week), JSON.stringify(buildStats(week, rows)));
}

// Aggregate the ISO week before the week of `now` (UTC), and the missing weeks
// before it. Each week stands alone: a week that fails writes nothing and
// stays out of the index, so the next run tries it again; the run then fails
// with the first error. Returns the weeks written.
export async function runWeeklyJob(env: Env, now: number): Promise<string[]> {
  const index = await readIndex(env);
  const written: string[] = [];
  let failure: unknown;
  for (const week of weeksToRun(previousWeek(new Date(now)), index.weeks)) {
    try {
      await writeWeek(env, week);
      written.push(week);
    } catch (error) {
      failure ??= error;
    }
  }
  if (written.length > 0) {
    const weeks = [...new Set([...index.weeks, ...written])].sort();
    await env.STATS.put(INDEX_KEY, JSON.stringify({ schema: INDEX_SCHEMA, weeks } satisfies StatsIndex));
  }
  if (failure !== undefined) throw failure;
  return written;
}

export async function runScheduled(cron: string, env: Env, now: number): Promise<void> {
  if (cron === HEALTH_CRON) await runHealthJob(env, now);
  else if (cron === WEEKLY_CRON) await runWeeklyJob(env, now);
  else throw new Error("unknown_cron");
}
