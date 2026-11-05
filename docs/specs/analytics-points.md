# Spec: Analytics Engine data points

This contract governs the Workers Analytics Engine data points that the
intake Worker writes. Consumers: the weekly and hourly jobs of the Worker
(`src/jobs.ts`), which read them with the SQL API.

## Interface

### Dataset `problem_reports` (binding `REPORTS`)

1 point after each successful forward, and 1 point for each valid `count`
report. `indexes: [kind]`, `doubles: [1]`.

| Blob | Field | Value |
| --- | --- | --- |
| `blob1` | `kind` | The report's `kind` |
| `blob2` | `image_id` | `image.id` |
| `blob3` | `image_version` | `image.version` |
| `blob4` | `secure` | `true` or `false` |
| `blob5` | `client_name` | `chairlift` or `snosi-health` (no version) |
| `blob6` | `class` | The class-like field of the kind: S1 `result`, S2 `error_class`, S3 `how`, S4 `outcome`, S5 `outcome`, S6 `subsystem`, S7 `signal`, S8 `class`; empty for `count` |
| `blob7` | `app_id` | S8 `app_id`; else empty |
| `blob8` | `app_version` | S8 `app_version`; else empty |
| `blob9` | `install_age` | `count` `install_age`; else empty |
| `blob10` | `channel` | `count` `channel`; else empty |

### Dataset `problem_intake_health` (binding `HEALTH`)

1 point for each forward failure. `indexes: ["forward_failed"]`,
`doubles: [1]`, `blob1` = `forward_failed`, `blob2` = the class: `5xx`,
`4xx`, `3xx`, `timeout`, `network`, or `config` (a missing or malformed
Worker secret).

## Rules

- Every blob is a schema value of a valid report, or a fixed string.
- No point holds the `report_id`, the `week`, an IP, a header value, or a
  secret. `test/report.test.ts` checks this.
- Counts read from these datasets use `SUM(_sample_interval)`.
- A change of the blob order changes `src/analytics.ts`, the SQL in
  `src/jobs.ts` and this spec together.

## References

- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md)
- Context: [design/intake.md](../design/intake.md)
- Uses: [stats.md](stats.md)
