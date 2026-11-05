import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.ts";
import { HEALTH_CRON, HEALTH_KEY, INDEX_KEY, runHealthJob, runWeeklyJob, WEEKLY_CRON, weekKey, weeklySql } from "../src/jobs.ts";
import { countValue } from "../src/sql.ts";
import { buildStats, validateRow } from "../src/stats.ts";
import { call, type Captured, makeEnv, mockFetch, TEST_ACCOUNT, TEST_AE_TOKEN } from "./helpers.ts";

const SQL_URL = `https://api.cloudflare.com/client/v4/accounts/${TEST_ACCOUNT}/analytics_engine/sql`;
// Monday 2026-11-09 03:23 UTC: the weekly job aggregates 2026-W45.
const MONDAY = Date.UTC(2026, 10, 9, 3, 23);

function sqlAnswer(data: unknown[]): Response {
  return new Response(JSON.stringify({ meta: [], data, rows: data.length }), {
    headers: { "Content-Type": "application/json" },
  });
}

async function clearKv(): Promise<void> {
  const list = await env.STATS.list();
  for (const key of list.keys) await env.STATS.delete(key.name);
}

beforeEach(clearKv);
afterEach(() => {
  vi.restoreAllMocks();
});

const ROWS = [
  { kind: "unit_failed", image_id: "snow", image_version: "20261031093822", class: "exit-code", app_id: "", n: "40" },
  { kind: "unit_failed", image_id: "snow", image_version: "20261101093822", class: "timeout", app_id: "", n: 2 },
  { kind: "crash", image_id: "snow", image_version: "20261031093822", class: "SIGSEGV", app_id: "", n: 9 },
  { kind: "tpm_unlock", image_id: "floe", image_version: "20261031093822", class: "ok_after_retry", app_id: "", n: 3 },
  { kind: "update_stage_failed", image_id: "sundog", image_version: "20261031093822", class: "network", app_id: "", n: 30 },
  { kind: "app_problem", image_id: "snow", image_version: "20261031093822", class: "panic", app_id: "org.frostyard.nsl", n: 12 },
  { kind: "app_problem", image_id: "floe", image_version: "20261031093822", class: "error", app_id: "org.frostyard.nsl", n: 6 },
  { kind: "app_problem", image_id: "snow", image_version: "20261031093822", class: "error", app_id: "org.frostyard.Frostmail", n: 1 },
  { kind: "count", image_id: "floe", image_version: "20261031093822", class: "", app_id: "", n: 25 },
  { kind: "count", image_id: "floe", image_version: "20261101093822", class: "", app_id: "", n: 4 },
  { kind: "count", image_id: "snow", image_version: "20261031093822", class: "", app_id: "", n: 70 },
];

