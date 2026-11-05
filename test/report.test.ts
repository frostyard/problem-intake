import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportPoint } from "../src/analytics.ts";
import { MAX_BODY_BYTES } from "../src/body.ts";
import { LOCAL_RATE_KEY } from "../src/report.ts";
import {
  APP_ENVELOPE_URL,
  APP_KEY,
  call,
  EXAMPLES,
  example,
  makeEnv,
  mockFetch,
  parseEnvelope,
  RecordingLimiter,
  REPORT_URL,
  reportRequest,
  SYSTEM_ENVELOPE_URL,
  SYSTEM_KEY,
  TEST_BEARER,
} from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const CLIENT_IP = "203.0.113.77";
const CLIENT_IP6 = "2001:db8::4242";

async function expectError(response: Response, status: number, error: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
}

describe("POST /v1/report: accepted reports", () => {
  it.each(Object.keys(EXAMPLES))("accepts the core example %s", async (kind) => {
    const { calls } = mockFetch();
    const testEnv = makeEnv();
    const response = await call(reportRequest(JSON.stringify(example(kind))), testEnv);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted" });
    // count is never forwarded; every other kind is forwarded once.
    expect(calls).toHaveLength(kind === "count" ? 0 : 1);
    expect(testEnv.REPORTS.points).toHaveLength(1);
    expect(testEnv.HEALTH.points).toHaveLength(0);
  });

  it("accepts application/json with parameters and any case", async () => {
    mockFetch();
    for (const type of ["application/json; charset=utf-8", "Application/JSON", "application/json;charset=UTF-8"]) {
      const response = await call(reportRequest(JSON.stringify(example("count")), { "Content-Type": type }), makeEnv());
      expect(response.status).toBe(202);
    }
  });
});

describe("POST /v1/report: the forwarded request", () => {
  function sendWithClientHeaders(kind: string) {
    const { calls } = mockFetch();
    const testEnv = makeEnv();
    const request = reportRequest(JSON.stringify(example(kind)), {
      "CF-Connecting-IP": CLIENT_IP,
      "X-Forwarded-For": `${CLIENT_IP}, ${CLIENT_IP6}`,
      "True-Client-IP": CLIENT_IP,
      "X-Real-IP": CLIENT_IP,
      Forwarded: `for=${CLIENT_IP}`,
      "User-Agent": "test-agent/1.0 marker-ua",
      Cookie: "session=marker-cookie",
    });
    return { calls, testEnv, request };
  }

  it("has the bearer, the envelope type and the Sentry auth header, and nothing else", async () => {
    const { calls, testEnv, request } = sendWithClientHeaders("unit_failed");
    expect((await call(request, testEnv)).status).toBe(202);
    expect(calls).toHaveLength(1);
    const [sent] = calls;
    expect(sent.url).toBe(SYSTEM_ENVELOPE_URL);
    expect(sent.method).toBe("POST");
    expect(sent.headers.authorization).toBe(`Bearer ${TEST_BEARER}`);
    expect(sent.headers["content-type"]).toBe("application/x-sentry-envelope");
    expect(sent.headers["x-sentry-auth"]).toBe(
      `Sentry sentry_version=7, sentry_key=${SYSTEM_KEY}, sentry_client=frostyard-problem-intake/0.1.0`,
    );
    expect(Object.keys(sent.headers).sort()).toEqual(["authorization", "content-type", "x-sentry-auth"]);
    for (const name of ["cf-connecting-ip", "x-forwarded-for", "true-client-ip", "x-real-ip", "forwarded", "user-agent", "cookie"]) {
      expect(sent.headers[name]).toBeUndefined();
    }
  });

  it.each(Object.keys(EXAMPLES).filter((kind) => kind !== "count"))(
    "never carries the client address or a client header value (%s)",
    async (kind) => {
      const { calls, testEnv, request } = sendWithClientHeaders(kind);
      expect((await call(request, testEnv)).status).toBe(202);
      const sent = JSON.stringify(calls[0]);
      for (const marker of [CLIENT_IP, CLIENT_IP6, "marker-ua", "marker-cookie"]) {
        expect(sent).not.toContain(marker);
      }
      for (const point of [...testEnv.REPORTS.points, ...testEnv.HEALTH.points]) {
        expect(JSON.stringify(point)).not.toContain(CLIENT_IP);
      }
    },
  );

  it("sends an envelope with the report_id tag, event_id, a null IP and no server_name", async () => {
    const { calls } = mockFetch();
    const report = example("unit_failed");
    await call(reportRequest(JSON.stringify(report)), makeEnv());
    const { header, item, event, payload } = parseEnvelope(calls[0].body);
    const eventId = report.report_id.replaceAll("-", "");
    expect(header).toEqual({ event_id: eventId });
    expect(item.type).toBe("event");
    expect(item.length).toBe(new TextEncoder().encode(payload).byteLength);
    expect(event.event_id).toBe(eventId);
    expect((event.tags as Record<string, string>).report_id).toBe(report.report_id);
    expect(event.user).toEqual({ ip_address: null });
    expect(event).not.toHaveProperty("server_name");
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("contexts");
    expect(event).not.toHaveProperty("timestamp");
    expect(event.level).toBe("error");
    expect(event.platform).toBe("other");
    expect(event.extra).toEqual({ detail: report.detail });
  });

  it("routes an app problem to the app's project when it has one", async () => {
    const { calls } = mockFetch();
    const report = example("app_problem");
    report.detail.app_id = "org.frostyard.Frostmail";
    await call(reportRequest(JSON.stringify(report)), makeEnv());
    expect(calls[0].url).toBe(APP_ENVELOPE_URL);
    expect(calls[0].headers["x-sentry-auth"]).toContain(`sentry_key=${APP_KEY}`);
  });

  it("routes an app without a project of its own to system", async () => {
    const { calls } = mockFetch();
    await call(reportRequest(JSON.stringify(example("app_problem"))), makeEnv());
    expect(calls[0].url).toBe(SYSTEM_ENVELOPE_URL);
  });
});

