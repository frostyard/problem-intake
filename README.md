# problem-intake

Opt-in problem report intake Worker (plan T857).

frostyard images send problem reports only after the user (chairlift) or the
admin (Floe's `snosi-health`) opts in. This repository holds the Cloudflare
Worker at `https://report.frostyard.org` that takes them, the weekly
aggregation, and the GlitchTip Compose file and runbooks for the store on
Brian's homelab.

- Decision: frostyard/core
  [ADR-0069](https://github.com/frostyard/core/blob/main/docs/adr/0069-report-problems-local-first-opt-in-with-one-sender-per-host.md)
  (local first, opt-in, one sender per host) and this repository's
  [ADR-0003](docs/adr/0003-intake-worker-validates-strips-and-forwards.md).
- Schema: `frostyard.problem/1`, frostyard/core
  [problem-report.md](https://github.com/frostyard/core/blob/main/docs/specs/problem-report.md);
  [schema/v1.json](schema/v1.json) is its byte copy.
- Design: [docs/design/intake.md](docs/design/intake.md).

## Endpoints

| Endpoint | What it does |
| --- | --- |
| `POST /v1/report` | Takes 1 report: 202 accepted, 400 invalid, 413 over 8 KB, 415 not JSON, 429 rate limited, 502 GlitchTip failed (the sender retries the next day), 503 kill switch |
| `GET /v1/stats` | The weekly aggregates index and the latest week |
| `GET /v1/stats/<week>` | 1 week, such as `2026-W45` |
| `GET /v1/health` | Forward failures of the last hour and day |

Contracts: [intake API](docs/specs/intake-api.md),
[Analytics Engine points](docs/specs/analytics-points.md),
[aggregates](docs/specs/stats.md).

## Privacy rules

- The Worker never stores, logs or forwards the client IP. It reads
  `CF-Connecting-IP` only as the key of the Workers rate-limit binding
  (counters only), and no other client header, no user agent and no `cf` geo
  data.
- Observability, logs, traces and Logpush are off; the source has no
  `console` call.
- Every document must pass the schema: closed shape, enums, patterns and the
  app ID allowlist; no free text.
- GlitchTip gets each problem with a `report_id` tag, `user.ip_address` null
  and no `server_name`. `count` reports never go to GlitchTip. GlitchTip keeps
  events 80 days; with 7 days of snapshots that stays under 90 days.
- Public statistics are aggregates only. A cell from 1 to 4 is never
  published, and complementary cells are suppressed so that no small value
  returns by subtraction.
- A report can be deleted by its `report_id`
  ([runbook](docs/runbook/glitchtip.md#delete-1-report)).

**Known limit.** The plan asks for about 10 reports a minute and 100 a day
for each IP. The Worker enforces 10 in 60 seconds: a rate-limit binding
counts only over 10 or 60 seconds, and a daily limit needs a stored key
derived from the IP, which the Worker does not keep. The schema and each
sender's own cap (20 reports a day, 1 count a week) bound the rest.

## Test

```sh
mise install         # Node 24
npm ci
make ci BASE=origin/main
```

`make check` runs the typecheck, the validator drift check, the node tests,
vitest with coverage in workerd (GlitchTip and the SQL API are mocked), and
`wrangler deploy --dry-run`. The GlitchTip CI job starts the Compose stack and
proves the deletion runbook.

## Operate

- [Deploy the Worker](docs/runbook/deploy.md): Brian's host steps (KV
  namespace, GitHub environment, Worker secrets, zone settings).
- [GlitchTip on TrueNAS](docs/runbook/glitchtip.md): install, retention,
  updates, monitoring, deletion of 1 report, kill switch.