describe("weekly job", () => {
  it("queries the previous ISO week with the read token and writes aggregates", async () => {
    const { calls } = mockFetch(() => sqlAnswer(ROWS));
    const week = await runWeeklyJob(makeEnv(), MONDAY);
    expect(week).toBe("2026-W45");
    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent.url).toBe(SQL_URL);
    expect(sent.headers.authorization).toBe(`Bearer ${TEST_AE_TOKEN}`);
    expect(sent.body).toBe(weeklySql(Date.UTC(2026, 10, 2), Date.UTC(2026, 10, 9)));
    expect(sent.body).toContain("SUM(_sample_interval)");
    expect(sent.body).toContain("toDateTime('2026-11-02 00:00:00')");
    expect(sent.body).toContain("toDateTime('2026-11-09 00:00:00')");

    const stored = await env.STATS.get(weekKey("2026-W45"), "json");
    expect(stored).toEqual(buildStats("2026-W45", ROWS.map(validateRow)));
    expect(await env.STATS.get(INDEX_KEY, "json")).toEqual({ schema: "frostyard.problem-stats-index/1", weeks: ["2026-W45"] });
    const text = JSON.stringify(stored);
    expect(text).not.toMatch(/[^0-9][1-4][,}]/);
  });

  it("builds the 3 tables with suppression", () => {
    const doc = buildStats("2026-W45", ROWS.map(validateRow));
    expect(doc.schema).toBe("frostyard.problem-stats/1");
    expect(doc.min_cell).toBe(5);
    expect(doc.tables.reports).toEqual({
      group_by: "image",
      cell_by: "kind",
      total: 84,
      groups: {
        floe: { total: null, cells: { tpm_unlock: null } },
        snow: { total: 51, cells: { crash: 9, unit_failed: 42 } },
        sundog: { total: null, cells: { update_stage_failed: null } },
      },
    });
    expect(doc.tables.app_problems.groups["org.frostyard.Frostmail"]).toEqual({ total: null, cells: { error: null } });
    expect(doc.tables.installs.groups.floe).toEqual({
      total: 29,
      cells: { "20261031093822": null, "20261101093822": null },
    });
  });

  it("keeps the index sorted and without duplicates", async () => {
    await env.STATS.put(INDEX_KEY, JSON.stringify({ weeks: ["2026-W46", "2026-W44", "bad"] }));
    mockFetch(() => sqlAnswer([]));
    await runWeeklyJob(makeEnv(), MONDAY);
    await runWeeklyJob(makeEnv(), MONDAY);
    expect(await env.STATS.get(INDEX_KEY, "json")).toEqual({
      schema: "frostyard.problem-stats-index/1",
      weeks: ["2026-W44", "2026-W45", "2026-W46"],
    });
  });

  it.each([
    ["an unknown kind", { ...ROWS[0], kind: "other" }],
    ["an unknown image", { ...ROWS[0], image_id: "windows" }],
    ["a bad version", { ...ROWS[0], image_version: "1.0" }],
    ["a class of another kind", { ...ROWS[0], class: "SIGSEGV" }],
    ["an app id on a system kind", { ...ROWS[0], app_id: "org.frostyard.nsl" }],
    ["an app id off the allowlist", { ...ROWS[5], app_id: "org.example.x" }],
    ["a negative count", { ...ROWS[0], n: -1 }],
    ["a fractional count", { ...ROWS[0], n: 1.5 }],
    ["a count string with text", { ...ROWS[0], n: "12abc" }],
    ["a missing count", { ...ROWS[0], n: undefined }],
    ["an array", []],
    ["null", null],
  ])("refuses %s and writes nothing", async (_name, row) => {
    mockFetch(() => sqlAnswer([row]));
    await expect(runWeeklyJob(makeEnv(), MONDAY)).rejects.toThrow("invalid_row");
    expect(await env.STATS.get(weekKey("2026-W45"))).toBeNull();
    expect(await env.STATS.get(INDEX_KEY)).toBeNull();
  });

  it.each([
    ["an error status", () => new Response("no", { status: 403 }), "status_403"],
    ["a body that is not JSON", () => new Response("<html>"), "malformed"],
    ["a body without data", () => new Response(JSON.stringify({ meta: [] })), "malformed"],
  ])("fails on %s", async (_name, answer, reason) => {
    mockFetch(answer);
    await expect(runWeeklyJob(makeEnv(), MONDAY)).rejects.toThrow(reason);
  });

  it.each([
    ["no token", { AE_READ_TOKEN: undefined }],
    ["an empty token", { AE_READ_TOKEN: "" }],
    ["no account", { CF_ACCOUNT_ID: undefined }],
    ["a bad account id", { CF_ACCOUNT_ID: "../x" }],
  ])("fails without a network call on %s", async (_name, overrides) => {
    const { calls } = mockFetch();
    await expect(runWeeklyJob(makeEnv(overrides), MONDAY)).rejects.toThrow("config");
    expect(calls).toHaveLength(0);
  });
});

describe("health job", () => {
  it("writes the forward failures of the last hour and day", async () => {
    const { calls } = mockFetch((c: Captured) => sqlAnswer([{ n: c.body.includes("2026-11-09 02:23:00") ? "2" : 7 }]));
    const doc = await runHealthJob(makeEnv(), MONDAY);
    expect(doc).toEqual({
      schema: "frostyard.problem-intake-health/1",
      checked_at: "2026-11-09T03:23:00.000Z",
      forward_failures: { last_hour: 2, last_day: 7 },
    });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe(SQL_URL);
      expect(c.body).toContain("FROM problem_intake_health");
      expect(c.body).toContain("blob1 = 'forward_failed'");
    }
    expect(await env.STATS.get(HEALTH_KEY, "json")).toEqual(doc);
  });

  it("reads no rows and a null sum as 0", async () => {
    let i = 0;
    mockFetch(() => sqlAnswer(i++ === 0 ? [] : [{ n: null }]));
    const doc = await runHealthJob(makeEnv(), MONDAY);
    expect(doc.forward_failures).toEqual({ last_hour: 0, last_day: 0 });
  });

  it.each([
    ["2 rows", [{ n: 1 }, { n: 2 }]],
    ["a row without n", [{ x: 1 }]],
    ["a bad count", [{ n: "x" }]],
    ["a row that is not an object", [3]],
  ])("fails on %s", async (_name, data) => {
    mockFetch(() => sqlAnswer(data));
    await expect(runHealthJob(makeEnv(), MONDAY)).rejects.toThrow("malformed");
    expect(await env.STATS.get(HEALTH_KEY)).toBeNull();
  });
});

