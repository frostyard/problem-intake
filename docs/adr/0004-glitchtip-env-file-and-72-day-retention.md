# 0004 — GlitchTip reads its secrets from an env file and keeps data 72 days

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

GlitchTip runs as a TrueNAS SCALE custom app from `glitchtip/compose.yaml`
([ADR-0003](0003-intake-worker-validates-strips-and-forwards.md)). Until
2026-11-05 the file took `SECRET_KEY`, the database password and the host
names as `${NAME:?}` references, and Brian typed the values into the app's
YAML in the TrueNAS UI. TrueNAS stores that YAML. Each compose update needs
the whole file, and its dry run prints the stored one, so every update showed
the secrets (plan T857 t16 prep, Moneo, finding F1).

ADR-0003 set GlitchTip retention to 80 days, and the privacy page promises
at most 90 days. GlitchTip 6.2.6 removes old data in its nightly task
`glitchtip.tasks.perform_maintenance` (05:00 UTC):

- events are in daily partitions; `maintain_partitions` drops one when its
  start + 1 day < today − retention;
- issue tag rows (they hold the `report_id` tag) and issue aggregates are in
  weekly partitions, dropped when start + 7 days < today − retention;
- `cleanup_old_issues` deletes an issue when its `last_seen` < now −
  (retention + 7 days).

A tag row or an issue therefore lives up to about retention + 9 days. With 80
days and 7 days of snapshots that was about 96 days, over the 90-day promise
(finding F5).

## Decision

- `glitchtip/compose.yaml` holds no secret and no `${`. `postgres`,
  `migrate`, `web` and `worker` read
  `/mnt/fast/glitchtip/secrets/glitchtip.env` (owner root, mode 0600) with
  `env_file`; `valkey` reads none. The file holds `SECRET_KEY`,
  `POSTGRES_PASSWORD`, `DATABASE_PASSWORD`, `GLITCHTIP_DOMAIN`,
  `ALLOWED_HOSTS` and `DEFAULT_FROM_EMAIL`; no service `environment` sets one
  of these names.
- Every GlitchTip retention value is 72 days.
- Odrade decided both under Brian's delegation (T885).
- This ADR supersedes the 80-day retention of ADR-0003.

## Consequences

- With 72 days and 7 days of snapshots, the worst case is about 81 days for
  an event and about 88 days for a tag row or an issue.
- `scripts/glitchtip-cleanup-proof.sh` proves the cleanup: Brian runs it once
  on TrueNAS before go-live, and the CI job `glitchtip-runbook` runs it on
  the same image digest.
- The Compose file deploys as it is; an update diff shows only image lines.
  A secret changes in the env file, not in Git.
- TrueNAS reading an absolute `env_file` path is an inference; the install
  proves it.
- `test/node/compose.test.mjs` pins the env file, the absence of `${`, and
  the 72-day values.

## Alternatives considered

- **Keep the values in the TrueNAS app YAML:** every compose update dry run
  shows them. Rejected.
- **Keep 80 days and fewer snapshot days:** tag rows and issues alone reach
  about 89 days, with no room for a snapshot. Rejected.

## References

- Shapes: [runbook/glitchtip.md](../runbook/glitchtip.md),
  [design/intake.md](../design/intake.md)
- Builds on: [ADR-0003](0003-intake-worker-validates-strips-and-forwards.md)
