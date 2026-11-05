#!/usr/bin/env bash
# Delete 1 problem report from GlitchTip by its report_id
# (docs/runbook/glitchtip.md, "Delete 1 report").
#
# The Worker sets the event_id to the report_id and tags the event with
# report_id, so the report_id finds exactly 1 event. The script deletes that
# event, the report_id tag rows of the issue aggregates, the tag value, and
# the issue when no other event is left in it. It prints counts only.
#
# Usage: scripts/glitchtip-delete-report.sh [--check] <report_id>
#   --check  count only, delete nothing
# Exit status:
#   0  at least 1 event with this report_id was found (and deleted)
#   1  no result from GlitchTip
#   2  usage error, or the report_id is not a lowercase UUIDv4
#   3  nothing with this report_id: no event and no tag rows
#   4  no event, but report_id tag rows were found (and deleted)
# Environment:
#   GLITCHTIP_WEB_CONTAINER  the GlitchTip web container (name or id);
#                            default ix-glitchtip-web-1 (TrueNAS app "glitchtip")
#   DOCKER                   the docker command; default "docker"
set -euo pipefail

usage() {
  echo "Usage: $0 [--check] <report_id>" >&2
  exit 2
}

mode=delete
if [[ "${1:-}" == "--check" ]]; then
  mode=check
  shift
fi
[[ $# -eq 1 ]] || usage
report_id="$1"
# The schema pattern of report_id: a lowercase UUIDv4. Nothing else reaches
# the database query.
if [[ ! "$report_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
  echo "error: the report_id must be a lowercase UUIDv4" >&2
  exit 2
fi

container="${GLITCHTIP_WEB_CONTAINER:-ix-glitchtip-web-1}"
read -r -a docker <<<"${DOCKER:-docker}"

output="$("${docker[@]}" exec -i -e "REPORT_ID=$report_id" -e "MODE=$mode" "$container" ./manage.py shell <<'PY'
import os
import uuid

from django.db import transaction

from apps.issue_events.models import Issue, IssueEvent, IssueTag, TagValue

report_id = str(uuid.UUID(os.environ["REPORT_ID"]))
event_uuid = uuid.UUID(report_id)
mode = os.environ["MODE"]

events = IssueEvent.objects.filter(event_id=event_uuid)
tags = IssueTag.objects.filter(tag_key__key="report_id", tag_value__value=report_id)
found = events.count()
tag_rows = tags.count()
issues_deleted = 0
if mode == "delete" and (found or tag_rows):
    with transaction.atomic():
        issue_ids = set(events.values_list("issue_id", flat=True))
        events.delete()
        tags.delete()
        if not IssueTag.objects.filter(tag_value__value=report_id).exists():
            TagValue.objects.filter(value=report_id).delete()
        for issue in Issue.objects.filter(id__in=issue_ids):
            if not IssueEvent.objects.filter(issue_id=issue.id).exists():
                issue.force_delete()
                issues_deleted += 1
print(f"RESULT mode={mode} events={found} tag_rows={tag_rows} issues_deleted={issues_deleted}")
PY
)"

result="$(grep -E '^RESULT ' <<<"$output" | tail -n 1)"
if [[ -z "$result" ]]; then
  echo "error: no result from manage.py shell" >&2
  exit 1
fi
echo "${result#RESULT }"
events="$(sed -E 's/.* events=([0-9]+) .*/\1/' <<<"$result")"
tag_rows="$(sed -E 's/.* tag_rows=([0-9]+) .*/\1/' <<<"$result")"
if [[ "$events" == "0" && "$tag_rows" == "0" ]]; then
  echo "nothing with this report_id: no event and no tag rows" >&2
  exit 3
fi
if [[ "$events" == "0" ]]; then
  # Only possible after a partial deletion by hand; delete mode removed them.
  echo "no event with this report_id, but tag rows ($mode mode)" >&2
  exit 4
fi
