// Small fixed responses. An error body never holds any part of the request.

const JSON_TYPE = "application/json; charset=utf-8";

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", ...headers },
  });
}

export function errorResponse(status: number, error: string, headers: Record<string, string> = {}): Response {
  return jsonResponse(status, { error }, headers);
}

export const notFound = (): Response => errorResponse(404, "not_found");

export function methodNotAllowed(allow: string): Response {
  return errorResponse(405, "method_not_allowed", { Allow: allow });
}
