# CI only (.github/workflows/glitchtip.yml): tag rows that the cleanup proof
# does not own. Before a proof run with CLEANUP_PROOF_RUN=RUN, "create" makes
# the tag key cleanup_proof_RUN (unreferenced), the tag values
# cleanup-proof-RUN-old (unreferenced) and cleanup-proof-RUN-new (referenced
# by 1 IssueTag row on the kept CI issue, under the key ci_probe_RUN).
# "count" prints how many of them exist; "remove" deletes them.
# Run with: manage.py shell < this file. Never run this on the production
# GlitchTip.
import os
import re

from django.utils import timezone

from apps.issue_events.models import Issue, IssueTag, TagKey, TagValue

if os.environ.get("GLITCHTIP_CI") != "true":
    raise SystemExit("refusing to run outside the GlitchTip CI job")

run = os.environ["RUN"]
if not re.fullmatch(r"[a-z0-9]{8}", run):
    raise SystemExit("RUN must be 8 of a-z and 0-9")
action = os.environ["ACTION"]
issue = Issue.objects.select_related("project").get(id=int(os.environ["ISSUE_ID"]))
org_id = issue.project.organization_id
key_name = f"cleanup_proof_{run}"
probe_name = f"ci_probe_{run}"
old_value = f"cleanup-proof-{run}-old"
new_value = f"cleanup-proof-{run}-new"
rows = IssueTag.objects.filter(issue_id=issue.id, organization_id=org_id, tag_key__key=probe_name, tag_value__value=new_value)

if action == "create":
    TagKey.objects.create(key=key_name)
    probe = TagKey.objects.create(key=probe_name)
    TagValue.objects.create(value=old_value)
    value = TagValue.objects.create(value=new_value)
    IssueTag.objects.create(
        issue_id=issue.id, organization_id=org_id, date=timezone.now(), tag_key=probe, tag_value=value, count=1
    )
elif action == "remove":
    rows._raw_delete(rows.db)
    TagKey.objects.filter(key__in=[key_name, probe_name]).delete()
    TagValue.objects.filter(value__in=[old_value, new_value]).delete()
elif action != "count":
    raise SystemExit("ACTION must be create, count or remove")

print(
    "OWNERSHIP"
    f" key={TagKey.objects.filter(key=key_name).count()}"
    f" old_value={TagValue.objects.filter(value=old_value).count()}"
    f" new_value={TagValue.objects.filter(value=new_value).count()}"
    f" tag_row={rows.count()}"
)
