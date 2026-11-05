# Runbook: GlitchTip on TrueNAS

For Moneo (plan T857 t16) and Brian. GlitchTip stores the forwarded problem
reports. It runs as a TrueNAS SCALE custom app from
[glitchtip/compose.yaml](../../glitchtip/compose.yaml): GlitchTip 6.2.6
(`web`, `worker`, one-shot `migrate`), Postgres 18.6 and Valkey 9.1.3, each
pinned by tag and digest. No value in this runbook is a secret.

## Install

1. **Dataset.** Brian creates the dataset `fast/glitchtip` on the NVMe mirror
   (not under `fast/configs`), with 2 folders:
   - `/mnt/fast/glitchtip/postgres`, owner `999:999` (the postgres user of the
     image), mode `0700`;
   - `/mnt/fast/glitchtip/uploads`, owner `5000:5000` (the GlitchTip user),
     mode `0700`.
   No replication task and no rsync task covers this dataset.
2. **Snapshot task.** 1 periodic snapshot task on `fast/glitchtip`: daily,
   keep 7 days, not recursive into other datasets. Never take a manual
   snapshot of this dataset and never let an app upgrade take one
   (`ix-app-upgrade` snapshots never expire). 80 days of live data plus at
   most 7 days of snapshots stays under the 90 days that the privacy page
   promises.
3. **App.** Apps → Discover Apps → Custom App → Install via YAML, name
   `glitchtip`. Paste `glitchtip/compose.yaml` from `main`. In the editor,
   replace these 5 `${NAME:?...}` references with values (the values stay in
   TrueNAS; never put them in Git, the homewiki or a report):
   - `${SECRET_KEY:?...}`: a new random value, for example the output of
     `openssl rand -hex 32` run on TrueNAS;
   - `${POSTGRES_PASSWORD:?...}`: a new random value (1 place: the
     `x-db-password` anchor feeds Postgres and GlitchTip);
   - `${GLITCHTIP_DOMAIN:?...}`: the LAN UI URL from Teg (t17), for example
     `https://glitchtip.<LAN name>`;
   - `${GLITCHTIP_ALLOWED_HOSTS:?...}`: `intake.ketelsen.cloud,<LAN UI host>`;
   - `${DEFAULT_FROM_EMAIL:?...}`: a sender address.
4. **Check.** Only `web` publishes a port: `10.0.1.100:30053`. Postgres and
   Valkey are not published. The app shows `web`, `postgres` and `valkey`
   healthy and `migrate` exited 0. From the LAN:
   `curl -fsS http://10.0.1.100:30053/_health/` answers `ok`.

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

- `GLITCHTIP_MAX_EVENT_LIFE_DAYS`, `GLITCHTIP_MAX_TRANSACTION_EVENT_LIFE_DAYS`
  and `GLITCHTIP_MAX_FILE_LIFE_DAYS` are 80; the GlitchTip 6 names
  (`GLITCHTIP_EVENT_RETENTION_DAYS`, `GLITCHTIP_TRANSACTION_RETENTION_DAYS`,
  `GLITCHTIP_FILE_RETENTION_DAYS`, `GLITCHTIP_RETENTION_DAYS`) are 80 too.
  `test/node/compose.test.mjs` pins them.
- Check that cleanup works (t16): in the `web` container shell,
  `./manage.py shell -c "from django.conf import settings; print(settings.GLITCHTIP_EVENT_RETENTION_DAYS)"`
  prints `80`. t16 then proves that the worker's scheduled cleanup removes a
  test event older than the limit.

## Updates (plan ask T857g)

Moneo applies GlitchTip updates, Django migrations included:

1. Read the release notes from the pinned version to the new one.
2. Open a PR here that changes the tag and the digest of `web`, `worker` and
   `migrate` (the 3 must stay the same image). Get the digest with
   `curl -s https://hub.docker.com/v2/repositories/glitchtip/glitchtip/tags/<tag>`
   or `skopeo inspect`. The GlitchTip CI job must pass.
3. Run the snapshot task by hand (Data Protection → the task → Run Now).
4. Edit the app's YAML in TrueNAS with the new image lines; `migrate` runs
   before `web` and `worker` start.

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

- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md)
- Context: [design/intake.md](../design/intake.md)
- Deploy: [deploy.md](deploy.md)
