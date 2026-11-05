# Spec: The intake HTTP API

This contract governs the HTTP interface of the problem-intake Worker at
`https://report.frostyard.org`. Consumers: the senders (chairlift, Floe's
`snosi-health`), frostyard.org's stats page (`GET /v1/stats`), and Moneo's
monitoring (`GET /v1/health`).

## Interface

| Method and path | Answer |
| --- | --- |
| `POST /v1/report` | 202 `{"status":"accepted"}`, or an error below |
| `GET` or `HEAD /v1/stats` | 200, the index and the latest week ([stats.md](stats.md)) |
| `GET` or `HEAD /v1/stats/<week>` | 200, 1 week; 404 when the week is not stored or does not match `^20[2-9][0-9]-W(0[1-9]\|[1-4][0-9]\|5[0-3])$` |
| `GET` or `HEAD /v1/health` | 200, the health document, or `{"schema":"frostyard.problem-intake-health/1","status":"no_data"}` |
| Another method on these paths | 405 `{"error":"method_not_allowed"}` with `Allow` |
| Any other path | 404 `{"error":"not_found"}` |

Errors of `POST /v1/report`, in the order the Worker checks them:

| Check | Status | Body |
| --- | --- | --- |
| `KILL_SWITCH` is not `off` | 503, `Retry-After: 86400` | `{"error":"unavailable"}` |
| Over 10 requests in 60 seconds for the key | 429 | `{"error":"rate_limited"}` |
| Media type is not `application/json` (parameters allowed) | 415 | `{"error":"unsupported_media_type"}` |
| `Content-Length` over 8192, or a body over 8192 bytes | 413 | `{"error":"too_large"}` |
| Not UTF-8, not JSON, or not valid `frostyard.problem/1` | 400 | `{"error":"invalid"}` |
| GlitchTip answers non-2xx, times out (10 s), cannot be reached, or a Worker secret is missing or malformed | 502 | `{"error":"upstream"}` |
| An unexpected error | 500 | `{"error":"internal"}` |

Every JSON answer has `Content-Type: application/json; charset=utf-8`.
Error answers have `Cache-Control: no-store`; stats answers have
`Cache-Control: public, max-age=3600`; the health answer has
`public, max-age=300`.

The health document:

```json
{
  "schema": "frostyard.problem-intake-health/1",
  "checked_at": "2026-11-09T03:17:00.000Z",
  "forward_failures": { "last_hour": 0, "last_day": 2 }
}
```

## Rules

- An error body never holds any part of the request.
- The rate-limit key is the value of `CF-Connecting-IP`; a request without
  it uses the fixed key `local`. The Worker reads no other request header
  than `Content-Type`, `Content-Length` and `CF-Connecting-IP`, and never
  `request.cf`.
- The Worker reads the body as a stream with a BYOB reader that asks for at
  most the remaining allowance + 1 byte, so it takes at most 8193 bytes from
  the stream whatever the chunk sizes are, and then cancels it; a
  declared `Content-Length` over 8192 is refused before the read; a smaller
  declared length is not trusted.
- A document is valid only when the validator compiled from
  [schema/v1.json](../../schema/v1.json) accepts it (core spec rules 1 to 9).
- A report of kind `count` is never forwarded.
- A 2xx answer from GlitchTip is the only success of a forward. A redirect is
  a failure.
- The forwarded request carries exactly `Authorization: Bearer <INTAKE_BEARER>`,
  `Content-Type: application/x-sentry-envelope` and
  `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<DSN public key>, sentry_client=frostyard-problem-intake/<version>`.
- The forwarded envelope holds 1 event: `event_id` = `report_id` without
  dashes, tags `report_id`, `week`, `image`, `image_version`, `secure`,
  `kind`, `client`, `client_name` and each scalar `detail` field (`version`
  becomes `feature_version`, `count` becomes `count_bucket`),
  `extra.detail`, `user.ip_address` null, and no `server_name`, `request`,
  `contexts` or `timestamp`.
- 503 means only the kill switch.

## References

- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md)
- Context: [design/intake.md](../design/intake.md)
- Schema: frostyard/core
  [problem-report.md](https://github.com/frostyard/core/blob/main/docs/specs/problem-report.md)
- Tests: `test/report.test.ts`, `test/units.test.ts`, `test/jobs.test.ts`
