# Runbook: Problem triage

For the operator. The triage job reads GlitchTip with a read-only token and
opens public GitHub issues from it
([spec](../specs/triage.md), [design](../design/triage.md)). No value in this
runbook is a secret: the token value is written by hand on the team VM and is
never in Git, an issue, a PR, the homewiki or a chat.

## R1. The read token

1. Sign in to GlitchTip at the LAN UI as the operator's own user.
2. Open **Profile → Auth Tokens** and create 1 token with the scopes
   `event:read` and `project:read` only. No write scope, no admin scope.
3. Copy the value into the operator's password manager. The GlitchTip UI shows
   it once.
4. Never paste the value into a file in a repository, an issue, a PR, the
   homewiki or a chat.

## R2. The token file on the team VM

Precondition: the fleet role `team_vm` change that installs the helper is
applied. This step writes the token file for the `team` user, so the job can
read it.

Run from the root of a bketelsen/fleet checkout on the operator workstation:

```sh
ssh -t -i ~/.ssh/semaphore-fleet-hosts -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=ansible/ssh/team_known_hosts fleet@10.0.1.176 "sudo /usr/local/sbin/problem-triage-set-token"
```

The whole remote command is 1 double-quoted argument. `ssh` joins its
arguments into 1 line for the remote shell, so a quote that is not inside a
quoted argument is lost there.

Paste the token at the hidden prompt. It prints `token saved`.

Check it. The output is `team 600`:

```sh
ssh -i ~/.ssh/semaphore-fleet-hosts -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=ansible/ssh/team_known_hosts fleet@10.0.1.176 "sudo stat -c '%U %a' /var/home/team/.config/problem-triage/glitchtip-read.token"
```

Fallback on Minideb:

```sh
sudo incus exec team --project team -t -- /usr/local/sbin/problem-triage-set-token
sudo incus exec team --project team -- stat -c '%U %a' /var/home/team/.config/problem-triage/glitchtip-read.token
```

The second command prints `team 600` too.

When the first command prints
`sudo: /usr/local/sbin/problem-triage-set-token: command not found`, the fleet
change is not applied yet. Stop here and apply it first: there is no token file
to write.

## R3. The `problem-report` label

The job cannot create labels. Use the operator's own GitHub account, not the
machine account `frostyard-machines`, which may not create labels.

First check which account is active. `gh auth status` must show the operator's
account. Then run exactly:

```sh
for repo in chairlift nsl intuneme pilothouse frostmail frostnotes frostread snosi updex problem-intake; do
  gh label create problem-report --force --color D93F0B --description "Opened by the problem-intake triage job" -R "frostyard/$repo"
done
```

Check 1 repository:

```sh
gh label list -R frostyard/updex --search problem-report
```

The answer holds 1 line that starts with `problem-report`. `--force` also
updates a label that already exists, so the loop is safe to run again.

The 10 repositories are the route targets of
[`triage/routes.json`](../../triage/routes.json) plus problem-intake, which
holds the health issue. A new route repository needs the label first, in the
same way.

## Turn the job on

The timer stays off until every item below holds:

- R2 is done: the check prints `team 600`.
- R3 is done: `problem-report` exists in the 10 repositories.
- core ADR-0074 is merged:
  <https://github.com/frostyard/core/blob/main/docs/adr/0074-publish-verified-fault-records-as-public-issues.md>
- The privacy page section is live, not only merged:

  ```sh
  curl -fsS https://frostyard.org/privacy/problem-reports/ | grep -c 'id="public-bug-reports"'
  ```

  It prints `1`.
- [`triage/config.json`](../../triage/config.json) holds the cutoff date that
  the live page states. Open
  <https://frostyard.org/privacy/problem-reports/#public-bug-reports>, read the
  cutoff date in that section, and check that the file holds exactly that date
  with `T00:00:00Z` at the end (for example `2026-11-20T00:00:00Z`). A
  different value, an earlier date or a time other than `00:00:00Z` stops the
  go-live.

Then set `problem_triage_enabled` to true in the fleet role `team_vm`, and
apply it through the Semaphore template "Team VM configure". After the apply,
`systemctl --user list-timers` as `team` shows `problem-triage.timer` and
`problem-triage-watchdog.timer`.

## Rotation

The token has no expiry date of its own, so the job counts its days from the
creation day file: from token day 335 the health issue says "token rotation due:
yes" and gets 1 comment, "The GlitchTip read token is due for rotation." Rotate
it yearly:

1. R1: a new token, same 2 scopes.
2. R2: write it into the token file. The creation day moves to today, so the
   warning stops.
3. Delete the old token in the GlitchTip UI.

## A leaked token

1. Delete the token at once in the GlitchTip UI.
2. R1 and R2: a new token into the token file.

The token has read scopes only, so a leak reaches the reports of opted-in
hosts and cannot change or delete an issue.

## After a rebuild of the team VM

1. R2 again: the backup holds neither the token file nor the state folder.
2. The publisher rebuilds `published.json` from its own marker comments on the
   tracked issues: no issue is filed twice and no loop step is repeated.
3. Progress is not recovered. `covered_days` starts again at 0 and
   `last_counted_day` at `null`, and for a `feature:` boundary the index list
   is read again on the recovery day, so a feature version published in
   between is no longer a sign of a regression.

## Copies

GlitchTip 6.2.6 keeps the token value in clear in Postgres. After a delete, the
snapshot task of the GlitchTip dataset keeps it up to 7 more days, readable
only by the root user of the NAS. The retention arithmetic is in
[glitchtip.md](glitchtip.md#retention).

## Links

- Contract: [specs/triage.md](../specs/triage.md)
- Context: [design/triage.md](../design/triage.md)
- Rationale:
  [ADR-0006](../adr/0006-a-triage-job-files-verified-problems-as-public-issues.md)
- GlitchTip host steps: [glitchtip.md](glitchtip.md)