describe("POST /v1/report: schema rejects", () => {
  type Mutation = [string, (doc: Record<string, any>) => unknown];
  const cases: Mutation[] = [
    ["an unknown top-level field", (d) => ({ ...d, extra: 1 })],
    ["an unknown image field", (d) => ({ ...d, image: { ...d.image, arch: "x86_64" } })],
    ["an unknown detail field", (d) => ({ ...d, detail: { ...d.detail, note: "x" } })],
    ["a detail field of another kind", (d) => ({ ...d, detail: { ...d.detail, error_class: "network" } })],
    ["a missing field", (d) => ({ ...d, report_id: undefined })],
    ["an app_id off the allowlist", (d) => ({ ...example("app_problem"), detail: { ...example("app_problem").detail, app_id: "org.frostyard.Unknown" } })],
    ["a bad image version", (d) => ({ ...d, image: { ...d.image, version: "2026103109382" } })],
    ["a bad semver in the client", (d) => ({ ...d, client: "chairlift/v0.14.0" })],
    ["a trailing newline in the image version", (d) => ({ ...d, image: { ...d.image, version: "20261031093822\n" } })],
    ["a trailing newline in the report_id", (d) => ({ ...d, report_id: `${d.report_id}\n` })],
    ["an upper-case report_id", (d) => ({ ...d, report_id: d.report_id.toUpperCase() })],
    ["an unknown kind", (d) => ({ ...d, kind: "other" })],
    ["another schema version", (d) => ({ ...d, schema: "frostyard.problem/2" })],
    ["a JSON array", (d) => [d]],
    ["a JSON string", () => "frostyard.problem/1"],
    ["null", () => null],
    ["a shipped=false unit", (d) => ({ ...d, detail: { ...d.detail, shipped: false } })],
  ];

  it.each(cases)("rejects %s with 400 and no forward", async (_name, mutate) => {
    const { calls } = mockFetch();
    const testEnv = makeEnv();
    const marker = "echo-marker-7f3a";
    const doc = mutate(example("unit_failed"));
    const texts = [JSON.stringify(doc)];
    // For an object, also send it with 1 more unknown field that holds a
    // marker: the answer must never echo it.
    if (doc !== null && typeof doc === "object" && !Array.isArray(doc)) texts.push(JSON.stringify({ ...doc, [marker]: marker }));
    for (const text of texts) {
      const response = await call(reportRequest(text), testEnv);
      const answer = await response.text();
      expect(response.status).toBe(400);
      expect(JSON.parse(answer)).toEqual({ error: "invalid" });
      expect(answer).not.toContain(marker);
    }
    expect(calls).toHaveLength(0);
    expect(testEnv.REPORTS.points).toHaveLength(0);
  });

  it("rejects a Go panic frame outside the allowed modules", async () => {
    const report = example("app_problem");
    (report.detail.frames as string[])[0] = "github.com/someone/else.Func";
    await expectError(await call(reportRequest(JSON.stringify(report)), makeEnv()), 400, "invalid");
  });

  it.each([
    ["broken JSON", "{"],
    ["an empty body", ""],
    ["JSON with trailing text", `${JSON.stringify(example("count"))}x`],
  ])("rejects %s with 400", async (_name, text) => {
    await expectError(await call(reportRequest(text), makeEnv()), 400, "invalid");
  });

  it("rejects a body that is not UTF-8", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    await expectError(await call(reportRequest(bytes), makeEnv()), 400, "invalid");
  });
});

