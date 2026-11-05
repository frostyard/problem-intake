# Spec: Weekly aggregates, `frostyard.problem-stats/1`

This contract governs the public weekly aggregates that the intake Worker
writes to KV and serves at `GET /v1/stats`. Consumers: frostyard.org's
`/stats/` page (Tamalane, plan T857 t18), which fetches it at build time.

## Interface

`GET /v1/stats` answers the index and the latest week:

```json
{
  "schema": "frostyard.problem-stats-index/1",
  "weeks": ["2026-W44", "2026-W45"],
  "latest": { "schema": "frostyard.problem-stats/1", "week": "2026-W45", "...": "..." }
}
```

`latest` is `null` before the first weekly run. `GET /v1/stats/<week>`
answers 1 week document:

```json
{
  "schema": "frostyard.problem-stats/1",
  "week": "2026-W45",
  "min_cell": 5,
  "tables": {
    "reports": {
      "group_by": "image",
      "cell_by": "kind",
      "total": 84,
      "groups": {
        "snow": { "total": 51, "cells": { "crash": 9, "unit_failed": 42 } },
        "floe": { "total": null, "cells": { "tpm_unlock": null } }
      }
    },
    "app_problems": { "group_by": "app_id", "cell_by": "class", "total": 19, "groups": {} },
    "installs": { "group_by": "image", "cell_by": "image_version", "total": 99, "groups": {} }
  }
}
```

| Table | Rows | Group | Cell |
| --- | --- | --- | --- |
| `reports` | Every kind except `app_problem` and `count` | `image.id` | `kind` |
| `app_problems` | `app_problem` | `app_id` | `class` (`panic`, `error`) |
| `installs` | `count` | `image.id` | `image.version` |

KV keys: `aggregates/<week>.json` (1 week document) and
`aggregates/index.json` (`{"schema": "frostyard.problem-stats-index/1", "weeks": [...]}`,
sorted, no duplicates).

## Rules

1. The weekly job runs on Monday at 03:23 UTC and aggregates the previous ISO
   week (UTC): the data points written from Monday 00:00 to the next Monday
   00:00.
2. A count is `SUM(_sample_interval)`. Every row of the SQL answer is
   checked: `kind` and `image_id` in the schema's enums, `image_version`
   matches `^[0-9]{14}$`, `class` in the enum of the kind's class field (empty
   for `count`), `app_id` in the allowlist for `app_problem` and empty
   otherwise, the count a non-negative integer. 1 bad row fails the job, and
   nothing is written.
3. A cell with a value of 0 is absent. A group with no cell is absent.
4. **Primary suppression.** A value from 1 to `min_cell - 1` (1 to 4) is
   published as `null`: cells, group totals and the table total.
5. **Complementary suppression.** Each group total is the sum of its cells,
   and the table total is the sum of the group totals. When 1 of these
   equations holds exactly 1 `null` value, it could be found by subtraction,
   so 1 more value of that equation becomes `null`: the smallest published
   cell (or group total; ties by key), or the equation's total when no part is
   left. This repeats over both levels until nothing changes.
6. The 3 tables share no counts (`app_problem` is only in `app_problems`,
   `count` only in `installs`), so no table can be subtracted from another.
7. No published number is from 1 to 4. No suppressed value is determined by
   the published values: `test/suppress.test.ts` solves the linear system
   exactly over the rationals on fixed and on 3000 seeded random tables.

## References

- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md),
  plan T857 section 5 and ask T857c (aggregates only)
- Context: [design/intake.md](../design/intake.md)
- Data: [analytics-points.md](analytics-points.md)
