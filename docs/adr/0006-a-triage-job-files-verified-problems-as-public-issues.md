# 0006 — A daily triage job files verified problems as public issues in the owner repository

- **Status:** Accepted
- **Date:** 2026-11-06

## Context

GlitchTip holds the problem reports that the intake Worker forwards
([ADR-0003](0003-intake-worker-validates-strips-and-forwards.md),
[runbook/glitchtip.md](../runbook/glitchtip.md)). It answers on the LAN only,
and no agent session reads it: the repository documents no read path for it.
The owner of a faulty app or image does not see a fault there as tracked work
in the repository where the fix lands, and a fix PR has nothing public to
name.

frostyard/core
[ADR-0074](https://github.com/frostyard/core/blob/main/docs/adr/0074-publish-verified-fault-records-as-public-issues.md)
amends core
[ADR-0069](https://github.com/frostyard/core/blob/main/docs/adr/0069-report-problems-local-first-opt-in-with-one-sender-per-host.md)
in part: besides the weekly aggregates, a public fault issue may be published.
It holds a closed list of fields, each value verified against a public source
of the organization, and never a `report_id`, an event ID, a `week`, a
`client`, a count or a day. ADR-0074 names `docs/specs/triage.md` in this
repository as the definition of the exact published form of a value.

The intake is public. Anyone can send a document that the schema accepts, and
the schema patterns bound the shape of a value, not its truth
([schema/v1.json](../../schema/v1.json)): a forged, path-shaped frame matches
the frame pattern. A value copied from a report into a public place can
therefore carry any text that fits a pattern.

Facts of GlitchTip 6.2.6, the version that runs
([ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md)):

- An API token belongs to 1 user and has no expiry field.
- The scope `event:write` also allows a `DELETE` of an issue.
- An event reopens a resolved issue unless the event carries the release that
  resolved it. Our events carry no `release`, so any event reopens an issue,
  also 1 from an install that has not updated.
- Alert webhooks are unsigned posts, with no HMAC and no shared secret.

## Decision

- **2 scripts and a watchdog, 1 run a day.** `scripts/triage/read.mjs` reads
  GlitchTip. `scripts/triage/publish.mjs` writes GitHub. Both run as the `team`
  user in systemd user units that the fleet role `team_vm` of bketelsen/fleet
  installs: the read and the publish at 06:15 America/New_York, and
  `scripts/triage/watchdog.mjs` at 12:00. No model runs them
  ([design/triage.md](../design/triage.md)).
- **Read-only token.** The reader sends
  `Authorization: Bearer <token>` with `GET` only, to
  `https://glitchtip.ketelsen.cloud/api/0/`. The token has the scopes
  `event:read` and `project:read` and no write or admin scope. It lives in
  `/var/home/team/.config/problem-triage/glitchtip-read.token`: owner `team`,
  directory mode `0700`, file mode `0600`, outside every repository, with
  `glitchtip-read.created` (the creation day) beside it. This file, the
  operator step that writes it and its rotation live in
  [runbook/triage.md](../runbook/triage.md); no other file holds its value.
- **Verification before publication.** A value reaches an issue only after the
  job finds it in a public source of the organization: a release tag of the
  routed repository, the source at that tag (a code literal, a Go function, a
  Rust file and line), a published tag of `ghcr.io/frostyard/<image>`, the
  published sysext index on `repository.frostyard.org`, or an allowlist in
  `triage/allow/` of this repository. Each value is checked at the version of
  the report event that carries it. A value that fails its check is never
  published: the event is dropped, and only a count by reason stays internal.
- **Public problem key.** The key is the first 16 lowercase hex characters of
  the SHA-256 of the UTF-8 bytes of `JSON.stringify([kind, class,
  ...publishedGroupKey])`, with no spaces. `publishedGroupKey` is the group
  key of the GlitchTip fingerprint of `src/envelope.ts` with each value in its
  published form. The raw fingerprint stays internal. So the key depends only
  on the raw fingerprint and on the fixed mapping of published forms: a frame
  that verifies at 1 release and not at a later 1 cannot change it, a closure
  suffix is dropped before publication so its number cannot change it, and 1
  GlitchTip issue keeps 1 key. More than 1 GlitchTip issue can map to 1 key;
  the reader merges them into 1 problem. Inside 1 GlitchTip issue, an event
  whose raw fingerprint differs from the issue's main raw fingerprint (the
  fingerprint of most of its events) is dropped.
- **Published form of a value.** `unit`, `feature`, `code`, `location`,
  `tpm_rc`, `app_id` and the class go out as they are, after their check. A Go
  frame goes out as: `other` as `other`; a frame of the routed module that the
  frame rule verifies, as its parent frame (0 to 2 closure suffixes are
  dropped, so no closure number goes out); a frame of the routed module that
  does not verify, as `unverified`; a standard library frame as its first path
  segment (`net/http.(*Server).Serve` as `net`); `main.<rest>` as `main`; a
  `github.com/emersion/go-imap/v2` frame as `go-imap`; a frame of any other
  `github.com/frostyard/` module as the fixed word `frostyard`. The last form
  narrows ADR-0074's "top package name" for frostyard modules: the path
  segments after `github.com/frostyard/` are chosen by the sender within the
  schema pattern, so a segment is free text, and a fixed word keeps free text
  out.
- **Frame verification.** A frame belongs to the routed module by the prefix
  `github.com/frostyard/<repo>`, with an optional `/v<N>` (`triage/routes.json`
  names the repository), and that prefix is compared with the `module` line of
  `go.mod` at the observation's release tag. The form of the parent frame
  decides the source check: a free function needs no receiver, a pointer method
  needs a receiver of `*T` or `T`, a value method needs a receiver of `T`. So
  the sender cannot name a package function as a method of a type that has no
  such method.
- **1 issue for each problem key, in the repository that owns the code.**
  Routing is by kind and `app_id` ([triage/routes.json](../../triage/routes.json));
  the GlitchTip project is not used. The label is `problem-report` and the
  author is the machine account `frostyard-machines`.
- **The version rule is the loop's authority.** A fix PR names the issue
  (`Fixes #N`). The release that holds the fix starts a window of 14 covered
  days; a key is watched from then on, so a quiet release can be verified with
  no report, and a qualifying observation in that window reopens the issue as a
  regression. The job never writes to GlitchTip: the read-only token stays
  read-only, and GlitchTip's own issue status follows GlitchTip's rules.
- **Cutoff.** The job files only problems whose GlitchTip issue was first seen
  on or after `first_seen_cutoff` in `triage/config.json`. Until that value is
  set, every problem is held and nothing is filed. A set value is exactly
  `<date>T00:00:00Z` for the cutoff date that the live privacy page states,
  never an earlier date.
- **Limits.** For each run: at most 5 new issues, at most 2 for each
  repository, at most 10 comments or reopens, at most 150 GitHub API calls and
  at most 1000 GlitchTip requests; the reader stops at 15 minutes and the
  publisher at 10 minutes. Work over a limit waits for the next run.
- **A stale run acts on nothing.** The publisher refuses a `facts.json` that is
  not from today (UTC) or that fails its check: it writes the health status
  `error` only, and no loop step runs.
- **What an agent may read.** An agent reads the verified summary
  (`node scripts/triage/read.mjs --summary`), and may read the GlitchTip issue
  level with the read token. It never reads a single event, never uses
  GlitchTip's MCP server, and never copies a GlitchTip value into an issue, a
  PR, a commit or a report before its check. `AGENTS.md` holds these rules.

## Consequences

- Easier: a fault becomes tracked work in the repository that fixes it, and a
  fix PR has a public issue to name.
- Easier: a forged report cannot put new text into an issue. It can only name
  code that exists at a real release.
- Harder: a forged report can still open 1 issue about a fault that no host
  had. The issue says "from opt-in problem reports", not "confirmed", and the
  5-issue limit bounds the cost.
- Harder: the token file is readable by every process of `team`, and every
  agent runs as `team`. The mode `0600` file stops plain reads and accidents,
  not a deliberate act. The token has read scopes only, so a deliberate act
  reaches the reports of opted-in hosts and no write.
- Harder: a fix that nobody installs reaches "no qualifying reports observed
  in 14 covered days". A regression reopens the issue later, and the comment
  says what the window does not prove.
- New obligation: a maintained checkout of this repository on the team VM runs
  `main` the next day, so a bad merge breaks the next run. The health issue
  shows a status other than `ok` the same morning, and the watchdog reports a
  run that never ends.
- New obligation: a new route, unit or feature is a PR to `triage/`. A
  GlitchTip value never becomes an allowlist entry.
- New obligation: the health issue holds operational status only. A count
  derived from reports stays in the internal `health.json`.

## Alternatives considered

- **A separate system user for the job, which agents cannot read:** it keeps
  the token and the raw reports away from every agent, but code updates then
  need a root-owned pinned checkout and a sandboxed unit, and an agent with
  the team key can still reach root on the team VM through its VM host, so a
  separate user stops plain reads only, at a higher cost.
- **A GlitchTip webhook into a hooks listener:** GlitchTip's webhooks are
  unsigned, the listener is built for GitHub's HMAC, and a daily run is
  needed anyway for the release checks.
- **A scheduled model turn that runs the scripts:** a model turn a day, and
  the model sees the run output, which holds values that are not verified yet.
- **A private issue repository, with no change to core ADR-0069:** each owner
  copies every fault into a public issue by hand, and a fix PR cannot name the
  private issue.
- **A second token with `event:write`, to resolve verified issues:** it can
  also delete issues, and an old install reopens a resolved issue, so the job
  would resolve the same issue again and again.
- **Public issues with the values copied from GlitchTip, unverified:** a
  forged report then puts any pattern-valid text, such as a path-shaped frame,
  into a public issue.

## References

- Shapes: [specs/triage.md](../specs/triage.md),
  [design/triage.md](../design/triage.md),
  [runbook/triage.md](../runbook/triage.md)
- Builds on: [ADR-0003](0003-intake-worker-validates-strips-and-forwards.md),
  [ADR-0004](0004-glitchtip-env-file-and-72-day-retention.md),
  [ADR-0005](0005-the-worker-sends-no-report-id-tag.md),
  [core ADR-0069](https://github.com/frostyard/core/blob/main/docs/adr/0069-report-problems-local-first-opt-in-with-one-sender-per-host.md),
  [core ADR-0074](https://github.com/frostyard/core/blob/main/docs/adr/0074-publish-verified-fault-records-as-public-issues.md)
