# 0003 — The intake Worker validates, strips and forwards problem reports

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

frostyard images and apps send opt-in problem reports, schema
`frostyard.problem/1` (frostyard/core
[ADR-0069](https://github.com/frostyard/core/blob/main/docs/adr/0069-report-problems-local-first-opt-in-with-one-sender-per-host.md),
[spec](https://github.com/frostyard/core/blob/main/docs/specs/problem-report.md)).
Plan T857 section 5 puts a Cloudflare Worker in front of a self-hosted
GlitchTip on Brian's homelab. An IP address is personal data. GlitchTip
retention is 72 days (80 days until 2026-11-05: weekly tag partitions and the
issue cleanup add up to 9 days, and snapshots 7 more). Workers forbid `eval` and `new Function`. A Workers
rate-limit binding counts only over 10 or 60 seconds.

## Decision

- The Worker answers only `report.frostyard.org/v1/*`. It has no
  `workers.dev` or preview URL. Observability, logs, traces and Logpush are
  off, and the source has no `console` call.
- `POST /v1/report` checks, in this order: the kill switch (`KILL_SWITCH`,
  503), the rate limit (10 requests in 60 seconds for each `CF-Connecting-IP`,
  429), the content type (`application/json`, 415), the size (8192 bytes,
  413), the JSON parse and the schema (400). Error bodies are fixed and never
  echo the request.
- Validation is a standalone Ajv module compiled at build time from
  `schema/v1.json`, a byte copy of core's `v1.json` pinned by its sha256.
- The Worker reads only 3 request headers: `Content-Type`, `Content-Length`
  and `CF-Connecting-IP`. It uses the address only as the rate-limit key. It
  never reads `request.cf`, stores, logs or forwards the address.
- The Worker forwards each report except `count` as 1 Sentry envelope to
  GlitchTip through caddy, in a request it builds new, with
  `Authorization: Bearer <INTAKE_BEARER>` for caddy and the DSN public key in
  `X-Sentry-Auth`. The event has `event_id` = the `report_id` without dashes,
  a `report_id` tag, `user.ip_address` null and no `server_name`. A forward
  failure answers 502, so that the sender tries again the next day.
- `count` reports never go to GlitchTip. Every accepted report and count
  writes 1 Analytics Engine data point of schema values, with no `report_id`
  and no IP.
- A weekly cron writes aggregates of the previous ISO week to KV, with cells
  from 1 to 4 suppressed and complementary suppression to a fixed point.
  `GET /v1/stats` serves them. An hourly cron writes the forward-failure
  counts that `GET /v1/health` serves.
- GlitchTip runs from `glitchtip/compose.yaml` with a 72-day event,
  transaction, file, log and uptime life and open sign-up off.

## Consequences

- No component that this repository runs stores a client IP.
- A schema version must be deployed to the Worker before any sender uses it
  (core spec rule 6). A new version is a new schema file, a new generated
  validator and a new pin.
- Known limit: the plan's "100 reports a day for each IP" is not enforced. A
  rate-limit binding counts only over 10 or 60 seconds, and a daily count
  needs a stored key derived from the IP. The Worker stores no such key. The
  10-a-minute limit, the schema and each sender's own cap (20 reports a day,
  1 count a week) bound the volume.
- A cell from 1 to 4 and its complementary cells are never published; small
  groups lose detail.
- Analytics Engine keeps data about 3 months; KV keeps the weekly aggregates.
- Without GlitchTip, reports wait on the senders; the health document shows
  the failures.

## Alternatives considered

- **Compile the schema at run time:** Workers forbid `eval` and
  `new Function`. Rejected.
- **A daily per-IP counter in KV or a Durable Object:** stores a key derived
  from the IP. Rejected.
- **Forward `count` to GlitchTip:** it is not a problem and GlitchTip's event
  life would drop the history. Rejected.
- **Publish raw reports:** breaks deletion by `report_id` and retention, and
  rare combinations single out installs (plan ask T857c). Rejected.

## References

- Shapes: [design/intake.md](../design/intake.md),
  [specs/intake-api.md](../specs/intake-api.md),
  [specs/analytics-points.md](../specs/analytics-points.md),
  [specs/stats.md](../specs/stats.md),
  [runbook/glitchtip.md](../runbook/glitchtip.md),
  [runbook/deploy.md](../runbook/deploy.md)
- Builds on: [ADR-0001](0001-record-architecture-decisions.md)
