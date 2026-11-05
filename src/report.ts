// POST /v1/report (docs/specs/intake-api.md). The order of the checks is fixed:
// kill switch, rate limit, content type, size, JSON parse, schema.
//
// Privacy: this handler reads only 3 request headers: the content type, the
// content length, and the client address for the rate-limit key. The address
// is used for nothing else: it is not stored, logged or forwarded.
import { healthPoint, reportPoint } from "./analytics.ts";
import { declaredLengthTooLarge, MAX_BODY_BYTES, readLimitedBody } from "./body.ts";
import { forwardReport } from "./forward.ts";
import validate from "./generated/validate-v1.js";
import { errorResponse, jsonResponse } from "./http.ts";
import type { Report } from "./types.ts";

// The key for requests that carry no client address (local tests only).
export const LOCAL_RATE_KEY = "local";

// Only "off" lets reports through. "on" and any other value refuse them.
export function killSwitchOn(value: unknown): boolean {
  return value !== "off";
}

function rateLimitKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? LOCAL_RATE_KEY;
}

export function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json";
}

export async function handleReport(request: Request, env: Env): Promise<Response> {
  if (killSwitchOn(env.KILL_SWITCH)) {
    return errorResponse(503, "unavailable", { "Retry-After": "86400" });
  }

  const { success } = await env.REPORT_LIMIT.limit({ key: rateLimitKey(request) });
  if (!success) return errorResponse(429, "rate_limited");

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return errorResponse(415, "unsupported_media_type");
  }

  if (declaredLengthTooLarge(request.headers.get("content-length"), MAX_BODY_BYTES)) {
    return errorResponse(413, "too_large");
  }
  const body = await readLimitedBody(request.body, MAX_BODY_BYTES);
  if (!body.ok) return errorResponse(413, "too_large");

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.bytes));
  } catch {
    return errorResponse(400, "invalid");
  }
  if (!validate(document)) return errorResponse(400, "invalid");
  const report = document as Report;

  if (report.kind !== "count") {
    const result = await forwardReport(report, env);
    if (!result.ok) {
      env.HEALTH.writeDataPoint(healthPoint(result.failure));
      return errorResponse(502, "upstream");
    }
  }
  env.REPORTS.writeDataPoint(reportPoint(report));
  return jsonResponse(202, { status: "accepted" });
}