describe("POST /v1/report: size limit", () => {
  // The largest S8 document: 32 frames of 160 characters (spec rule 9).
  function largestReport(): string {
    const report = example("app_problem");
    const frame = `github.com/frostyard/nsl/internal/resolver.${"F".repeat(160 - "github.com/frostyard/nsl/internal/resolver.".length)}`;
    expect(frame).toHaveLength(160);
    report.detail.frames = Array.from({ length: 32 }, () => frame);
    return JSON.stringify(report);
  }

  it("accepts a valid document padded to exactly 8192 bytes", async () => {
    mockFetch();
    const text = largestReport();
    expect(text.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const padded = text + " ".repeat(MAX_BODY_BYTES - text.length);
    expect(new TextEncoder().encode(padded).byteLength).toBe(8192);
    expect((await call(reportRequest(padded), makeEnv())).status).toBe(202);
  });

  it("refuses 8193 bytes with 413", async () => {
    const { calls } = mockFetch();
    const text = largestReport();
    const padded = text + " ".repeat(MAX_BODY_BYTES + 1 - text.length);
    expect(new TextEncoder().encode(padded).byteLength).toBe(8193);
    await expectError(await call(reportRequest(padded), makeEnv()), 413, "too_large");
    expect(calls).toHaveLength(0);
  });

  it("refuses a declared Content-Length over the limit before reading", async () => {
    const request = new Request(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "8193" },
      body: "{}",
    });
    await expectError(await call(request, makeEnv()), 413, "too_large");
  });

  it("refuses a streamed body over the limit that declares no length", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 100) controller.close();
        else controller.enqueue(new Uint8Array(1024).fill(0x20));
      },
    });
    const request = new Request(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    await expectError(await call(request, makeEnv()), 413, "too_large");
    // The reader stops right after the limit: 9 chunks of 1 KiB, not 100.
    expect(pulled).toBeLessThan(12);
  });

  it("does not trust a small declared length", async () => {
    const text = " ".repeat(9000);
    const request = new Request(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
      body: text,
    });
    expect(request.headers.get("content-length")).toBe("2");
    // The stream read decides, not the declared length.
    await expectError(await call(request, makeEnv()), 413, "too_large");
  });
});

