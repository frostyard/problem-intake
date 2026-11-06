# Problem triage

Living document. Rationale:
[ADR-0006](../adr/0006-a-triage-job-files-verified-problems-as-public-issues.md).
Contracts: [specs/triage.md](../specs/triage.md).

## Overview

A daily job reads the private GlitchTip, checks every value of each problem
against public source, and opens 1 public GitHub issue for each verified
problem in the repository that owns the faulty code. Later runs follow the fix
to its release, and reopen the issue when reports come back at or above that
release.

```
GlitchTip 6.2.6 (LAN, read-only token)
   │  GET /api/0/organizations/frostyard/issues/ and /issues/{id}/events/
   ▼
scripts/triage/read.mjs
   │  verify each value: release tag, source at that tag, image tags, sysext
   │  index, allowlists of triage/allow/
   ▼
facts.json  (state, 0600, never published)
   │
   ▼
scripts/triage/publish.mjs ──► GitHub (gh as frostyard-machines)
   │                             problem-report issues, their comments,
   │                             the health issue
   │ heartbeat (a state file)
   ▼
scripts/triage/watchdog.mjs ──► 1 comment on the health issue when no run
                                completed for 2 days
```

## Design

- **`scripts/triage/read.mjs`** lists the issues of the GlitchTip organization
  `frostyard`, reads the events of each issue in the fair order, and turns each
  verified report event into 1 observation. It computes the public problem key
  from the fingerprint of [`src/envelope.ts`](../../src/envelope.ts), routes
  each key to a repository with [`triage/routes.json`](../../triage/routes.json),
  and holds every problem that fails a check with only a count by reason. It
  writes `facts.json` through `assertFacts()`.
- **`scripts/triage/publish.mjs`** reads `facts.json` and drives the loop:
  dedupe, the limits of a run, the issue body of `assertIssueBody()`, the
  markers, the release checks, the 14 covered days, the regression, and the
  health issue and `health.json`. It refuses a `facts.json` that is not from
  today (UTC) or that fails `assertFacts()`, and then writes the health status
  only. A key that is released and quiet collects its covered day from the
  `watched` entry of `facts.json`, so a fix with no new report can verify.
- **`scripts/triage/watchdog.mjs`** reads `heartbeat` and comments on the
  health issue when it is missing or older than 2 days: "The triage job has
  not completed a run in the last 2 days."
- **`scripts/triage/seed-allow.mjs`** writes `triage/allow/units.txt` and
  `triage/allow/features.txt` from a snosi checkout. A new entry is a PR.
- **`scripts/triage/lib/`** holds the shared modules: `config.mjs` (fixed
  values, the `TRIAGE_*` test overrides), `facts.mjs` (`assertFacts()`),
  `issue.mjs` (`assertIssueBody()`), `github.mjs` (the API-call counter).
  The scripts use `node:` builtins only: the host runs them with no `npm`.
- **The Worker does not change.** It keeps forwarding with the same envelope;
  `src/envelope.ts` exports `groupKey`, so the fingerprint of the Worker and
  the key of the job cannot differ. Routing uses the kind and the `app_id`, and
  never the GlitchTip project.
