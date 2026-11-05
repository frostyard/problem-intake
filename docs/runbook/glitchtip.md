# Runbook: GlitchTip on TrueNAS

For Moneo (plan T857 t16) and Brian. GlitchTip stores the forwarded problem
reports. It runs as a TrueNAS SCALE custom app from
[glitchtip/compose.yaml](../../glitchtip/compose.yaml): GlitchTip 6.2.6
(`web`, `worker`, one-shot `migrate`), Postgres 18.6 and Valkey 9.1.3, each
pinned by tag and digest. No value in this runbook is a secret.

## Install

1. **Dataset.** Brian creates the dataset `fast/glitchtip` on the NVMe mirror
   (not under `fast/configs`), with 3 folders:
   - `/mnt/fast/glitchtip/postgres`, owner `999:999` (the postgres user of the
     image), mode `0700`;
   - `/mnt/fast/glitchtip/uploads`, owner `5000:5000` (the GlitchTip user),
     mode `0700`;
   - `/mnt/fast/glitchtip/secrets`, owner `root:root`, mode `0700`.
   No replication task and no rsync task covers this dataset.
2. **Snapshot task.** 1 periodic snapshot task on `fast/glitchtip`: daily,
   keep 7 days, not recursive into other datasets. Never take a manual
   snapshot of this dataset and never let an app upgrade take one
   (`ix-app-upgrade` snapshots never expire). The [Retention](#retention)
   section shows why 72 days of retention plus 7 days of snapshots stays under
   the 90 days that the privacy page promises.
3. **Env file.** The secrets and host names are in 1 file,
   `/mnt/fast/glitchtip/secrets/glitchtip.env` (owner `root`, mode `0600`).
   It holds these 6 names ([glitchtip/.env.example](../../glitchtip/.env.example));
   their values never go in Git, the homewiki, the TrueNAS app YAML or a
   report:
   - `SECRET_KEY`: random;
   - `POSTGRES_PASSWORD`: random;
   - `DATABASE_PASSWORD`: the same value as `POSTGRES_PASSWORD`;
   - `GLITCHTIP_DOMAIN`: the LAN UI URL from Teg (t17), for example
     `https://glitchtip.<LAN name>`;
   - `ALLOWED_HOSTS`: `localhost,intake.ketelsen.cloud,<LAN UI host>`. It must
     start with `localhost,`: the `web` healthcheck and the scripts use
     `localhost`. A missing `ALLOWED_HOSTS` line is a fault: GlitchTip's
     default is `*`, every host;
   - `DEFAULT_FROM_EMAIL`: a sender address.

   Brian writes it in System → Shell after `sudo -i` (as root). The random
   values are made by `openssl rand -hex` inside the file write, so no value
   is shown on screen; Brian types the 3 host values at the prompts:

   ```sh
   install -d -o 0 -g 0 -m 0700 /mnt/fast/glitchtip/secrets
   read -r -p "GLITCHTIP_DOMAIN (URL from Teg): " domain
   read -r -p "LAN UI host name: " lan_host
   read -r -p "DEFAULT_FROM_EMAIL: " from_email
   (
     umask 077
     db_password="$(openssl rand -hex 24)"
     {
       echo "SECRET_KEY=$(openssl rand -hex 32)"
       echo "POSTGRES_PASSWORD=$db_password"
       echo "DATABASE_PASSWORD=$db_password"
       echo "GLITCHTIP_DOMAIN=$domain"
       echo "ALLOWED_HOSTS=localhost,intake.ketelsen.cloud,$lan_host"
       echo "DEFAULT_FROM_EMAIL=$from_email"
     } > /mnt/fast/glitchtip/secrets/glitchtip.env
   )
   chown root:root /mnt/fast/glitchtip/secrets/glitchtip.env
   chmod 0600 /mnt/fast/glitchtip/secrets/glitchtip.env
   ```

   Check it with no value on screen:
   `stat -c '%U %a %n' /mnt/fast/glitchtip/secrets /mnt/fast/glitchtip/secrets/glitchtip.env`
   shows `root 700` and `root 600`;
   `sed 's/=.*//' /mnt/fast/glitchtip/secrets/glitchtip.env` shows the 6
   names; `grep -c '^ALLOWED_HOSTS=localhost,' /mnt/fast/glitchtip/secrets/glitchtip.env`
   prints `1`.
4. **App.** Apps → Discover Apps → Custom App → Install via YAML, name
   `glitchtip`. Paste `glitchtip/compose.yaml` from `main` as it is, with no
   edit: it has no secret and no `${...}` reference. `postgres`, `migrate`,
   `web` and `worker` read the env file with `env_file`; `valkey` reads
   none. A key in a service's `environment` wins over the env file, so the
   Compose file never sets one of the 6 names (`test/node/compose.test.mjs`).
   INFERENCE, to prove at this install: TrueNAS custom apps accept the
   absolute `env_file` path (the app's compose runs as root). If the install
   fails on the path, stop and tell Murbella and Moneo.
5. **Check.** Only `web` publishes a port: `10.0.1.100:30053`. Postgres and
   Valkey are not published. `web`, `postgres` and `valkey` are healthy.
   `migrate` runs the migrations and exits 0 by design: the app must show
   RUNNING, not CRASHED, with 1 container (`migrate`) exited 0. From the LAN:
   `curl -fsS http://10.0.1.100:30053/_health/` answers `ok`.
6. **Cleanup proof.** Run the cleanup proof once before go-live
   ([Retention](#retention)).

To change a secret later, edit the env file the same way and redeploy the
app; the Compose file does not change.

## Users, organization, projects and DSNs

Open sign-up and organization creation are off
(`ENABLE_USER_REGISTRATION=false`, `ENABLE_OPEN_USER_REGISTRATION=false`,
`ENABLE_ORGANIZATION_CREATION=false`). Only a superuser adds them.

1. Create the superuser in the TrueNAS shell of the `web` container:
   `./manage.py createsuperuser` (Brian types the password; it is not
   recorded).
2. Log in to the LAN UI. Create the organization `frostyard` (a superuser can
   create it with creation off).
3. Create the project `system` (all system kinds) and 1 project for each app
   ID that gets its own project, named by the app ID (for example
   `org.frostyard.ChairLift`). An app with no project goes to `system`.
4. In each project's settings, turn on **Scrub IP addresses**. GlitchTip
   6.2.6 has no setting to stop it from reading an address from
   `X-Forwarded-For`; caddy strips that header (t17), and the scrub setting is
   the second guard.
5. Copy each project's DSN (Settings → Client Keys). The DSN host must be
   `intake.ketelsen.cloud` with no path prefix, for example
   `https://<key>@intake.ketelsen.cloud/<project id>`. Brian builds the JSON
   for the Worker secret `GLITCHTIP_DSNS`, `{"system": "<dsn>",
   "org.frostyard.ChairLift": "<dsn>"}`, and sets it with `wrangler secret put`
   ([deploy.md](deploy.md)). A DSN is not pasted into any file or report.

## Retention

- Every retention value in `glitchtip/compose.yaml` is 72 days:
  `GLITCHTIP_MAX_EVENT_LIFE_DAYS`, `GLITCHTIP_MAX_TRANSACTION_EVENT_LIFE_DAYS`,
  `GLITCHTIP_MAX_FILE_LIFE_DAYS`, and the GlitchTip 6 names
  `GLITCHTIP_RETENTION_DAYS`, `GLITCHTIP_EVENT_RETENTION_DAYS`,
  `GLITCHTIP_TRANSACTION_RETENTION_DAYS`, `GLITCHTIP_FILE_RETENTION_DAYS`,
  `GLITCHTIP_LOG_RETENTION_DAYS` and `GLITCHTIP_UPTIME_RETENTION_DAYS`.
  `test/node/compose.test.mjs` pins them.
- How GlitchTip 6.2.6 removes old data. Its nightly task
  `glitchtip.tasks.perform_maintenance` runs daily at 05:00 UTC.
  - Events are in daily partitions. `maintain_partitions` drops one when its
    start + 1 day < today − retention, so an event lives at most retention +
    2 days.
  - Issue tag rows (they hold the `report_id` tag) and issue aggregates are in
    weekly partitions, dropped when start + 7 days < today − retention.
  - `cleanup_old_issues` deletes an issue when its `last_seen` < now −
    (retention + 7 days).
- The bound. With retention 72 and a daily snapshot kept 7 days, the worst
  case is about 81 days for an event and about 88 days for a tag row or an
  issue, under the 90 days of the privacy page. With retention 80 it was
  about 96 days.
- **Cleanup proof.** [scripts/glitchtip-cleanup-proof.sh](../../scripts/glitchtip-cleanup-proof.sh)
  proves that the nightly task removes data older than the retention. Brian
  runs it once on TrueNAS before go-live, as root (it calls `docker exec`).
  Copy it from this repository's `main` branch first, as for the delete
  script:
  `curl -fsSLO https://raw.githubusercontent.com/frostyard/problem-intake/main/scripts/glitchtip-cleanup-proof.sh`,
  then `sudo bash glitchtip-cleanup-proof.sh`. Set `GLITCHTIP_WEB_CONTAINER`
  when the container is not `ix-glitchtip-web-1`, and `GLITCHTIP_ORG` (an
  organization slug) for an organization other than the first one.
  - What it does: it makes a temporary project `cleanup-proof-<random>`,
    sends 2 test events of 2 issues to it from inside the `web` container,
    and waits (a bounded poll) until both are stored. It moves 1 event, its
    tag and aggregate rows and its issue back by the retention + 20 days,
    into old partitions that it creates as GlitchTip does, and runs the real
    nightly task. Then it deletes the temporary project with GlitchTip's
    project deletion task and every test row left.
  - Output: counts and PASS or FAIL only, never a DSN, key or secret. The
    first line shows `retention_days=72`.
  - PASS (exit 0) means: the old event, its tag and aggregate rows and its
    issue are gone; the recent event, its tag rows and its issue stayed; and
    no test row and no partition of the script is left (`stage=left`, all 0).
  - Exit status: 0, PASS; 1, the proof could not run (no organization, an
    error, or no result from GlitchTip); 2, a usage error; 3, FAIL: the
    nightly task did not remove the old test data, or removed the recent
    test data; 4, FAIL: test data is left after the cleanup (wins over 3 and
    5); 5, FAIL: the 2 test events were not stored in time.
  - Running the nightly task early also drops any real data older than the
    retention: the same as the next night's run.
- The CI job `glitchtip-runbook` (`.github/workflows/glitchtip.yml`) runs the
  same script on the same image digest: it must exit 3 with
  `--no-maintenance` (a test flag that skips the nightly task) and 0 without
  it, with `retention_days=72`.

## Updates (plan ask T857g)

Moneo applies GlitchTip updates, Django migrations included:

1. Read the release notes from the pinned version to the new one.
2. Open a PR here that changes the tag and the digest of `web`, `worker` and
   `migrate` (the 3 must stay the same image). Get the digest with
   `curl -s https://hub.docker.com/v2/repositories/glitchtip/glitchtip/tags/<tag>`
   or `skopeo inspect`. The GlitchTip CI job must pass.
3. Run the snapshot task by hand (Data Protection → the task → Run Now).
4. Update the app's YAML in TrueNAS with the merged `glitchtip/compose.yaml`.
   The diff shows only the image lines: the file holds no secret, and the env
   file does not change. `migrate` runs before `web` and `worker` start.
5. Check: the app RUNNING, `migrate` exited 0, `/_health/` answers `ok`.

A Postgres major upgrade (18 to 19) is always an ask to Brian first.

## Monitoring

- The `web` healthcheck calls `/_health/`; `postgres` and `valkey` have
  their own healthchecks.
- `GET https://report.frostyard.org/v1/health` shows the Worker's forward
  failures of the last hour and day (class `5xx`, `4xx`, `3xx`, `timeout`,
  `network`, `config`). Failures with `config` are a Worker secret problem;
  `4xx` often means a bearer mismatch with caddy or a wrong DSN.

## Delete 1 report

A user gives a `report_id` (chairlift "Sent reports", or
`/var/lib/snosi-health/sent.jsonl` on Floe). The Worker sets the event ID to
the `report_id` and tags the event `report_id`.

The script runs on TrueNAS as root (it calls `docker exec`). Copy it from
this repository's `main` branch first, for example with
`curl -fsSLO https://raw.githubusercontent.com/frostyard/problem-intake/main/scripts/glitchtip-delete-report.sh`.

1. Find it: in the LAN UI search the organization's issues for
   `report_id:<report_id>`, or run on TrueNAS
   `sudo bash glitchtip-delete-report.sh --check <report_id>`, which prints
   counts only.
2. Delete it: `sudo bash glitchtip-delete-report.sh <report_id>`. The
   script deletes the event, the `report_id` rows of the issue tag
   aggregates and the tag value, and the issue when no other event is left in
   it. Set `GLITCHTIP_WEB_CONTAINER` when the container is not
   `ix-glitchtip-web-1` (`sudo docker ps --format '{{.Names}}' | grep web`).
3. Check: `--check` exits 3 ("nothing with this report_id: no event and no
   tag rows"), and the UI search finds nothing.
4. Snapshots keep the deleted event up to 7 more days; that is in the
   retention that the privacy page states.

Exit status of the script: 0, at least 1 event found (and deleted); 1, no
result from GlitchTip; 2, a usage error or a report_id that is not a
lowercase UUIDv4; 3, no event and no tag rows; 4, no event but `report_id`
tag rows found (they are deleted in delete mode; run `--check` again, which
then exits 3).

The CI job `glitchtip-runbook` (`.github/workflows/glitchtip.yml`) proves
these steps: it deletes 1 of 2 reports of 1 issue and checks that the other
report and the issue stay. It runs on every change to `glitchtip/**` and
`scripts/glitchtip-*`.

## Kill switch

To stop intake (for example during maintenance), set the Worker var
`KILL_SWITCH` to `on` ([deploy.md](deploy.md)). Senders get 503 and keep
their items for the next day. For a short GlitchTip stop, no kill switch is
needed: the Worker answers 502 and senders retry the next day.

## References

- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md),
  [ADR-0004](../adr/0004-glitchtip-env-file-and-72-day-retention.md) (env file, 72-day retention)
- Context: [design/intake.md](../design/intake.md)
- Deploy: [deploy.md](deploy.md)
