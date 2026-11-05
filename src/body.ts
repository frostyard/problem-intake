// Read a request body with a hard byte limit. The stream is read at most to
// limit + 1 bytes and then cancelled, so a large body is never buffered.

export const MAX_BODY_BYTES = 8192;

export type BodyResult = { ok: true; bytes: Uint8Array } | { ok: false };

export async function readLimitedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyResult> {
  if (body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

// A declared length above the limit is refused before any read. A missing or
// malformed length is not trusted either way: the stream read decides.
export function declaredLengthTooLarge(contentLength: string | null, limit: number): boolean {
  if (contentLength === null) return false;
  if (!/^[0-9]{1,15}$/.test(contentLength.trim())) return false;
  return Number(contentLength.trim()) > limit;
}
