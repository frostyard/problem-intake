# 0005 — The Worker sends no report_id tag to GlitchTip

- **Status:** Accepted
- **Date:** 2026-11-05

## Context

[ADR-0003](0003-intake-worker-validates-strips-and-forwards.md) had the Worker
set each event's `event_id` to the `report_id` without dashes and also tag the
event `report_id`. GlitchTip 6.2.6 stores each tag value once in
`issue_events_tagvalue`, and no GlitchTip task deletes from that table: its
nightly cleanup drops tag rows (weekly partitions) and events, never tag
values ([ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md)). Every
`report_id` would stay in GlitchTip for ever, past the 90 days of the privacy
page (cross-review of PR frostyard/problem-intake#2 at 54e9759, finding 1).
GlitchTip had no production data on 2026-11-05: the dataset `fast/glitchtip`
did not exist yet.

## Decision

- The Worker sends no `report_id` tag. The `report_id` is in the event only
  as its `event_id`, in the 32-hex form (`src/envelope.ts`).
- `scripts/glitchtip-delete-report.sh` finds the event by `event_id` only.
  It still deletes `report_id` tag rows and the tag value if any exist, as a
  safety step.
- This changes plan T857 section 5. Odrade decided it under Brian's
  delegation (T885, option A).
- This ADR supersedes the `report_id` tag of ADR-0003.

## Consequences

- The `report_id` leaves GlitchTip with its event: by the deletion script, or
  by the nightly cleanup at the retention limit.
- The GlitchTip UI cannot search issues by a `report_id` tag. An operator
  finds a report by its event ID (the `report_id` without dashes) or with the
  script's `--check`.
- `test/envelope-report-id.test.ts` fails when any outgoing tag key or value
  holds a `report_id`, for every example fixture. The CI job
  `glitchtip-runbook` checks the stored event's tags and, after a deletion,
  that no table in a `pg_dump` holds the deleted `report_id`.

## Alternatives considered

- **Keep the tag and delete tag values in a nightly job of our own:** a
  second cleanup path to maintain next to GlitchTip's. Rejected.

## References

- Shapes: [design/intake.md](../design/intake.md),
  [specs/intake-api.md](../specs/intake-api.md),
  [runbook/glitchtip.md](../runbook/glitchtip.md)
- Builds on: [ADR-0003](0003-intake-worker-validates-strips-and-forwards.md),
  [ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md)