describe("POST /v1/report: content type, method, path", () => {
  it.each([["text/plain"], ["application/jsonx"], ["application/x-www-form-urlencoded"], [""]])(
    "refuses content type %j with 415",
    async (type) => {
      const request = new Request(REPORT_URL, {
        method: "POST",
        headers: type === "" ? {} : { "Content-Type": type },
        body: JSON.stringify(example("count")),
      });
      if (type === "") request.headers.delete("content-type");
      await expectError(await call(request, makeEnv()), 415, "unsupported_media_type");
    },
  );

  it.each(["GET", "PUT", "DELETE", "PATCH"])("answers %s with 405", async (method) => {
    const response = await call(new Request(REPORT_URL, { method }), makeEnv());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({ error: "method_not_allowed" });
  });

  it.each(["/", "/v1", "/v1/reports", "/v1/report/", "/v2/report", "/api/1/envelope/"])("answers %s with 404", async (path) => {
    const response = await call(new Request(`https://report.frostyard.org${path}`, { method: "POST" }), makeEnv());
    await expectError(response, 404, "not_found");
  });
});

describe("POST /v1/report: rate limit", () => {
  it("uses the client address as the key, and a fixed key without one", async () => {
    const limiter = new RecordingLimiter();
    await call(reportRequest(JSON.stringify(example("count")), { "CF-Connecting-IP": CLIENT_IP }), makeEnv({ REPORT_LIMIT: limiter }));
    await call(reportRequest(JSON.stringify(example("count"))), makeEnv({ REPORT_LIMIT: limiter }));
    expect(limiter.keys).toEqual([CLIENT_IP, LOCAL_RATE_KEY]);
  });

  it("answers 429 after 10 requests in 60 seconds from 1 key (real binding)", async () => {
    const key = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const testEnv = makeEnv({ REPORT_LIMIT: env.REPORT_LIMIT });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const response = await call(reportRequest(JSON.stringify(example("count")), { "CF-Connecting-IP": key }), testEnv);
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(202));
    expect(statuses[10]).toBe(429);
    const other = await call(reportRequest(JSON.stringify(example("count")), { "CF-Connecting-IP": "192.0.2.9" }), testEnv);
    expect(other.status).toBe(202);
  });

  it("checks the rate limit before the content type", async () => {
    const request = new Request(REPORT_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" });
    await expectError(await call(request, makeEnv({ REPORT_LIMIT: new RecordingLimiter(false) })), 429, "rate_limited");
  });
});

