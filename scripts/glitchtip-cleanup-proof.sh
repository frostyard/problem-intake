#!/usr/bin/env bash
# Prove that GlitchTip's nightly cleanup removes data older than the
# retention limit (docs/runbook/glitchtip.md, "Retention").
#
# The script makes a temporary project cleanup-proof-<random> in the first
# organization, sends 2 test events of 2 issues to it from inside the web
# container, and waits until both are stored. It moves 1 event, its issue
# tag rows and issue aggregates, and its issue's last_seen back by the
# retention + 20 days (into old partitions that it creates as GlitchTip
# does). Then it runs GlitchTip's real nightly task
# glitchtip.tasks.perform_maintenance, and checks that the old event, its tag
# and aggregate rows and its issue are gone, and that the recent event, its
# tag rows and its issue stay. At the end it deletes the temporary project
# with GlitchTip's delete_project task, removes what is left of the test
# data, and checks that no test row and no partition it made is left. It
# prints counts and PASS or FAIL only: never a DSN, a key or a secret. Of the
# container's output it shows only lines of a strict shape (numbers, lowercase
# words with underscores, or an exception type), and never its stderr.
#
# Usage: scripts/glitchtip-cleanup-proof.sh [--no-maintenance]
#   --no-maintenance  test only: skip the nightly task; the proof must then
#                     fail with exit status 3 (CI proves that the check works)
# Exit status:
#   0  PASS: the old test data is gone, the recent test data stayed, and no
#      test data is left
#   1  the proof could not run: no organization, an error, or no result
#      from GlitchTip
#   2  usage error
#   3  FAIL: the nightly task did not remove the old test data, or removed
#      the recent test data
#   4  FAIL: test data or a partition of the script is left after the cleanup
#      (this status wins over 3 and 5)
#   5  FAIL: the 2 test events were not stored in time
# Environment:
#   GLITCHTIP_WEB_CONTAINER  the GlitchTip web container (name or id);
#                            default ix-glitchtip-web-1 (TrueNAS app "glitchtip")
#   GLITCHTIP_ORG            the slug of the organization for the temporary
#                            project; default the first organization
#   DOCKER                   the docker command; default "docker"
#   CLEANUP_PROOF_RUN        test only: the run id (8 of a-z and 0-9) instead
#                            of a random one (CI checks that the script keeps
#                            tag keys and values that it did not create)
set -euo pipefail

usage() {
  echo "Usage: $0 [--no-maintenance]" >&2
  exit 2
}

mode=proof
if [[ "${1:-}" == "--no-maintenance" ]]; then
  mode=no_maintenance
  shift