- **The 2 states.** `facts.json` holds what the last run verified, with days
  and internal GlitchTip issue row numbers. `published.json` holds what the
  job already did on GitHub, so a rerun repeats nothing. The publisher restores
  it from its own markers after a rebuild of the host, and lost progress is
  reset, never guessed ([specs/triage.md](../specs/triage.md#close-the-loop)).

## Host items

The fleet role `team_vm` of bketelsen/fleet owns these items on the team VM;
they are written in that role, not in this repository.

| Item | Value |
| --- | --- |
| Code | `~team/.local/share/problem-triage/problem-intake`: a clone of frostyard/problem-intake. Before each run the unit runs `git fetch --quiet origin main` and `git checkout --quiet --detach origin/main`, so a merged change runs the next day. A failed fetch does not stop the run (the `-` prefix): the old checkout runs, and the reader records `checkout_failed` in `run.notes` |
| Helper | `/usr/local/sbin/problem-triage-set-token`, root, mode `0700`, needs a tty, reads the token with `read -rs`, checks its shape, and drops to `team` with `runuser -u team` for every file step. It prints only `token saved` or 1 fixed error line |
| Token file | `~team/.config/problem-triage/glitchtip-read.token` and `glitchtip-read.created` |
| State | `~team/.local/state/problem-triage/`, mode `0700`: `facts.json`, `published.json`, `health.json`, `heartbeat`, `cache/` |
| `problem-triage.service` (user) | `Type=oneshot`; the 2 fetch steps; `ExecStart=-/usr/local/bin/node scripts/triage/read.mjs` (the `-` lets the publisher run when the reader fails); `ExecStart=/usr/local/bin/node scripts/triage/publish.mjs`; `TimeoutStartSec=35min` |
| `problem-triage.timer` (user) | `OnCalendar=*-*-* 06:15:00 America/New_York`, `Persistent=true` |
| `problem-triage-watchdog.service` and `.timer` (user) | `OnCalendar=*-*-* 12:00:00 America/New_York`; `node scripts/triage/watchdog.mjs` |
| Flag | `problem_triage_enabled` in the fleet role `team_vm`, default false. Both timers are enabled only when it is true |

06:15 plus the unit timeout ends before the 07:00 backup and the Sunday 07:00
to 08:00 reboot window, and after the NAS jobs that end at 02:45. The reader
stops itself at 15 minutes and the publisher at 10 minutes, so the unit timeout
is a backstop. Fleet's drift check reports a timer that is not in its set state.

## Privacy boundary

- **Crossing into public text:** only the fields of the public table of
  [specs/triage.md](../specs/triage.md#public-fields), each found in public
  source of the organization in the same run, and the internal GlitchTip issue
  row numbers in the line `GlitchTip issue: <ids>`.
- **Staying internal:** the token value, the raw fingerprints, every event ID,
  every day of a report, every count, the held counts, `bootc_version`,
  `shipped` and the variant outside the 2 kinds that publish it.
- **The intake is public,** so a value of a report is untrusted input: a
  verified value proves only that the code exists at that release, not that the
  fault happened. `AGENTS.md` holds the rules for agents.
- **`facts.json` follows GlitchTip's retention:** it holds only problems whose
  GlitchTip issue still exists. `published.json` holds keys, issue numbers,
  fix boundaries and days, and no report value.

## Operational notes

- **Where to look.** On the team VM as `team`:
  `node scripts/triage/read.mjs --summary` (the verified problems and the held
  counts of the last run), `~/.local/state/problem-triage/facts.json`,
  `~/.local/state/problem-triage/health.json`,
  `systemctl --user status problem-triage.service`, and
  `journalctl --user -u problem-triage.service`. The public health issue
  `Problem triage health` in frostyard/problem-intake shows the operational
  status of the last run.
- **Failure modes.** A `run.status` other than `ok` shows in the health issue
  the same morning and gets 1 comment when it turns from `ok`. `auth` (a `401`
  or a `403`) means the token is wrong, revoked or rotated: it needs the token
  step of the runbook. `unreachable` means the GlitchTip path is down or slow.
  A `source_unavailable` count means a git, registry or index read failed for
  that problem, and the problem is filed later. `run.notes` `checkout_failed`
  means the clone still runs an older `main`.
- **A run that never happens.** The watchdog comments on the health issue when
  `heartbeat` is missing or older than 2 days, so a disabled timer or a failed
  start is visible too. The public status holds no day and no count: it says
  `run.status`, `run.notes`, "token rotation due: yes or no" and "work deferred:
  yes or no", and nothing else.
- **Backup and rebuild.** The Minideb backup of the team VM holds neither
  `~team/.config/problem-triage` nor `~team/.local/state`. After a rebuild the
  token step runs again, and the publisher rebuilds `published.json` from its
  own marker comments on the tracked issues: no issue is filed twice and no
  loop step is repeated. Progress is not recovered: `covered_days` starts again
  at 0, and for a `feature:` boundary the index list is read again on the
  recovery day.
- **A bad merge breaks the next run,** because the clone runs `main` the next
  day: the health issue shows it the same morning, and `make ci` runs the
  triage tests before any merge.
- **Load.** At most 1000 GlitchTip requests a run with a 200 ms pause, and at
  most 150 GitHub API calls a run.
- **The reboot window** is Sunday 07:00 to 08:00. The run at 06:15 with its
  35-minute unit timeout ends before it, and `Persistent=true` starts a run
  that the window cut when the host is back.

## References

- Rationale: [ADR-0006](../adr/0006-a-triage-job-files-verified-problems-as-public-issues.md)
- Contracts: [specs/triage.md](../specs/triage.md)
- Operations: [runbook/triage.md](../runbook/triage.md)
