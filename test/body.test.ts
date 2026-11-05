// The byte limit of the request body (docs/specs/intake-api.md): the Worker
// takes at most 8193 bytes from the stream, whatever the chunk sizes are.
import { describe, expect, it } from "vitest";
import { MAX_BODY_BYTES, readLimitedBody } from "../src/body.ts";
import { call, countingStream, makeEnv, REPORT_URL } from "./helpers.ts";

describe("readLimitedBody", () => {
  it.each([
    ["1 chunk of 8192 and 1 of 1024", [8192, 1024]],
    ["1 chunk of 65536", [65536]],
    ["1 chunk of 8000 and 1 of 4000", [8000, 4000]],
    ["chunks of 3000", [3000, 3000, 3000, 3000]],
  ])("takes at most 8193 bytes from %s", async (_name, chunks) => {
    const { stream, taken } = countingStream(chunks);
    expect(await readLimitedBody(stream, MAX_BODY_BYTES)).toEqual({ ok: false });
    expect(taken()).toBeLessThanOrEqual(MAX_BODY_BYTES + 1);
  });

  it("reads a body of exactly the limit in odd chunks", async () => {
    const { stream, taken } = countingStream([5000, 3000, 192]);
    const result = await readLimitedBody(stream, MAX_BODY_BYTES);
    expect(result.ok).toBe(true);
    expect(result.ok && result.bytes.byteLength).toBe(8192);
    expect(taken()).toBe(8192);
  });

  it("reads small chunks and an empty body", async () => {
    const { stream } = countingStream([2, 1]);
    expect(await readLimitedBody(stream, 3)).toEqual({ ok: true, bytes: new Uint8Array([0x20, 0x20, 0x20]) });
    expect(await readLimitedBody(countingStream([]).stream, 3)).toEqual({ ok: true, bytes: new Uint8Array(0) });
    expect(await readLimitedBody(null, 3)).toEqual({ ok: true, bytes: new Uint8Array(0) });
  });

  it("refuses a request whose body stream has an oversized chunk across the limit", async () => {
    const { stream, taken } = countingStream([8192, 1024]);
    const request = new Request(REPORT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await call(request, makeEnv());
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "too_large" });
    expect(taken()).toBeLessThanOrEqual(MAX_BODY_BYTES + 1);
  });
});