fi
[[ $# -eq 0 ]] || usage

org="${GLITCHTIP_ORG:-}"
# An organization slug: lowercase letters, digits and hyphens only.
if [[ -n "$org" && ! "$org" =~ ^[a-z0-9][a-z0-9-]{0,49}$ ]]; then
  echo "error: GLITCHTIP_ORG must be an organization slug" >&2
  exit 2
fi

run="${CLEANUP_PROOF_RUN:-}"
if [[ -n "$run" && ! "$run" =~ ^[a-z0-9]{8}$ ]]; then
  echo "error: CLEANUP_PROOF_RUN must be 8 of a-z and 0-9" >&2
  exit 2
fi

container="${GLITCHTIP_WEB_CONTAINER:-ix-glitchtip-web-1}"
read -r -a docker <<<"${DOCKER:-docker}"

# GlitchTip's own log lines (stderr) never reach the screen: they can hold
# any text.
output="$("${docker[@]}" exec -i -e "MODE=$mode" -e "ORG=$org" -e "RUN=$run" "$container" ./manage.py shell 2>/dev/null <<'PY'
import json
import os
import secrets
import time
import urllib.request
import uuid
from datetime import UTC, datetime, timedelta

from django.conf import settings
from django.db import connection, transaction

from apps.issue_events.models import (
    Issue,
    IssueAggregate,
    IssueEvent,
    IssueHash,
    IssueIndex,
    IssueTag,
    TagKey,
    TagValue,
)
from apps.organizations_ext.models import Organization
from apps.projects.models import IssueEventProjectHourlyStatistic, Project, ProjectCounter, ProjectKey
from glitchtip.partition_manager import UUID7Helper, PartitionManager

MODE = os.environ["MODE"]
ORG = os.environ.get("ORG", "")
POLL_SECONDS = 180
run = os.environ.get("RUN") or secrets.token_hex(4)
# A tag key of this run only: the cleanup never touches another key.
TAG = f"cleanup_proof_{run}"
values = {"old": f"cleanup-proof-{run}-old", "new": f"cleanup-proof-{run}-new"}
retention = int(settings.GLITCHTIP_EVENT_RETENTION_DAYS)
shift = timedelta(days=retention + 20)


def out(kind, **counts):
    # Only numbers, fixed words and exception type names: never a message.
    print(kind + " " + " ".join(f"{k}={v}" for k, v in counts.items()), flush=True)


stage = "setup"


class Stop(Exception):
    def __init__(self, status):
        self.status = status


out("COUNT", retention_days=retention, backdate_days=shift.days, mode=MODE)
org = (Organization.objects.filter(slug=ORG) if ORG else Organization.objects.order_by("id")).first()
if org is None:
    out("ERROR", stage="setup", type="NoOrganization")
    out("STATUS", result="ERROR")
    raise SystemExit

manager = PartitionManager()
created_partitions = []
issue_ids = set()
# The tag keys and values that exist before the run are never deleted.
known_keys = set(TagKey.objects.filter(key=TAG).values_list("id", flat=True))
known_values = set(TagValue.objects.filter(value__in=list(values.values())).values_list("id", flat=True))
project = Project.objects.create(name=f"cleanup-proof-{run}", organization=org)
status = "ERROR"


def ensure_partition(parent, start, interval, key_type):
    """Create 1 old partition the way maintain_partitions does, and remember it."""
    name = f"{parent}_{start:%Y%m%d}"
    if manager.table_exists(name):
        return
    manager.create_partitions_for_date_range(
        parent_table=parent,
        start_date=start,
        end_date=start + interval,
        partition_interval="DAY" if interval == timedelta(days=1) else "WEEK",
        hash_buckets=None,
        hash_column="organization_id",
        key_type=key_type,
    )
    created_partitions.append(name)


def stored(event):
    issue = event["issue_id"]
    return (
        IssueTag.objects.filter(organization_id=org.id, issue_id=issue).exists()
        and IssueAggregate.objects.filter(organization_id=org.id, issue_id=issue).exists()
    )


try:
    stage = "send"
    # 1. Send 2 events with 2 fingerprints (2 issues). The key stays in
    # this process: it is never printed.
    event_ids = {k: uuid.uuid4() for k in values}
    key = ProjectKey.objects.filter(project=project).first().public_key.hex
    for k, value in values.items():
        body = json.dumps(
            {
                "event_id": event_ids[k].hex,
                "message": f"cleanup proof {k}",
                "level": "error",
                "platform": "other",
                "fingerprint": [value],
                "tags": {TAG: value},
            }
        ).encode()
        request = urllib.request.Request(
            f"http://localhost:8000/api/{project.id}/store/",
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "X-Sentry-Auth": f"Sentry sentry_version=7, sentry_key={key}, sentry_client=frostyard-cleanup-proof/1",
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeError(f"store answered {response.status}")
    del key

    stage = "wait"
    # 2. Wait until the worker stored both events, their tag rows and
    # aggregates (a bounded poll).
    deadline = time.monotonic() + POLL_SECONDS
    while True:
        events = {
            k: IssueEvent.objects.filter(organization_id=org.id, event_id=v).values("id", "issue_id").first()
            for k, v in event_ids.items()
        }
        issue_ids.update(e["issue_id"] for e in events.values() if e)
        if all(events.values()) and all(stored(e) for e in events.values()):
            break
        if time.monotonic() > deadline:
            out("COUNT", stored_events=sum(1 for e in events.values() if e))
            raise Stop("TIMEOUT")
        time.sleep(1)
    old, new = events["old"], events["new"]
    if old["issue_id"] == new["issue_id"]:
        raise RuntimeError("the 2 test events are in 1 issue")

    stage = "backdate"
    # 3. Backdate the old event, its tag and aggregate rows, and its issue.
    # The event id is a UUIDv7 that holds the received time and is the RANGE
    # partition key; an UPDATE of the key moves the row to the old partition.
    old_id = UUID7Helper.from_datetime(UUID7Helper.extract_datetime(old["id"]) - shift)
    old_day = UUID7Helper.extract_datetime(old_id).replace(hour=0, minute=0, second=0, microsecond=0)
    ensure_partition("issue_events_issueevent", old_day, timedelta(days=1), "uuid7")
    weeks = set()
    for model in (IssueTag, IssueAggregate):
        for date in model.objects.filter(organization_id=org.id, issue_id=old["issue_id"]).values_list("date", flat=True):
            day = (date - shift).astimezone(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
            weeks.add(day - timedelta(days=day.weekday()))
    for week in sorted(weeks):
        for parent in ("issue_events_issuetag", "issue_events_issueaggregate"):
            ensure_partition(parent, week, timedelta(weeks=1), "datetime")
    with transaction.atomic(), connection.cursor() as cursor:
        args = [old["issue_id"], org.id]
        cursor.execute(
            "UPDATE issue_events_issueevent SET id = %s WHERE id = %s AND organization_id = %s",
            [old_id, old["id"], org.id],
        )
        if cursor.rowcount != 1:
            raise RuntimeError("the old event did not move")
        for table in ("issue_events_issuetag", "issue_events_issueaggregate"):
            cursor.execute(
                f"UPDATE {table} SET date = date - %s::interval WHERE issue_id = %s AND organization_id = %s",
                [shift, *args],
            )
        cursor.execute(
            "UPDATE issue_events_issueindex SET last_seen = last_seen - %s::interval WHERE issue_id = %s AND organization_id = %s",
            [shift, *args],
        )
        cursor.execute(
            "UPDATE issue_events_issue SET first_seen = first_seen - %s::interval WHERE id = %s",
            [shift, old["issue_id"]],
        )

    def counts():
        return {
            "old_event": IssueEvent.objects.filter(organization_id=org.id, id=old_id).count(),
            "old_tag_rows": IssueTag.objects.filter(organization_id=org.id, issue_id=old["issue_id"]).count(),
            "old_aggregate_rows": IssueAggregate.objects.filter(organization_id=org.id, issue_id=old["issue_id"]).count(),
            "old_issue": Issue.objects.filter(id=old["issue_id"]).count(),
            "new_event": IssueEvent.objects.filter(organization_id=org.id, id=new["id"]).count(),
            "new_tag_rows": IssueTag.objects.filter(organization_id=org.id, issue_id=new["issue_id"]).count(),
            "new_issue": Issue.objects.filter(id=new["issue_id"]).count(),
        }

    before = counts()
    out("COUNT", stage="before", **before)
    if not (before["old_event"] == 1 and before["old_tag_rows"] and before["old_issue"] == 1):
        raise RuntimeError("the backdate did not take")

    stage = "maintenance"
    # 4. The real nightly task.
    if MODE != "no_maintenance":
        from glitchtip.tasks import perform_maintenance

        perform_maintenance.call()
    stage = "check"
    after = counts()
    out("COUNT", stage="after", **after)
    gone = after["old_event"] == 0 and after["old_tag_rows"] == 0 and after["old_aggregate_rows"] == 0 and after["old_issue"] == 0
    kept = after["new_event"] == 1 and after["new_tag_rows"] > 0 and after["new_issue"] == 1
    status = "PASS" if gone and kept else "FAIL"
except Stop as stop:
    status = stop.status
except Exception as error:  # noqa: BLE001 - report and clean up
    # The stage and the type only: a message can hold any text.
    out("ERROR", stage=stage, type=type(error).__name__)
    status = "ERROR"
finally:
    # 5. Delete the temporary project with GlitchTip's own task, then any
    # test row that is left, then the empty partitions of this script.
    from apps.projects.tasks import delete_project

    try:
        delete_project.call(project.id)
    except Exception as error:  # noqa: BLE001 - the fallback below deletes the rest
        out("ERROR", stage="delete_project", type=type(error).__name__)
    issue_ids.update(Issue.objects.filter(project_id=project.id).values_list("id", flat=True))
    ids = list(issue_ids)
    with transaction.atomic():
        IssueEvent.objects.filter(organization_id=org.id, issue_id__in=ids)._raw_delete("default")
        for model in (IssueTag, IssueAggregate, IssueIndex):
            model.objects.filter(organization_id=org.id, issue_id__in=ids)._raw_delete("default")
        IssueHash.objects.filter(project_id=project.id)._raw_delete("default")
        IssueEventProjectHourlyStatistic.objects.filter(project_id=project.id)._raw_delete("default")
        Issue.objects.filter(id__in=ids)._raw_delete("default")
        for leftover in Project.objects.filter(id=project.id):
            leftover.force_delete()
    # Only the tag keys and values that this run created, and only when no
    # tag row uses them.
    run_keys = set(TagKey.objects.filter(key=TAG).values_list("id", flat=True)) - known_keys
    run_values = (
        set(TagValue.objects.filter(value__in=list(values.values())).values_list("id", flat=True)) - known_values
    )
    for key_id in run_keys:
        if not IssueTag.objects.filter(tag_key_id=key_id).exists():
            TagKey.objects.filter(id=key_id).delete()
    for value_id in run_values:
        if not IssueTag.objects.filter(tag_value_id=value_id).exists():
            TagValue.objects.filter(id=value_id).delete()
    with connection.cursor() as cursor:
        for name in created_partitions:
            if manager.table_exists(name):
                cursor.execute(f"SELECT count(*) FROM {name}")
                if cursor.fetchone()[0] == 0:
                    cursor.execute(manager.drop_partition(name))

    left = {
        "projects": Project.objects.filter(id=project.id).count(),
        "keys": ProjectKey.objects.filter(project_id=project.id).count(),
        "counters": ProjectCounter.objects.filter(project_id=project.id).count(),
        "issues": Issue.objects.filter(id__in=ids).count() + Issue.objects.filter(project_id=project.id).count(),
        "events": IssueEvent.objects.filter(organization_id=org.id, issue_id__in=ids).count(),
        "tag_rows": IssueTag.objects.filter(organization_id=org.id, issue_id__in=ids).count(),
        "aggregate_rows": IssueAggregate.objects.filter(organization_id=org.id, issue_id__in=ids).count(),
        "index_rows": IssueIndex.objects.filter(organization_id=org.id, issue_id__in=ids).count(),
        "hashes": IssueHash.objects.filter(project_id=project.id).count(),
        "hourly_rows": IssueEventProjectHourlyStatistic.objects.filter(project_id=project.id).count(),
        "tag_values": TagValue.objects.filter(id__in=list(run_values)).count(),
        "tag_keys": TagKey.objects.filter(id__in=list(run_keys)).count(),
        "partitions": sum(1 for name in created_partitions if manager.table_exists(name)),
    }
    out("COUNT", stage="left", **left)
    if sum(left.values()):
        status = "LEFTOVER"
    out("STATUS", result=status)
PY
)" || true

# Show only the exact record layouts that the Python prints: the same fields
# in the same order, each with its own value rule. Any other field, an extra
# field or another value drops the whole line. The shown line is built again
# from the parsed values, never echoed raw.
int='(0|[1-9][0-9]{0,9})'
stages='(setup|send|wait|backdate|maintenance|check|delete_project)'
exception='([A-Z][A-Za-z]{0,60})'

# show KIND NAME=RULE...: print "KIND: NAME=value ..." when $line has exactly
# this layout. Each RULE has 1 group.
show() {
  local kind="$1" re spec i=1 shown
  shift
  re="^$kind"
  for spec in "$@"; do re+=" ${spec%%=*}=${spec#*=}"; done
  re+='$'
  [[ "$line" =~ $re ]] || return 1
  shown="$kind:"
  for spec in "$@"; do
    shown+=" ${spec%%=*}=${BASH_REMATCH[i]}"
    i=$((i + 1))
  done
  echo "$shown"
}

ints() {
  local name
  for name in "$@"; do printf '%s\n' "$name=$int"; done
}
mapfile -t before_after < <(ints old_event old_tag_rows old_aggregate_rows old_issue new_event new_tag_rows new_issue)
mapfile -t left < <(ints projects keys counters issues events tag_rows aggregate_rows index_rows hashes \
  hourly_rows tag_values tag_keys partitions)

while IFS= read -r line; do
  show COUNT "retention_days=$int" "backdate_days=$int" "mode=(proof|no_maintenance)" ||
    show COUNT "stored_events=$int" ||
    show COUNT "stage=(before|after)" "${before_after[@]}" ||
    show COUNT "stage=(left)" "${left[@]}" ||
    show ERROR "stage=$stages" "type=$exception" ||
    true
done <<<"$output"
result="$(sed -En 's/^STATUS result=(PASS|FAIL|LEFTOVER|TIMEOUT|ERROR)$/\1/p' <<<"$output" | tail -n 1)"
case "$result" in
  PASS)
    echo "PASS: the nightly task removed the old test data, kept the recent test data, and no test data is left"
    exit 0
    ;;
  FAIL)
    echo "FAIL: the nightly task did not remove the old test data, or removed the recent test data" >&2
    exit 3
    ;;
  LEFTOVER)
    echo "FAIL: test data is left after the cleanup (see the counts with stage=left)" >&2
    exit 4
    ;;
  TIMEOUT)
    echo "FAIL: the 2 test events were not stored in time" >&2
    exit 5
    ;;
  ERROR)
    echo "error: the proof could not run (see the ERROR line)" >&2
    exit 1
    ;;
  *)
    echo "error: the proof could not run (no result from GlitchTip)" >&2
    exit 1
    ;;
esac
