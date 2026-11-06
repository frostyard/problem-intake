# Spec: Problem triage, `frostyard.problem-triage-facts/1`

This contract governs the job that turns new GlitchTip problems into public
GitHub issues, and that later checks that a released fix stopped them.
Consumers: `scripts/triage/read.mjs`, `scripts/triage/publish.mjs`,
`scripts/triage/watchdog.mjs`, `scripts/triage/seed-allow.mjs`, the tests in
`test/node/triage-*.test.mjs`, and the agents that read the verified summary.
Rationale: [ADR-0006](../adr/0006-a-triage-job-files-verified-problems-as-public-issues.md);
core
[ADR-0074](https://github.com/frostyard/core/blob/main/docs/adr/0074-publish-verified-fault-records-as-public-issues.md)
holds the closed list of public fields. Where the 2 disagree, core ADR-0074
wins.

## Interface

### Configuration

Production values are fixed in `scripts/triage/lib/config.mjs`:

| Name | Value |
| --- | --- |
| GlitchTip API | `https://glitchtip.ketelsen.cloud/api/0/` |
| Organization | `frostyard` |
| Token file | `~/.config/problem-triage/glitchtip-read.token` |
| Token creation day | `~/.config/problem-triage/glitchtip-read.created` |
| State folder | `~/.local/state/problem-triage/` |
| GitHub | `https://github.com/` |
| Image registry | `https://ghcr.io/` |
| Sysext index | `https://repository.frostyard.org/ext/` |

A test overrides them only with `TRIAGE_TEST=1` and 1 or more of the
variables below. Without `TRIAGE_TEST=1`, a variable that is set MUST stop the
run with exit 2 and no request. A test GlitchTip URL MUST have the host
`127.0.0.1` or `localhost`, or the run stops with exit 2.

| Variable | Overrides |
| --- | --- |
| `TRIAGE_GLITCHTIP_URL` | the GlitchTip API base, `http://127.0.0.1:<port>/api/0/` |
| `TRIAGE_TOKEN_FILE` | the token file (a fixture file) |
| `TRIAGE_STATE_DIR` | the state folder (a temporary folder) |
| `TRIAGE_SOURCES` | a fixture folder: `git/<owner>__<repo>/` bare repositories, `registry/<image>.json` tag lists and labels, `index/<feature>/SHA256SUMS` |

### The token file

| Item | Rule |
| --- | --- |
| Path | `/var/home/team/.config/problem-triage/glitchtip-read.token` |
| Owner, mode | owner `team`; the folder `0700`, the file `0600` |
| Value | 64 lowercase hex characters (`^[0-9a-f]{64}$`) and 1 newline |
| Creation day | `glitchtip-read.created`: `^\d{4}-\d{2}-\d{2}$` |
| Use | 1 header, `Authorization: Bearer <token>`, on `GET` requests only |

A missing, unreadable or malformed token file is a `config` failure
([Failures](#failures)). A missing or invalid creation day makes
`run.token_age_days` `null` and adds the note `token_created_unknown`. The
token value MUST NOT appear in any other file, in `facts.json`, in a
diagnostic line or in a GitHub text.

### State files

The state folder is `~/.local/state/problem-triage/`, mode `0700`, owner
`team`.

| File | Mode | Holds |
| --- | --- | --- |
| `facts.json` | `0600` | the document of [the facts schema](#the-facts-schema-frostyardproblem-triage-facts1) |
| `published.json` | `0600` | 1 entry for each tracked problem key ([Close the loop](#close-the-loop)) |
| `health.json` | `0600` | the last 7 runs (`day`, `run.status`, `notes`, the held counts, the deferred counts) and `last_read` (GlitchTip issue id to the day the reader last read it) |
| `heartbeat` | `0600` | the day (`YYYY-MM-DD`) of the last run whose publisher ended |
| `cache/` | `0700` | `git/<owner>__<repo>` clones of the routed repositories, and the registry and index answers of the run |

`facts.json` is written through a temporary file in the same folder, then
renamed, so a reader never sees half a document.

### `triage/config.json`

| Key | Type | Constraint |
| --- | --- | --- |
| `first_seen_cutoff` | string or null | `null`, or `^\d{4}-\d{2}-\d{2}T00:00:00Z$` |

While the value is `null`, every problem is held `before_cutoff` and nothing
is filed. No other key is allowed.

### `triage/routes.json`

| Key | Type | Constraint |
| --- | --- | --- |
| `schema` | string | exactly `frostyard.problem-triage-routes/1` |
| `app_problem` | object | the 7 `app_id` values of the schema, each to a repository |
| `kinds` | object | the kinds that are filed, each to a repository |
| `not_filed` | array | the kinds that are never filed |
| each repository | string | `^frostyard/[a-z0-9-]+$` |

Every kind of the schema `kind` enum is in exactly 1 of `kinds` and
`not_filed`, except `app_problem`, which routes by `app_id` and is in neither.

### The allowlists

`triage/allow/units.txt` and `triage/allow/features.txt`. Line 1 of each file
is the seed line
`# Seed: frostyard/snosi <40-hex commit>, scripts/triage/seed-allow.mjs. A new entry is a PR, never a value from a report.`
The other lines are 1 name each: sorted in the default order of JavaScript
strings, no duplicates, no spaces; a unit MUST match the schema `unit`
pattern, a feature MUST match the schema `feature` pattern. Both files name
the same commit.

`scripts/triage/seed-allow.mjs` writes them from a snosi checkout:

```sh
node scripts/triage/seed-allow.mjs --snosi <path> --commit <40-hex> [--out <dir>]
```

It reads `git -C <path> ls-tree -r <commit>` and takes the basenames of the
entries directly under
`mkosi.images/<x>/mkosi.extra/usr/lib/systemd/{system,user}/` and
`shared/<x>/tree/usr/lib/systemd/{system,user}/`, so no `*.wants/` alias and
no `*.d/` drop-in counts. It skips `shared/firn-installer/` (the installer
ISO sends no report) and a symlink whose target is `/dev/null` (a mask). The
features are the basenames of
`mkosi.images/<x>/mkosi.extra/usr/lib/sysupdate.<y>.d/<name>.feature` without
`.feature`. A commit that is not 40 lowercase hex characters is refused with
exit 2.

### The verified summary

```sh
node scripts/triage/read.mjs --summary
```

It prints the problems of the last `facts.json` (verified values only) and
the held counts, and it sends no GlitchTip request. It is the first way for an
agent to see a problem (`AGENTS.md`).

## The facts schema `frostyard.problem-triage-facts/1`

`facts.json` is internal: it stays on the team VM, mode `0600`, and is never
published.

```json
{
  "schema": "frostyard.problem-triage-facts/1",
  "run": { "day": "2026-11-21", "status": "ok", "token_age_days": 15, "notes": [] },
  "problems": [
    {
      "key": "3f2a1b4c5d6e4f70",
      "repo": "frostyard/chairlift",
      "kind": "app_problem",
      "class": "error",
      "fields": {
        "app_id": "org.frostyard.ChairLift",
        "runtime": "go",
        "component": "gui",
        "code": "store.migrate_failed"
      },
      "frames": [],
      "location": null,
      "observations": [
        { "image": "snow", "variant": "standard", "version": "0.15.0", "feature_version": null, "last_seen_day": "2026-11-20" }
      ],
      "coverage": "complete",
      "first_seen_day": "2026-11-20",
      "glitchtip_issue_ids": [7]
    }
  ],
  "held": {
    "before_cutoff": 0,
    "unknown_route": 0,
    "kind_not_filed": 0,
    "noise": 0,
    "unverified_version": 0,
    "unverified_code": 0,
    "not_allowlisted": 0,
    "source_unavailable": 0,
    "request_cap": 0
  }
}
```

| Key | Type | Constraint |
| --- | --- | --- |
| `schema` | string | exactly `frostyard.problem-triage-facts/1` |
| `run.day` | string | `^\d{4}-\d{2}-\d{2}$`, the day of the run in UTC |
| `run.status` | string | `ok`, `partial`, `config`, `auth`, `unreachable` or `error` |
| `run.token_age_days` | integer or null | `>= 0` |
| `run.notes` | array | 0 or more of `checkout_failed`, `token_created_unknown`; no duplicates |
| `problems` | array | 1 entry for each problem that passed every check |
| `problems[].key` | string | `^[0-9a-f]{16}$` ([Problem key](#problem-key-and-published-forms)) |
| `problems[].repo` | string | `^frostyard/[a-z0-9-]+$`, the routed repository |
| `problems[].kind` | string | the schema `kind` enum, except `crash` and `count` |
| `problems[].class` | string | the schema enum of the kind's class field ([`src/dimensions.ts`](../../src/dimensions.ts)) |
| `problems[].fields` | object | exactly the public fields of the kind ([Public fields](#public-fields)), without `frames`, `location`, the app version and the image versions (each of these has its own place, below); each value that can differ between events comes from the representative event ([Reader](#reader) step 7); `variant` only for `tpm_unlock` and `integrity_error`, `code` only for class `error`, `error_class` only when the representative event has 1 |
| `problems[].frames` | array | 0 to 32 published forms ([Published forms of a frame](#published-forms-of-a-frame)); the frames of the representative event ([Reader](#reader) step 7), empty for every kind except `app_problem` |
| `problems[].location` | string or null | the schema `location` pattern, or `null` |
| `problems[].observations` | array | 1 entry for each verified `(image, variant, version, feature_version)`; see below |
| `problems[].observations[].image` | string | the schema `image.id` enum |
| `problems[].observations[].variant` | string | `standard` or `secure` (the report's `secure` false or true) |
| `problems[].observations[].version` | string | the app version (`semver`) for `app_problem`, else the image version (`^[0-9]{14}$`) |
| `problems[].observations[].feature_version` | string or null | the schema sysext `version` pattern, or `null`; `fields.feature_version` of `sysext_update_failed` is the value of the representative event, present only when it verified for that event |
| `problems[].observations[].last_seen_day` | string | `^\d{4}-\d{2}-\d{2}$` |
| `problems[].coverage` | string | `complete` or `partial` |
| `problems[].first_seen_day` | string | `^\d{4}-\d{2}-\d{2}$` |
| `problems[].glitchtip_issue_ids` | array | 1 or more GlitchTip issue row numbers, integers, no duplicates, ascending |
| `held` | object | exactly the 9 reasons below, each a count of problems |

`coverage` is `complete` when every event of the last 30 days was read and
every source check ran; else `partial`.

| `held` reason | Meaning |
| --- | --- |
| `before_cutoff` | `firstSeen` is before `first_seen_cutoff` |
| `unknown_route` | no route for the kind or the `app_id` |
| `kind_not_filed` | the kind is in `not_filed` |
| `noise` | the class is a fault of the environment, not of our code |
| `unverified_version` | no observation kept a version that passed its check |
| `unverified_code` | `code`, a frame or `location` failed its check |
| `not_allowlisted` | the unit or the feature is not in `triage/allow/` |
| `source_unavailable` | a git, registry or index read failed |
| `request_cap` | the load cap or the deadline stopped the read of that issue |

A held count counts problems (GlitchTip issues), never events.

**Forbidden key names at any depth:** `report_id`, `event_id`, `eventID`,
`week`, `client`, `count`, `retries`. An unknown key, a value outside its
pattern and a forbidden key MUST be refused.

`assertFacts()` in `scripts/triage/lib/facts.mjs` checks the whole document
before the write: only the keys above, each value against its pattern, and no
forbidden key at any depth. A document that fails the check is replaced by a
document with `run.status` `error` and no problems.

## Problem key and published forms

The problem key is the first 16 lowercase hex characters of the SHA-256 of the
UTF-8 bytes of `JSON.stringify([kind, class, ...publishedGroupKey])`, with no
spaces. `publishedGroupKey` is the group key of the GlitchTip fingerprint of
[`src/envelope.ts`](../../src/envelope.ts) (`[kind, class, ...groupKey]`) with
each value in its published form. `src/envelope.ts` exports `groupKey`, and
the reader imports it, so the fingerprint of the Worker and the key of the job
cannot differ. The raw GlitchTip fingerprint stays internal.

| Kind | `publishedGroupKey` |
| --- | --- |
| `unit_failed` | `[unit]` |
| `sysext_update_failed` | `[feature]` |
| `tpm_unlock` | `[tpm_rc]` |
| `app_problem` | `[app_id, code]` when `code` is present; else `[app_id, ...first 3 published frames]`; else `[app_id, location]`; else `[app_id]` |
| `crash` | not filed |
| every other kind | `[]` |

More than 1 GlitchTip issue can map to 1 key; the reader merges them into 1
problem and lists every issue in `glitchtip_issue_ids`. Inside 1 GlitchTip
issue, an event whose raw fingerprint differs from the issue's main raw
fingerprint (the fingerprint of most of its events) is dropped.

The published form of `unit`, `feature`, `code`, `location`, `tpm_rc`,
`app_id` and the class is the value itself, after its check.

### Published forms of a frame

A frame is a Go frame of the `app_problem` report. It goes out in 1 of these
forms, in this order:

| Rule | Raw frame | Published form |
| --- | --- | --- |
| 1. The placeholder | `other` | `other` |
| 2. A frame of the routed module that verifies by the frame rule | `github.com/frostyard/chairlift/internal/store.(*Store).Migrate` | the frame itself |
| 3. A frame of the routed module that does not verify | `github.com/frostyard/chairlift/internal/store.(*Store).Drop` | `unverified` |
| 4. A standard library frame (the schema list of top-level packages): its first path segment | `net/http.(*Server).Serve` | `net` |
| 5. `main.<rest>` | `main.main` | `main` |
| 6. A `github.com/emersion/go-imap/v2` frame | `github.com/emersion/go-imap/v2.(*Client).Read` | `go-imap` |
| 7. A frame of any other `github.com/frostyard/` module | `github.com/frostyard/updex/v2/internal/index.Write` | `frostyard` |

Rule 7 is the published form of any `github.com/frostyard/` module other than
the routed one. It narrows core ADR-0074's "top package name" for frostyard
modules: the path segments after `github.com/frostyard/` are chosen by the
sender inside the schema pattern, so a segment is free text, and the fixed
word `frostyard` keeps free text out of a public issue.

## Reader

`scripts/triage/read.mjs` reads GlitchTip with the read token and writes
`facts.json`. It sends `GET` only.

1. **Token.** It reads the token file and the creation day
   ([The token file](#the-token-file)). A failure sets `run.status` `config`
   and exits 2 with no request.
2. **The issue list.** It lists every issue of the organization `frostyard`
   (`GET /api/0/organizations/frostyard/issues/`, every status, every page by
   the `Link` cursor). Retention (72 days) bounds the list. An issue whose
   `firstSeen` is before `first_seen_cutoff` is held `before_cutoff` and gets
   no further request. While the cutoff is `null`, every issue is held so.
3. **Fair order.** It reads the rest in this order: first the keys that the
   publisher watches (state `released` in `published.json`), then the others
   by the day the reader last read them (`health.json` `last_read`, oldest
   first, never read first). So an issue that a cap skipped comes first in the
   next run.
4. **Events.** For each issue it reads the events
   (`GET /api/0/issues/{id}/events/?full=true`, newest first, every page until
   an event older than 30 days). The load cap: at most 1000 GlitchTip requests
   a run, a pause of 200 ms between requests, 20 seconds for each request and
   15 minutes for the run. An issue whose read the cap cuts gets `coverage`
   `partial`; an issue not reached is held `request_cap`.
5. **Each event alone.** From an event's tags and `extra.detail` the reader
   rebuilds the report fields and computes the problem key
   ([Problem key](#problem-key-and-published-forms)). An event whose raw
   fingerprint differs from the issue's main raw fingerprint is dropped. Each
   other event gives 1 observation `(image, variant, version, feature_version)`.
   An observation whose version fails its check is dropped and counted in the
   diagnostics; it does not hold the problem, so a forged event cannot hide
   real ones.
6. **Route, filter, verify.** The reader applies [Routing](#routing),
   [Noise](#noise) and [Verification](#verification). The fingerprint values
   (`code`, frames, `location`, `unit`, `feature`) are checked once, at the
   newest verified version. A problem that fails a rule is held: only its
   reason count is written, never a value.
7. **Representative event, then the write.** A kept event is 1 whose
   observation passed every check. For each problem the representative event is
   chosen from the kept events: for `app_problem`, the newest event by GlitchTip
   event time among those that carry the newest verified app version; for every
   other kind, the newest kept event by GlitchTip event time. The `code`, frame
   and `location` checks run at the tag of the newest verified version, so the
   frames must come from an event of that version. Fields that are not in the
   fingerprint and can differ between events (`runtime`, `component`,
   `error_class` of `sysext_update_failed`, `target_version`, `newer_version`,
   `feature_version`, the variant, and the frames after the first 3) take
   their value from the representative event; `feature_version` is written
   only when it verified for that event. The reader writes `facts.json`
   through `assertFacts()`, also when the run failed (`run.status` not `ok`,
   `problems` empty).

Dropped observations are not counted in `facts.json`: a count of events is a
count of reports, and `facts.json` holds no report count. The reader writes
such counts to its diagnostics as fixed strings.

## Routing

Routing is by kind and `app_id`; the GlitchTip project is not used.

| Kind, `app_id` | Repository |
| --- | --- |
| `app_problem` `org.frostyard.ChairLift` | `frostyard/chairlift` |
| `app_problem` `org.frostyard.nsl` | `frostyard/nsl` |
| `app_problem` `org.frostyard.intuneme` | `frostyard/intuneme` |
| `app_problem` `org.frostyard.pilothouse` | `frostyard/pilothouse` |
| `app_problem` `org.frostyard.Frostmail` | `frostyard/frostmail` |
| `app_problem` `org.frostyard.Frostnotes` | `frostyard/frostnotes` |
| `app_problem` `org.frostyard.Frostread` | `frostyard/frostread` |
| `unit_failed`, `update_stage_failed`, `booted_older_image`, `tpm_unlock`, `integrity_error` | `frostyard/snosi` |
| `sysext_update_failed` | `frostyard/snosi`; most such faults are sysext publication faults, and the owner transfers the issue to `frostyard/updex` when the fault is in updex code |
| `crash`, `count` | not filed |

An unknown `app_id` or kind is held `unknown_route`; a kind in `not_filed` is
held `kind_not_filed`.

## Noise

A problem is filed only when its class is a fault of our code, not of the
host's environment.

| Kind | Filed | Held `noise` |
| --- | --- | --- |
| `unit_failed` | every `result` | none |
| `update_stage_failed` | `error_class` `signature`, `registry`, `other` | `network`, `disk_space`, `lock` |
| `booted_older_image` | `how` `unknown`, `other` | `manual_rollback`, `boot_menu` (the user's choice) |
| `sysext_update_failed` | `outcome` `failed` with `error_class` `signature`, `checksum`, `http_status`, `link`, `config`, `other` or none | every other outcome; `error_class` `network`, `disk_space` |
| `tpm_unlock`, `integrity_error`, `app_problem` | all | none |

## Verification

Every value that goes out MUST be found in a public source of the
organization. A clone is an anonymous `https` fetch
(`git fetch --depth 1 origin tag <tag>`) into `cache/git/<owner>__<repo>`;
registry and index reads are anonymous.

| Value | Check | On failure |
| --- | --- | --- |
| `app_version` | `v<app_version>` is a tag of the routed repository (`git ls-remote --tags`); order is semver 2.0 precedence, so a prerelease is lower than its release | the observation is dropped; none left: held `unverified_version` |
| `image.version`, `target_version`, `newer_version` | the tag exists in `ghcr.io/frostyard/<image.id>` (registry `tags/list`); order is numeric | as above |
| sysext `version` | a file `<feature>_<version>_…` is listed in `https://repository.frostyard.org/ext/<feature>/SHA256SUMS`, the index that the feature's `.transfer` file reads | `feature_version` is dropped from that observation |
| `code` | the literal `"<code>"` (with the quotes) is in the repository at the tag of the newest verified version (`git grep -F`) | held `unverified_code` |
| `frames` | the frame rule below; at least 1 frame of the routed module must verify | held `unverified_code` |
| `location` | the file exists at the tag and has at least that many lines | held `unverified_code` |
| `unit` | in `triage/allow/units.txt` | held `not_allowlisted` |
| `feature` | in `triage/allow/features.txt` | held `not_allowlisted` |
| `bootc_version`, `retries`, `shipped`, the S6 `count` bucket | no check exists | never written |
| an enum field | the schema enum | refused by the Worker already |

### The frame rule

An issue shows the frames of the representative event, up to 32, in their
published form (the definition is in [Reader](#reader) step 7). At least 1 frame of the routed module MUST verify, else the
problem is held `unverified_code`. A Go panic with no frames and a Rust panic
with no location are filed with `app_id`, `runtime` and `component` only.

A frame of the routed module has the form `<module>/<pkgpath>.<rest>` or
`<module>.<rest>`, where `<module>` is the `module` line of the repository's
`go.mod` at the tag. `<rest>` is 1 of `Name`, `Name[...]` (generic),
`(*T).Name`, `T.Name`, `(*T[...]).Name`, or any of these followed by `.funcN`
or `.funcN.M` (a closure; check its parent).

The check: in `<pkgpath>/*.go` at the tag, not `_test.go`, `git grep -E` finds
this line, with `Name` replaced by the function name and `T` present only for
a method:

```sh
git grep -E '^func (\([a-zA-Z_][a-zA-Z0-9_]* \*?T(\[[^]]*\])?\) )?Name[[(]' -- '<pkgpath>/*.go'
```

A frame that does not verify becomes `unverified`
([Published forms of a frame](#published-forms-of-a-frame)).

## Failures

| Case | `run.status` | Exit | Effect |
| --- | --- | --- | --- |
| The token file is missing, unreadable or malformed | `config` | 2 | no request |
| A `TRIAGE_*` override without `TRIAGE_TEST=1`, or a test URL on another host | `config` | 2 | no request |
| `401` or `403` | `auth` | 3 | the run stops |
| A network error, a timeout, a `5xx`, or a `429` after 1 wait (`Retry-After`, at most 60 seconds) | `unreachable` | 4 | the run stops |
| A `3xx` (a redirect is never followed), malformed JSON, or an unexpected shape | `error` | 5 | the run stops |
| A git, registry or index read fails | `ok` | 0 | that problem is held `source_unavailable`, its `coverage` `partial` |
| The 15-minute deadline | `partial` | 0 | the rest is held `request_cap` |

Diagnostics on stdout and stderr are fixed strings with a reason code. They
MUST NOT print a report value, a token, a URL query or a response body.

## Public fields

Every issue holds the kind, the class, and the newest verified version: the
app version for `app_problem`, else each image id with its newest verified
image version. A list of versions for 1 image or app is never published, and 1
problem key can cover several images. Then, for each kind, only:

| Kind | Public fields |
| --- | --- |
| `app_problem` | `app_id`, `runtime`, `component`, and `code` (class `error`) or `frames` or `location` (class `panic`) |
| `unit_failed` | `unit`, `result` |
| `update_stage_failed` | `error_class`, `target_version` |
| `booted_older_image` | `how`, `newer_version` |
| `sysext_update_failed` | `feature`, `outcome`, `error_class` if present, the newest verified `feature_version` if any |
| `tpm_unlock` | `outcome`, `tpm_rc`, the variant |
| `integrity_error` | `subsystem`, the variant |

The variant is the standard or the secure-boot image (the report's `secure`),
and only these 2 kinds show it. `crash` and `count` have no row: they are
never filed. A new row or a new field is a new core ADR.

**Never published.** No issue, comment or public status holds a `report_id`,
an event ID, a `week`, a `client`, any count (also the S6 `count` bucket,
`retries` or a number of reports), any day, a `bootc_version`, `shipped`,
`secure` outside the 2 kinds above, a host name, a user name, a path or free
text.

## The GitHub issue

1 issue for each problem key, in the routed repository, label `problem-report`,
opened by the machine account `frostyard-machines`.

- **Title:** `Problem report: <kind> <class> <short key>`. The short key is the
  `app_id` and the `code` if any for `app_problem`, else the published group
  key (for example `Problem report: unit_failed exit-code snosi-health.service`).
- **Body:** a fenced block, then 2 lines, then the footer. Line 1 of the
  block is `kind: <kind>` and line 2 is `class: <class>`. Then 1 line
  `<field>: <value>` for each public field of the kind, in the order of the
  table above, then `version: <app version>` for `app_problem`, or 1
  `image: <image id> <image version>` line for each image of the problem
  otherwise. Below the block come the line `Problem key: <key>` and the line
  `GlitchTip issue: <id>[, <id>…]`, a blank line, and this footer, unchanged:
  "Opened by the problem-intake triage job from opt-in problem reports. Every
  value was checked against this repository's public source and release tags.
  Name this issue in the fix PR (`Fixes #N`). What this issue holds and never
  holds: https://frostyard.org/privacy/problem-reports/#public-bug-reports".

````text
```
kind: unit_failed
class: exit-code
unit: snosi-health-report.service
result: exit-code
image: snow 20261105093000
```

Problem key: 3f2a1b4c5d6e4f70
GlitchTip issue: 7

Opened by the problem-intake triage job from opt-in problem reports. Every value was checked against this repository's public source and release tags. Name this issue in the fix PR (`Fixes #N`). What this issue holds and never holds: https://frostyard.org/privacy/problem-reports/#public-bug-reports
````

The first comment holds the marker of cycle 1
([Close the loop](#close-the-loop)).

`assertIssueBody()` in `scripts/triage/lib/issue.mjs` builds the body only from
this table. It MUST refuse a field that is not public for its kind, a day, and
a number that is not a version.

## The publisher

`scripts/triage/publish.mjs` reads `facts.json` and writes GitHub with the
existing `gh` sign-in.

- **Trust rule.** The publisher trusts an issue or a comment as its own record
  only when its author is `frostyard-machines`, the issue has the label
  `problem-report`, and the marker's key matches the body's `Problem key:`
  line. Text from any other author is never read as a record. A `Fixed in` line
  counts only from an author with the association `OWNER`, `MEMBER` or
  `COLLABORATOR` on the repository that holds the issue now.
- **Dedupe.** Before it files, the publisher looks the key up: first in
  `published.json`, then with
  `gh search issues "Problem key: <key>" --owner frostyard --author frostyard-machines --label problem-report`.
  A found issue is never filed again, also after a transfer to another
  repository.
- **Limits for each run.** At most 5 new issues, at most 2 for each
  repository, oldest `first_seen_day` first; at most 10 comments or reopens; at
  most 150 GitHub API calls in all (1 counter in
  `scripts/triage/lib/github.mjs`; 1 GraphQL query reads the state, the closer
  and the comments of all tracked issues of 1 repository, and release lists and
  image labels are read once a run and kept in memory); a deadline of 10
  minutes. Work over a limit waits for the next run, in the same order.
- **Mute.** An issue closed as "not planned" mutes its key: the publisher
  never comments on it and never reopens it.
- **Health.** `health.json` keeps the last 7 runs and `last_read`, mode `0600`;
  agents may read it, because it holds counts and days and no report value. 1
  open issue in `frostyard/problem-intake` titled `Problem triage health` holds
  the public status only: `run.status`, `run.notes`, "token rotation due: yes or
  no" (`yes` from token day 335) and "work deferred: yes or no". No day and no
  count. The publisher rewrites its body each run, and adds a comment only when
  `run.status` turns from `ok` to another value, and once when token rotation
  turns due (token day 335), with the fixed text "The GlitchTip read token is due for rotation." A run
  that never completes is the watchdog's comment, not the publisher's.
- **Watchdog.** `scripts/triage/watchdog.mjs` runs at 12:00
  America/New_York. When `heartbeat` is missing or older than 2 days, it adds
  1 comment to the health issue: "The triage job has not completed a run in the
  last 2 days." Operational text only. It runs also when the main timer never
  started.

## Close the loop

**`published.json`** holds, for each tracked key:

| Key | Type | Meaning |
| --- | --- | --- |
| `repo` | string | the repository that holds the issue now |
| `number` | integer | the issue number |
| `cycle` | integer | `1`, `2`, … (1 more with each regression) |
| `state` | string | `filed`, `merged`, `released`, `verified` or `muted` |
| `boundary` | string or null | the fix boundary: `app:<semver>`, `image:<id>:<14 digits>[,image:<id>:<14 digits>…]`, or `feature:<name>:<version>` |
| `released_day` | string or null | `^\d{4}-\d{2}-\d{2}$` |
| `covered_days` | integer | days with a complete observation since `released_day`; `>= 0` |
| `last_comment_marker` | string or null | the last marker this job wrote |

A day and a count stay internal. No public text holds a day or a count, also
not the day of the job's own run (core ADR-0074 covers the job's public
status).

**Markers.** Each step is 1 comment by the job whose first line is exactly:

```text
<!-- problem-triage:1 key=<key> cycle=<n> step=<filed|released|verified|regressed> boundary=<boundary> -->
```

`boundary` is the value of `boundary` in `published.json`, or `none` while the
problem has no fix boundary yet.

**Recovery.** The publisher writes `published.json` after each GitHub action.
At the start of each run it reads the job's marker comments of each tracked
issue (the trust rule above) and takes the highest `(cycle, step)` found as the
truth. So an action whose state write was lost is not repeated, and a rebuild
of the team VM loses nothing. The tests cover a crash after the issue create,
after a comment and after a reopen.

**Steps.**

1. **Filed** (`cycle` 1). The issue is open. Marker `step=filed`,
   `boundary=none`.
2. **Merged.** The fix PR says `Fixes #N`, and the merge closes the issue as
   completed. The publisher reads the closer from the issue timeline (the PR's
   merge commit, or a commit). With no closer it uses the close time.
3. **Released.** The boundary is:
   - `app_problem`: the oldest non-draft, non-prerelease GitHub release whose
     tag contains the fix commit (`GET /repos/{repo}/compare/{sha}...{tag}`:
     `ahead` or `identical`); with no closer, the oldest such release published
     after the close time. `released_day` is the release's publish day. The
     boundary is `app:<version>`.
   - every system kind: for each image of the problem's observations, the oldest
     tag of `ghcr.io/frostyard/<image>` whose label
     `org.opencontainers.image.source` commit contains the fix commit; with no
     closer, the oldest tag whose label
     `org.opencontainers.image.created` is after the close time. `released_day`
     is the latest of their `created` days. The boundary is the list of
     `image:<id>:<version>`.
   - `sysext_update_failed`, or an issue transferred to another repository: the
     publisher cannot map a fix to a delivery by itself, so the owner adds 1
     comment line, `Fixed in: image <id> <14 digits>` (1 line for each image) or
     `Fixed in: feature <name> <version>`. The newest such comment by a trusted
     author wins. The publisher checks that the image tag exists (its `created`
     label gives `released_day`) or that the feature file is in the feature's
     `SHA256SUMS` (the comment's day is `released_day`, and the publisher keeps
     the list of feature versions of that index on that day).

   The public comment (marker `step=released`) is: "Fix released in
   <boundary>. The job now watches reports for 14 covered days."
4. **Verified.** `covered_days` reaches 14, with no qualifying observation. A
   run counts only when `run.status` is `ok` and the problem's `coverage` is
   `complete`; a missed run, a partial read or a held problem does not count,
   and it does not reset the count. The public comment (marker `step=verified`)
   is: "No qualifying reports observed in 14 covered days after <boundary>."
   This does not prove that every host installed the fix.
5. **Regressed.** A qualifying observation has `last_seen_day` on or after
   `released_day`:
   - boundary `app:<version>`: an app version at or above it, by semver
     precedence;
   - an `image:` boundary: on an image of the boundary, an image version at or
     above that image's version, numeric; an image that is not in the boundary
     does not qualify;
   - a `feature:` boundary: a `feature_version` equal to it, or a feature
     version that was not in the stored index list (newer). No order of feature
     versions is assumed.

   The publisher reopens the issue and comments (marker `step=regressed`,
   `cycle` + 1): "Seen again in <version>, at or after the fix release
   <boundary>." The cycle starts again at step 2. An observation below the
   boundary is a host that has not updated: no action.

This version rule is the loop's authority. GlitchTip's own status cannot be:
our events carry no `release`, so GlitchTip reopens a resolved issue on any
event, also from an install that has not updated.

**The job never changes the GlitchTip status.** The token has read scopes only,
and GlitchTip's status stays as GlitchTip sets it.

## Rules

1. The job sends `GET` to GlitchTip and no other method.
2. It never follows a redirect: a `3xx` is an `error` with exit 5.
3. No event ID is written anywhere: not in `facts.json`, `published.json` or
   `health.json`, not in a diagnostic line, not in a GitHub text.
4. No value is written that failed its check.
5. The scripts use `node:` builtins only, with no npm package and no build
   step: the host runs them with no `npm`.
6. The token value is never written to stdout, stderr, another file or a GitHub
   text, also not in an error message.
7. `facts.json` is written through a temporary file in the same folder and then
   renamed.
8. A run that fails still writes `facts.json`, with its `run.status` and no
   problems.
9. Only the fields of [Public fields](#public-fields) reach a public text.
10. The fair order of the reader and the order of a deferral are the same
    order.
11. A rerun with the same inputs files no second issue for a key.
12. A `TRIAGE_*` override is refused without `TRIAGE_TEST=1`, and a test
    GlitchTip URL MUST be on `127.0.0.1` or `localhost`.
13. The state folder is `0700` and each state file is `0600`.
14. Only `scripts/triage/publish.mjs` opens a `problem-report` issue.

## Derived artifacts

| Artifact | Derivation |
| --- | --- |
| The public fault issues of the routed repositories, label `problem-report` | `facts.json` through [The GitHub issue](#the-github-issue), 1 for each problem key |
| The comments and reopens on those issues | the markers and the version rule of [Close the loop](#close-the-loop) |
| The health issue `Problem triage health` in `frostyard/problem-intake` | the operational status of `health.json` and `facts.json`, public text only |

## References

- Rationale: [ADR-0006](../adr/0006-a-triage-job-files-verified-problems-as-public-issues.md),
  [core ADR-0074](https://github.com/frostyard/core/blob/main/docs/adr/0074-publish-verified-fault-records-as-public-issues.md)
- Context: [design/triage.md](../design/triage.md)
- Operations: [runbook/triage.md](../runbook/triage.md)
- Data: [schema/v1.json](../../schema/v1.json),
  [analytics-points.md](analytics-points.md)
