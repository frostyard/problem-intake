// Read a request body with a hard byte limit. A BYOB reader asks the stream
// for at most the remaining allowance + 1 byte at each read, so the Worker
// takes at most limit + 1 bytes from the stream, even when the sender writes
// larger chunks, and then cancels it. A large body is never buffered.

export const MAX_BODY_BYTES = 8192;

export type BodyResult = { ok: true; bytes: Uint8Array } | { ok: false };

export async function readLimitedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyResult> {
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader({ mode: "byob" });
  // Each read transfers the buffer; the next read continues in the buffer
  // that the last read gave back.
  let buffer = new ArrayBuffer(limit + 1);
  let total = 0;
  while (total <= limit) {
    const { done, value } = await reader.read(new Uint8Array(buffer, total, limit + 1 - total));
    if (value !== undefined) {
      buffer = value.buffer as ArrayBuffer;
      total += value.byteLength;
    }
    if (done) break;
  }
  if (total > limit) {
    // Best effort: a stream that is already errored can reject the cancel.
    await reader.cancel().catch(() => undefined);
    return { ok: false };
  }
  reader.releaseLock();
  return { ok: true, bytes: new Uint8Array(buffer, 0, total) };
}

// A declared length above the limit is refused before any read. A missing or
// malformed length is not trusted either way: the stream read decides.
export function declaredLengthTooLarge(contentLength: string | null, limit: number): boolean {
  if (contentLength === null) return false;
  if (!/^[0-9]{1,15}$/.test(contentLength.trim())) return false;
  return Number(contentLength.trim()) > limit;
}
