// The read-only GlitchTip client of the triage job (docs/specs/triage.md,
// "Reader", "Failures", "Rules"): GET only, a redirect is never followed,
// every request counts against the load cap and the deadline, and every
// failure maps to 1 fixed reason code. A message never holds a URL, a query,
// a body, an event id or the token: the caller prints only the code.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { setTimeout as sleepDefault } from "node:timers/promises";

// An answer that ends the run: auth (exit 3), unreachable (exit 4), error
// (exit 5). `not_found` is a 404, which the reader maps by its own rule.
export class ReadError extends Error {
  constructor(code) {
    super(`glitchtip: ${code}`);
    this.name = "ReadError";
    this.code = code;
  }
}

// The load cap or the deadline stopped a request. The reader continues with
// what it read and marks the run partial.
export class CapError extends Error {
  constructor(reason) {
    super(`glitchtip: ${reason}`);
    this.name = "CapError";
    this.reason = reason;
  }
}

// A page cursor of the Link header. The reader builds the next URL itself from
// the configured base URL, so a cursor of an unexpected shape is refused.
const CURSOR = /^[A-Za-z0-9_=:.%+/-]{1,200}$/;

// `<url>; rel="next"; results="true"; cursor="<cursor>"`, and the same with
// results="false" and no cursor. The previous link is skipped.
const LINK = /<([^<>]*)>\s*;\s*rel="([a-z]+)"\s*;\s*results="(true|false)"(?:\s*;\s*cursor="([^"]*)")?/g;

// The next-page cursor of a Link header, or null when there is no next page.
// The URL of the header is never used: only its cursor value.
function nextCursor(header) {
  if (typeof header !== "string" || header === "") return null;
  for (const match of header.matchAll(LINK)) {
    if (match[2] !== "next") continue;
    if (match[3] !== "true") return null;
    const cursor = match[4];
    if (typeof cursor !== "string" || !CURSOR.test(cursor)) throw new ReadError("error");
    return cursor;
  }
  return null;
}

// Retry-After in seconds, an integer of at most 60. Missing or bad is 60.
function retryAfterSeconds(value) {
  if (typeof value !== "string" || !/^[0-9]{1,3}$/.test(value.trim())) return 60;
  const seconds = Number(value.trim());
  return seconds > 60 ? 60 : seconds;
}

function statusCode(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status >= 500) return "unreachable";
  return "error";
}

// 1 client for 1 run. `now` is the run's clock (milliseconds), `deadline` the
// run's deadline in milliseconds or null, `sleep` the pause function.
export function createClient({
  baseUrl,
  token,
  cap = 1000,
  pauseMs = 200,
  timeoutMs = 20000,
  deadline = null,
  now = Date.now,
  sleep = sleepDefault,
  fetchImpl = globalThis.fetch,
}) {
  let count = 0;

  async function send(url) {
    if (count >= cap) throw new CapError("cap");
    if (deadline !== null && now() >= deadline) throw new CapError("deadline");
    if (count > 0 && pauseMs > 0) await sleep(pauseMs);
    count += 1;
    try {
      return await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      // A network error or the request timeout: no code and no message of the
      // error reaches a diagnostic.
      throw new ReadError("unreachable");
    }
  }

  async function finish(response) {
    const code = statusCode(response.status);
    if (code === "unreachable") throw new ReadError("unreachable");
    if (code !== "ok") throw new ReadError(code);
    let text;
    try {
      text = await response.text();
    } catch {
      throw new ReadError("unreachable");
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ReadError("error");
    }
    // Both endpoints answer a list of rows; another shape is unexpected.
    if (!Array.isArray(body)) throw new ReadError("error");
    return { body, cursor: nextCursor(response.headers.get("link")) };
  }

  // 1 page. A 429 waits Retry-After seconds and tries 1 more time only.
  async function get(url) {
    let response = await send(url);
    if (response.status === 429) {
      await sleep(retryAfterSeconds(response.headers.get("retry-after")) * 1000);
      response = await send(url);
      if (response.status === 429) throw new ReadError("unreachable");
    }
    return finish(response);
  }

  return { get, requests: () => count, baseUrl };
}
