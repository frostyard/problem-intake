<!-- readme-kind: service -->
# problem-intake

problem-intake is the Cloudflare Worker at `https://report.frostyard.org`. It
takes opt-in problem reports from frostyard images, checks each one against
the schema `frostyard.problem/1`, drops the client address and forwards each
problem to a self-hosted GlitchTip. It publishes weekly aggregates with small
cells suppressed.

It also holds the GlitchTip Compose file and its runbooks. The decision behind
it is frostyard/core
[ADR-0069](https://github.com/frostyard/core/blob/main/docs/adr/0069-report-problems-local-first-opt-in-with-one-sender-per-host.md)
and this repository's
[ADR-0003](docs/adr/0003-intake-worker-validates-strips-and-forwards.md).

**Status:** in production.

**Documentation:** [docs/README.md](docs/README.md)

## What it does

- **Validate and strip.** A report must pass the closed schema: enums, patterns, the app ID allowlist, and no free text. The Worker forwards schema values only ([schema](schema/v1.json), [design](docs/design/intake.md)).
- **Forward to GlitchTip.** The outgoing request is new, with 3 headers and 1 event whose ID is the `report_id`; no tag holds the `report_id` ([ADR-0005](docs/adr/0005-the-worker-sends-no-report-id-tag.md)).
- **Publish weekly aggregates.** A Monday cron reads the previous ISO week and serves 3 tables, with cells of 1 to 4 and their complements suppressed ([spec](docs/specs/stats.md), [suppression](src/suppress.ts)).
- **Report health.** `GET /v1/health` shows forward failures of the last hour and day ([operational notes](docs/design/intake.md#operational-notes)).
- **Delete 1 report.** A report is deleted by its `report_id` ([runbook](docs/runbook/glitchtip.md#delete-1-report)).
- **Stop intake.** The `KILL_SWITCH` var makes the Worker answer 503 with `Retry-After: 86400`, so senders keep their items for the next day ([kill switch](docs/runbook/deploy.md#kill-switch)).
- **Rate limit.** A Workers rate-limit binding caps each address at 10 reports in 60 seconds ([API spec](docs/specs/intake-api.md)).

## Interface

| Endpoint | What it does |
| --- | --- |
| `POST /v1/report` | Takes 1 report: 202 accepted, 400 invalid, 413 over 8 KB, 415 not JSON, 429 rate limited, 502 GlitchTip failed (the sender retries the next day), 503 kill switch |
| `GET /v1/stats` | The weekly aggregates index and the latest week |
| `GET /v1/stats/<week>` | 1 week, such as `2026-W45` |
| `GET /v1/health` | Forward failures of the last hour and day |

Contracts: [intake API](docs/specs/intake-api.md),
[Analytics Engine points](docs/specs/analytics-points.md),
[aggregates](docs/specs/stats.md).

## Deploy

The Worker deploys from `main` by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which runs on a
push that changes the Worker (`src/`, `schema/`, `wrangler.jsonc`, the npm
manifests or the workflow), and by hand; no workstation deploys. GlitchTip runs on TrueNAS from
[`glitchtip/compose.yaml`](glitchtip/compose.yaml), whose images are pinned by
tag and digest. The host steps are in the [deploy
runbook](docs/runbook/deploy.md) and the [GlitchTip
runbook](docs/runbook/glitchtip.md).

## Privacy

- The Worker never stores, logs or forwards the client IP. It reads
  `CF-Connecting-IP` only as the key of the Workers rate-limit binding
  (counters only), and no other client header, no user agent and no `cf` geo
  data.
- Observability, logs, traces and Logpush are off; the source has no
  `console` call.
- GlitchTip gets each problem with the `report_id` as its event ID and in no
  tag, `user.ip_address` null and no `server_name`. `count` reports never go to
  GlitchTip. Its retention is 72 days: with its partition cleanup and 7 days of
  snapshots, data lives at most about 88 days, under 90 days
  ([runbook](docs/runbook/glitchtip.md#retention)).
- Public statistics are aggregates only. A cell from 1 to 4 is never
  published, and complementary cells are suppressed so that no small value
  returns by subtraction.
- A report can be deleted by its `report_id`
  ([runbook](docs/runbook/glitchtip.md#delete-1-report)).

## Limits

- **The daily rate limit is not enforced.** The Worker enforces 10 reports in
  60 seconds for each address; a daily limit would need a stored key derived
  from the IP, which the Worker does not keep. The schema and each sender's own
  cap (20 reports a day, 1 count a week) bound the rest
  ([known limits](docs/design/intake.md#known-limits)).

## Develop

```sh
mise install   # Node 24
npm ci
make ci BASE=origin/main
```

That is the gate CI runs; [AGENTS.md](AGENTS.md) says what each target does.

## Where to go next

- [AGENTS.md](AGENTS.md): the commands, the rules and the privacy hard rules.
- [docs/README.md](docs/README.md): the decisions, the design, the specs and the runbooks.
- [SECURITY.md](SECURITY.md): report a vulnerability privately.
- [LICENSE](LICENSE): MIT.
