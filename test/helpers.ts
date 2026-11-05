// Shared test helpers. Every secret here is an obvious fake.
import { env } from "cloudflare:workers";
import { vi } from "vitest";
import worker from "../src/index.ts";
import type { Report } from "../src/types.ts";

import app_problem from "./fixtures/examples/app_problem.json";
import booted_older_image from "./fixtures/examples/booted_older_image.json";
import count from "./fixtures/examples/count.json";
import crash from "./fixtures/examples/crash.json";
import integrity_error from "./fixtures/examples/integrity_error.json";
import sysext_update_failed from "./fixtures/examples/sysext_update_failed.json";
import tpm_unlock from "./fixtures/examples/tpm_unlock.json";
import unit_failed from "./fixtures/examples/unit_failed.json";
import update_stage_failed from "./fixtures/examples/update_stage_failed.json";

// The core examples (frostyard/core docs/specs/schemas/problem-report/examples/
// at f1b62e0), 1 for each kind.
export const EXAMPLES: Record<string, Report> = {
  app_problem,
  booted_older_image,
  count,
  crash,
  integrity_error,
  sysext_update_failed,
  tpm_unlock,
  unit_failed,
  update_stage_failed,
} as unknown as Record<string, Report>;

export function example(kind: string): Report {
  return structuredClone(EXAMPLES[kind]);
}

export const TEST_BEARER = "test-bearer-not-a-real-secret";
export const SYSTEM_KEY = "0123456789abcdef0123456789abcdef";
export const APP_KEY = "fedcba9876543210fedcba9876543210";
export const SYSTEM_DSN = `https://${SYSTEM_KEY}@glitchtip.test.invalid/1`;
export const APP_DSN = `https://${APP_KEY}@glitchtip.test.invalid/7`;
export const SYSTEM_ENVELOPE_URL = "https://glitchtip.test.invalid/api/1/envelope/";
export const APP_ENVELOPE_URL = "https://glitchtip.test.invalid/api/7/envelope/";
export const TEST_ACCOUNT = "0123456789abcdef0123456789abcdef";
export const TEST_AE_TOKEN = "test-ae-token-not-real";

export class RecordingDataset implements AnalyticsEngineDataset {
  points: AnalyticsEngineDataPoint[] = [];
  writeDataPoint(point?: AnalyticsEngineDataPoint): void {
    if (point !== undefined) this.points.push(point);
  }
}

export class RecordingLimiter implements RateLimit {
  keys: string[] = [];
  private readonly allow: boolean;
  constructor(allow = true) {
    this.allow = allow;
  }
  async limit(options: RateLimitOptions): Promise<RateLimitOutcome> {
    this.keys.push(options.key);
    return { success: this.allow };
  }
}

export interface TestEnv extends Env {
  REPORTS: RecordingDataset;
  HEALTH: RecordingDataset;
}

export function makeEnv(overrides: Partial<Record<keyof Env, unknown>> = {}): TestEnv {
  return {
    ...env,
    KILL_SWITCH: "off",
    REPORT_LIMIT: new RecordingLimiter(),
    REPORTS: new RecordingDataset(),
    HEALTH: new RecordingDataset(),
    INTAKE_BEARER: TEST_BEARER,
    GLITCHTIP_DSNS: JSON.stringify({ system: SYSTEM_DSN, "org.frostyard.Frostmail": APP_DSN }),
    AE_READ_TOKEN: TEST_AE_TOKEN,
    CF_ACCOUNT_ID: TEST_ACCOUNT,
    ...overrides,
  } as TestEnv;
}

export const REPORT_URL = "https://report.frostyard.org/v1/report";

export function reportRequest(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(REPORT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

export async function call(request: Request, testEnv: Env): Promise<Response> {
  return worker.fetch(request as Parameters<typeof worker.fetch>[0], testEnv);
}

export interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

// Replace the global fetch. Each outgoing request is recorded; `answer`
// decides the response. No test reaches the network.
export function mockFetch(answer: (captured: Captured) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const calls: Captured[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const captured: Captured = {
      url: request.url,
      method: request.method,
      headers,
      body: new TextDecoder().decode(await request.arrayBuffer()),
    };
    calls.push(captured);
    return answer(captured);
  });
  return { calls, spy };
}

export function parseEnvelope(body: string): { header: unknown; item: { type: string; length: number }; event: Record<string, unknown>; payload: string } {
  const lines = body.split("\n");
  return {
    header: JSON.parse(lines[0]),
    item: JSON.parse(lines[1]),
    payload: lines[2],
    event: JSON.parse(lines[2]),
  };
}
