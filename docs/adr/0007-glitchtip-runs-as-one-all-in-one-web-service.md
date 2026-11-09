# 0007 — GlitchTip runs as 1 all-in-one web service

- **Status:** Accepted
- **Date:** 2026-11-09

## Context

Up to GlitchTip 6.2.6 the image runs 2 roles: `web` serves HTTP, and
`worker` runs `./bin/run-worker.sh`, the task worker with its scheduler.
`glitchtip/compose.yaml` runs 1 service for each role, plus Postgres, Valkey
and a one-shot `migrate` ([ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md)).

GlitchTip 7.0.0 (released 2026-11-09) removes the separate task worker:

- `./bin/run-worker.sh` only prints an error and exits 1;
- `bin/start.sh` exits 1 when `SERVER_ROLE` is anything but `web` or
  `all_in_one`;
- 1 granian process runs HTTP, the task worker and the scheduler.

The upstream sample compose runs 1 `web` service with
`SERVER_ROLE: all_in_one`.

6.2.6 accepts the same value. With `SERVER_ROLE=all_in_one` its
`bin/start.sh` runs `bin/run-all-in-one.sh`, which exports
`GLITCHTIP_EMBED_WORKER=true` and runs granian with the task worker and the
scheduler embedded. With `SKIP_INIT=true` it skips its own migrate step.

7.0.0 also retires old setting names, ignored with a startup warning.
These include `GLITCHTIP_MAX_EVENT_LIFE_DAYS`,
`GLITCHTIP_MAX_TRANSACTION_EVENT_LIFE_DAYS`,
`GLITCHTIP_MAX_FILE_LIFE_DAYS`, `ENABLE_OPEN_USER_REGISTRATION` and
`DATABASE_CONN_MAX_AGE`. An ignored name keeps no value, so a retention set
only under an old name falls to the default of 90 days, and data then
outlives the 90 days of the privacy page (ADR-0004). In 6.2.6 the new names
already win or are equal, so to drop the old names changes nothing on the
current pin.

## Decision

- `glitchtip/compose.yaml` has no `worker` service.
- `web` sets `SERVER_ROLE=all_in_one` and `SKIP_INIT=true`, and sets no
  `command`: the image CMD `./bin/start.sh` runs 1 process with HTTP, the
  task worker and the scheduler.
- `migrate` stays a one-shot service, and `web` waits for it to exit 0.
- `GRANIAN_WORKERS` is `1`, so 1 process hosts 1 task worker at
  `VTASKS_CONCURRENCY` 2.
- `web` has a `mem_limit` of 1536m, the sum of the old `web` and `worker`
  limits of 768m each.
- Only the 6 retention names that GlitchTip 6 and 7 read are set: the
  `*_RETENTION_DAYS` names.
- This ADR supersedes the `worker` part of
  [ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md). The env file
  and the 72 days stay as they are.

## Consequences

- The same file works on GlitchTip 6.2.6 and on 7.x. A 7.x update changes
  only the image lines of `web` and `migrate`, so the update diff stays
  small.
- A crash of `web` now also stops the background tasks. `restart:
  unless-stopped` brings the process back.
- The task concurrency stays 1 worker × `VTASKS_CONCURRENCY` 2.
- The CI job `glitchtip-runbook` proves ingest, which needs the task worker,
  and it proves that the scheduler runs: it polls Valkey for the key whose
  name holds `vtasks_scheduler_lock`.
- `test/node/compose.test.mjs` refuses a `worker` service, a `run-worker.sh`
  command and 12 retired names.

## Alternatives considered

- **Keep a `worker` service on 6.2.6 and remove it with the 7.0 pin:**
  rejected. It makes 2 changes in 1 risky update, and the update diff is no
  longer only image lines.
- **Drop `migrate` and let `web` initialize the database:** rejected. The
  runbook checks that `migrate` exited 0, and a failed migration stays
  separate from serving.

## References

- Shapes: [runbook/glitchtip.md](../runbook/glitchtip.md)
- Builds on: [ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md)
- Release notes: [GlitchTip v7.0.0](https://gitlab.com/glitchtip/glitchtip-backend/-/releases/v7.0.0)
- Upstream sample: [compose.sample.yml](https://glitchtip.com/assets/compose.sample.yml)
