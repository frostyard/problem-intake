// The problem-intake Worker: routes and the scheduled entry point.
// Only /v1/* paths answer; every other path is 404 (docs/specs/intake-api.md).
import { errorResponse, jsonResponse, methodNotAllowed, notFound } from "./http.ts";
import { HEALTH_KEY, HEALTH_SCHEMA, readIndex, runScheduled, weekKey } from "./jobs.ts";
import { handleReport } from "./report.ts";
import { WEEK_PATTERN } from "./week.ts";

const CACHE_HOUR = { "Cache-Control": "public, max-age=3600" };
const STATS_WEEK = /^\/v1\/stats\/([^/]+)$/;

async function storedJson(env: Env, key: string): Promise<unknown> {
  return env.STATS.get(key, "json");
}

async function handleStats(env: Env): Promise<Response> {
  const index = await readIndex(env);
  const latestWeek = index.weeks.at(-1);
  const latest = latestWeek === undefined ? null : await storedJson(env, weekKey(latestWeek));
  return jsonResponse(200, { ...index, latest }, CACHE_HOUR);
}

async function handleStatsWeek(env: Env, week: string): Promise<Response> {
  if (!WEEK_PATTERN.test(week)) return notFound();
  const document = await storedJson(env, weekKey(week));
  if (document === null) return notFound();
  return jsonResponse(200, document, CACHE_HOUR);
}

async function handleHealth(env: Env): Promise<Response> {
  const document = await storedJson(env, HEALTH_KEY);
  return jsonResponse(200, document ?? { schema: HEALTH_SCHEMA, status: "no_data" }, {
    "Cache-Control": "public, max-age=300",
  });
}

function isRead(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/report") {
    return request.method === "POST" ? handleReport(request, env) : methodNotAllowed("POST");
  }
  if (pathname === "/v1/stats") {
    return isRead(request.method) ? handleStats(env) : methodNotAllowed("GET, HEAD");
  }
  if (pathname === "/v1/health") {
    return isRead(request.method) ? handleHealth(env) : methodNotAllowed("GET, HEAD");
  }
  const week = STATS_WEEK.exec(pathname);
  if (week !== null) {
    return isRead(request.method) ? handleStatsWeek(env, week[1]) : methodNotAllowed("GET, HEAD");
  }
  return notFound();
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch {
      return errorResponse(500, "internal");
    }
  },
  async scheduled(controller, env): Promise<void> {
    await runScheduled(controller.cron, env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