describe("POST /v1/report: kill switch", () => {
  it.each(["on", "ON", "maybe", "", undefined])("answers 503 for KILL_SWITCH=%j before anything else", async (value) => {
    const limiter = new RecordingLimiter();
    const { calls } = mockFetch();
    const response = await call(reportRequest("not json"), makeEnv({ KILL_SWITCH: value, REPORT_LIMIT: limiter }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("86400");
    expect(await response.json()).toEqual({ error: "unavailable" });
    expect(limiter.keys).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /v1/report: forward failures", () => {
  async function failWith(testEnv = makeEnv()) {
    const response = await call(reportRequest(JSON.stringify(example("crash"))), testEnv);
    await expectError(response, 502, "upstream");
    expect(testEnv.REPORTS.points).toHaveLength(0);
    expect(testEnv.HEALTH.points).toHaveLength(1);
    return testEnv.HEALTH.points[0];
  }

  it.each([
    [500, "5xx"],
    [503, "5xx"],
    [404, "4xx"],
    [401, "4xx"],
    [302, "3xx"],
  ])("counts an answer %i as a failure of class %s", async (status, failure) => {
    mockFetch(() => new Response("upstream body", { status, headers: status === 302 ? { Location: "https://elsewhere.invalid/" } : {} }));
    const point = await failWith();
    expect(point).toEqual({ indexes: ["forward_failed"], blobs: ["forward_failed", failure], doubles: [1] });
  });

  it("counts a network error", async () => {
    mockFetch(() => {
      throw new TypeError("network down");
    });
    expect((await failWith()).blobs).toEqual(["forward_failed", "network"]);
  });

  it("counts a timeout", async () => {
    mockFetch(() => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    });
    expect((await failWith()).blobs).toEqual(["forward_failed", "timeout"]);
  });

  it.each([
    ["no bearer", { INTAKE_BEARER: undefined }],
    ["a short bearer", { INTAKE_BEARER: "short" }],
    ["no DSN map", { GLITCHTIP_DSNS: undefined }],
    ["a DSN map that is not JSON", { GLITCHTIP_DSNS: "{" }],
    ["a DSN map that is an array", { GLITCHTIP_DSNS: "[]" }],
    ["a DSN map without system", { GLITCHTIP_DSNS: JSON.stringify({ "org.frostyard.nsl": "https://0123456789abcdef0123456789abcdef@g.test.invalid/1" }) }],
    ["an http DSN", { GLITCHTIP_DSNS: JSON.stringify({ system: "http://0123456789abcdef0123456789abcdef@g.test.invalid/1" }) }],
    ["a DSN with a secret part", { GLITCHTIP_DSNS: JSON.stringify({ system: "https://0123456789abcdef0123456789abcdef:pw@g.test.invalid/1" }) }],
    ["a DSN with a path prefix", { GLITCHTIP_DSNS: JSON.stringify({ system: "https://0123456789abcdef0123456789abcdef@g.test.invalid/x/1" }) }],
    ["a DSN with a query", { GLITCHTIP_DSNS: JSON.stringify({ system: "https://0123456789abcdef0123456789abcdef@g.test.invalid/1?a=b" }) }],
    ["a DSN with a bad key", { GLITCHTIP_DSNS: JSON.stringify({ system: "https://not-a-key@g.test.invalid/1" }) }],
    ["a DSN that is not a URL", { GLITCHTIP_DSNS: JSON.stringify({ system: "not a url" }) }],
    ["a DSN that is not a string", { GLITCHTIP_DSNS: JSON.stringify({ system: 1 }) }],
    ["a bad project name", { GLITCHTIP_DSNS: JSON.stringify({ system: "https://0123456789abcdef0123456789abcdef@g.test.invalid/1", "../x": "https://0123456789abcdef0123456789abcdef@g.test.invalid/2" }) }],
  ])("counts %s as a config failure (502, not 503)", async (_name, overrides) => {
    const { calls } = mockFetch();
    expect((await failWith(makeEnv(overrides))).blobs).toEqual(["forward_failed", "config"]);
    expect(calls).toHaveLength(0);
  });
});

describe("POST /v1/report: Analytics Engine points", () => {
  it("writes only schema values: no report_id, no IP", async () => {
    mockFetch();
    const testEnv = makeEnv();
    for (const kind of Object.keys(EXAMPLES)) {
      await call(reportRequest(JSON.stringify(example(kind)), { "CF-Connecting-IP": CLIENT_IP }), testEnv);
    }
    expect(testEnv.REPORTS.points).toHaveLength(Object.keys(EXAMPLES).length);
    for (const [i, kind] of Object.keys(EXAMPLES).entries()) {
      const text = JSON.stringify(testEnv.REPORTS.points[i]);
      expect(text).not.toContain(EXAMPLES[kind].report_id);
      expect(text).not.toContain(CLIENT_IP);
      expect(text).not.toContain(EXAMPLES[kind].week);
    }
  });

  it("has the documented blob order", () => {
    expect(reportPoint(example("app_problem"))).toEqual({
      indexes: ["app_problem"],
      blobs: ["app_problem", "snow", "20261031093822", "true", "chairlift", "panic", "org.frostyard.nsl", "0.9.2", "", ""],
      doubles: [1],
    });
    expect(reportPoint(example("count"))).toEqual({
      indexes: ["count"],
      blobs: ["count", "floe", "20261031093822", "false", "snosi-health", "", "", "", "<6m", "latest"],
      doubles: [1],
    });
  });
});

describe("unexpected errors", () => {
  it("answers 500 with a fixed body", async () => {
    const testEnv = makeEnv({
      STATS: {
        get: async () => {
          throw new Error("kv down");
        },
      },
    });
    const response = await call(new Request("https://report.frostyard.org/v1/stats"), testEnv);
    await expectError(response, 500, "internal");
  });
});
