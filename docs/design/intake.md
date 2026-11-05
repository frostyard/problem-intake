# Problem intake

Living document. Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md).
Contracts: [specs/intake-api.md](../specs/intake-api.md),
[specs/analytics-points.md](../specs/analytics-points.md),
[specs/stats.md](../specs/stats.md).

## Overview

The Worker takes opt-in problem reports from the 2 senders (chairlift on
Snow, Snowfield and Sundog; `snosi-health` on Floe), checks them, drops the
client address, and forwards each problem to GlitchTip. It counts reports in
Workers Analytics Engine and publishes weekly aggregates with small cells
suppressed.

```
sender ──POST /v1/report──► Worker (report.frostyard.org)
                               │  kill switch, rate limit, type, size, schema
                               ├──► Analytics Engine `problem_reports` (schema values only)
                               └──► https://intake.ketelsen.cloud/api/<project>/envelope/
                                        caddy (bearer check, header strip) ──► GlitchTip web 10.0.1.100:30053

cron hourly ──► SQL API ──► KV health/latest.json ──► GET /v1/health
cron Monday ──► SQL API ──► KV aggregates/<week>.json, aggregates/index.json ──► GET /v1/stats
```

## Design

- **Code.** `src/index.ts` routes and runs the crons. `src/report.ts` is the
  request handler; it is the only file that reads `CF-Connecting-IP`.
  `src/forward.ts` holds the bearer and DSN handling. `src/envelope.ts` builds
  the Sentry event from schema values only. `src/analytics.ts` builds the
  data points. `src/jobs.ts`, `src/sql.ts`, `src/stats.ts` and
  `src/suppress.ts` make the aggregates. `src/generated/validate-v1.js` is the
  validator that `scripts/build-validator.mjs` compiles from
  `schema/v1.json`.
- **Order of checks.** Kill switch, rate limit, content type, size, JSON,
  schema ([specs/intake-api.md](../specs/intake-api.md)).
- **Privacy.** The Worker reads `Content-Type`, `Content-Length` and
  `CF-Connecting-IP` (rate-limit key only), and no other header and no
  `request.cf`. It has no `console` call. Observability, logs, traces,
  Logpush, `workers.dev` and preview URLs are off. `test/node/privacy-scan.test.mjs`
  and `test/node/wrangler-config.test.mjs` pin this.
- **Forward.** The outgoing request is new: 3 headers (`Authorization`,
  `Content-Type: application/x-sentry-envelope`, `X-Sentry-Auth`) and an
  envelope with 1 event. `GLITCHTIP_DSNS` maps `system` and app IDs to DSNs;
  an app without its own project goes to `system`. Only `https` DSNs with no
  path prefix, query or secret part are accepted.
- **Event.** `event_id` is the `report_id` without dashes; tags hold the
  envelope values and each scalar `detail` field; `extra.detail` holds the
  detail object; `fingerprint` is kind and class plus the unit, feature,
  TPM code, executable, or app with its code, first 3 frames or location;
  `user.ip_address` is null. No `server_name`, `request`, `contexts` or
  `timestamp`.
- **Counting.** After a successful forward, and for each valid `count`, the
  Worker writes 1 point to `REPORTS`. A forward failure writes 1 point to
  `HEALTH` ([specs/analytics-points.md](../specs/analytics-points.md)).
- **Aggregates.** The Monday cron (`23 3 * * 1`, UTC) reads the previous ISO
  week with `SUM(_sample_interval)`, validates every row against the schema's
  enums and patterns, builds 3 independent tables and suppresses small and
  complementary cells, also against the bound that every listed value is 1
  or more ([specs/stats.md](../specs/stats.md), rules 4 to 7).

## Known limits

- **Daily rate limit.** The plan asks for about 10 reports a minute and 100 a
  day for each IP. The Worker enforces 10 in 60 seconds only: a rate-limit
  binding counts over 10 or 60 seconds, and a daily count needs a stored key
  derived from the IP, which the Worker does not keep. Senders cap themselves
  at 20 reports a day and 1 count a week.
- **Counts are advisory.** Without an ID, a forged report that passes the
  schema looks like a real one. Spikes are checked by hand.
- **Weekly window.** A week's aggregate counts the points written in that ISO
  week (UTC), not the `week` field of the reports.

## Operational notes

- **Kill switch.** Set the var `KILL_SWITCH` to `on` (Cloudflare dashboard or
  a PR to `wrangler.jsonc`) and the Worker answers 503 with
  `Retry-After: 86400`. Senders keep their items and try again the next day.
  Any value other than `off` also answers 503.
- **Health.** `GET /v1/health` shows forward failures of the last hour and
  day. A failure class `config` means a missing or malformed Worker secret;
  `4xx` often means a bearer mismatch with caddy; `timeout` or `network`
  means the homelab path is down.
- **Secrets.** `INTAKE_BEARER`, `GLITCHTIP_DSNS`, `AE_READ_TOKEN`,
  `CF_ACCOUNT_ID`, set with `wrangler secret put`
  ([runbook/deploy.md](../runbook/deploy.md)).
- **Caddy contract.** caddy checks the bearer and must strip `Authorization`
  before upstream: GlitchTip reads a `Bearer` value as a DSN key before
  `X-Sentry-Auth`. caddy also strips the forwarding headers, because GlitchTip
  records a routable address from `X-Forwarded-For`
  ([runbook/glitchtip.md](../runbook/glitchtip.md)).
- **Schema versions.** The Worker must accept a schema version before any
  sender uses it. A new version adds `schema/v2.json`, a second generated
  validator and its pin.

## References

- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md),
  core [ADR-0069](https://github.com/frostyard/core/blob/main/docs/adr/0069-report-problems-local-first-opt-in-with-one-sender-per-host.md)
- Contracts: [specs/intake-api.md](../specs/intake-api.md),
  [specs/analytics-points.md](../specs/analytics-points.md),
  [specs/stats.md](../specs/stats.md), core
  [problem-report.md](https://github.com/frostyard/core/blob/main/docs/specs/problem-report.md)
- Operations: [runbook/deploy.md](../runbook/deploy.md),
  [runbook/glitchtip.md](../runbook/glitchtip.md)
- Built in: plan T857 phase 2, task t15
