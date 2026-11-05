// Forward 1 validated report to GlitchTip. This file holds the bearer and DSN
// handling: it is a risk path (.github/risk-paths.json).
//
// The outgoing request is built new. It never copies an incoming header or
// the incoming request. It carries exactly 3 headers: the bearer for caddy,
// the envelope content type, and the Sentry auth header with the DSN public key.
import type { FailureClass } from "./analytics.ts";
import { statusClass } from "./analytics.ts";
import { buildEnvelope, SENTRY_CLIENT } from "./envelope.ts";
import type { Report } from "./types.ts";

export const FORWARD_TIMEOUT_MS = 10_000;

export interface Target {
  url: string;
  key: string;
}

const PROJECT_KEY = /^(system|org\.frostyard\.[A-Za-z0-9]{1,64})$/;
const PUBLIC_KEY = /^[0-9a-f]{32}$/;
const PROJECT_PATH = /^\/([0-9]{1,10})$/;

// A DSN is https://<public key>@<host>/<project id>, with nothing else.
export function parseDsn(dsn: unknown): Target | null {
  if (typeof dsn !== "string") return null;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!PUBLIC_KEY.test(url.username) || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;
  const project = PROJECT_PATH.exec(url.pathname);
  if (project === null) return null;
  return { url: `https://${url.host}/api/${project[1]}/envelope/`, key: url.username };
}

// GLITCHTIP_DSNS is a JSON object: {"system": "<dsn>", "<app id>": "<dsn>"}.
// Every entry must be valid and "system" must exist, else the whole map is
// refused (a forward failure, class "config").
export function parseDsnMap(raw: unknown): Map<string, Target> | null {
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const map = new Map<string, Target>();
  for (const [name, dsn] of Object.entries(value)) {
    if (!PROJECT_KEY.test(name)) return null;
    const target = parseDsn(dsn);
    if (target === null) return null;
    map.set(name, target);
  }
  return map.has("system") ? map : null;
}

// App problems go to the app's project when it has one; all else to "system".
export function targetFor(report: Report, map: Map<string, Target>): Target {
  const appId = report.kind === "app_problem" ? report.detail.app_id : undefined;
  if (typeof appId === "string") {
    const target = map.get(appId);
    if (target !== undefined) return target;
  }
  return map.get("system") as Target;
}

export type ForwardResult = { ok: true } | { ok: false; failure: FailureClass };

export interface ForwardSecrets {
  INTAKE_BEARER?: string;
  GLITCHTIP_DSNS?: string;
}

export async function forwardReport(report: Report, secrets: ForwardSecrets): Promise<ForwardResult> {
  const bearer = secrets.INTAKE_BEARER;
  if (typeof bearer !== "string" || !/^[\x21-\x7e]{16,512}$/.test(bearer)) {
    return { ok: false, failure: "config" };
  }
  const map = parseDsnMap(secrets.GLITCHTIP_DSNS);
  if (map === null) return { ok: false, failure: "config" };
  const target = targetFor(report, map);

  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=${SENTRY_CLIENT}`,
      },
      body: buildEnvelope(report),
      redirect: "manual",
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, failure: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
  // Release the body; its content is not used. Best effort: an errored body
  // rejects the cancel, and that must not change the result of the forward.
  await response.body?.cancel().catch(() => undefined);
  if (response.status >= 200 && response.status < 300) return { ok: true };
  return { ok: false, failure: statusClass(response.status) };
}