describe("scheduled entry point", () => {
  function controller(cron: string): ScheduledController {
    return { cron, scheduledTime: MONDAY, noRetry: () => undefined };
  }

  it("runs the health job on the hourly cron", async () => {
    mockFetch(() => sqlAnswer([{ n: 0 }]));
    await worker.scheduled(controller(HEALTH_CRON), makeEnv());
    expect(await env.STATS.get(HEALTH_KEY)).not.toBeNull();
  });

  it("runs the weekly job on the Monday cron", async () => {
    mockFetch(() => sqlAnswer([]));
    await worker.scheduled(controller(WEEKLY_CRON), makeEnv());
    expect(await env.STATS.get(weekKey("2026-W45"))).not.toBeNull();
  });

  it("refuses an unknown cron", async () => {
    await expect(worker.scheduled(controller("0 0 * * *"), makeEnv())).rejects.toThrow("unknown_cron");
  });

  it("matches the crons in wrangler.jsonc", () => {
    // test/node/wrangler-config.test.mjs pins the same 2 values in the file.
    expect([HEALTH_CRON, WEEKLY_CRON]).toEqual(["17 * * * *", "23 3 * * 1"]);
  });
});

describe("GET /v1/stats and /v1/health", () => {
  const base = "https://report.frostyard.org";

  it("serves an empty index before the first job", async () => {
    const response = await call(new Request(`${base}/v1/stats`), makeEnv());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await response.json()).toEqual({ schema: "frostyard.problem-stats-index/1", weeks: [], latest: null });
  });

  it("serves the index with the latest week, and 1 week", async () => {
    mockFetch(() => sqlAnswer(ROWS));
    await runWeeklyJob(makeEnv(), MONDAY);
    const all = (await (await call(new Request(`${base}/v1/stats`), makeEnv())).json()) as Record<string, unknown>;
    expect(all.weeks).toEqual(["2026-W45"]);
    expect((all.latest as { week: string }).week).toBe("2026-W45");
    const one = await call(new Request(`${base}/v1/stats/2026-W45`), makeEnv());
    expect(one.status).toBe(200);
    expect(one.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(await one.json()).toEqual(all.latest);
    const head = await call(new Request(`${base}/v1/stats/2026-W45`, { method: "HEAD" }), makeEnv());
    expect(head.status).toBe(200);
  });

  it.each(["2026-W46", "2026-W54", "2026-w45", "..%2F..%2Fhealth%2Flatest.json", "2026-W45.json"])(
    "answers 404 for week %s",
    async (week) => {
      await env.STATS.put("aggregates/2026-W45.json", "{}");
      const response = await call(new Request(`${base}/v1/stats/${week}`), makeEnv());
      expect(response.status).toBe(404);
    },
  );

  it.each(["/v1/stats", "/v1/stats/2026-W45", "/v1/health"])("answers POST %s with 405", async (path) => {
    const response = await call(new Request(`${base}${path}`, { method: "POST" }), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves a fixed body before the first health run, then the document", async () => {
    const before = await call(new Request(`${base}/v1/health`), makeEnv());
    expect(await before.json()).toEqual({ schema: "frostyard.problem-intake-health/1", status: "no_data" });
    mockFetch(() => sqlAnswer([{ n: 1 }]));
    const doc = await runHealthJob(makeEnv(), MONDAY);
    const after = await call(new Request(`${base}/v1/health`), makeEnv());
    expect(after.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await after.json()).toEqual(doc);
  });
});

describe("countValue", () => {
  it.each([
    [0, 0],
    [7, 7],
    ["12", 12],
    ["0", 0],
    ["012", null],
    [-1, null],
    [Number.MAX_SAFE_INTEGER + 1, null],
    ["1e3", null],
    [true, null],
  ])("reads %j as %j", (value, expected) => {
    expect(countValue(value)).toBe(expected);
  });
});
