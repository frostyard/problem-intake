# CI only (.github/workflows/glitchtip.yml): create a throwaway superuser,
# organization, team, project and API token in a test GlitchTip, and print the
# project DSN and the token. Run with: manage.py shell < this file.
# Never run this on the production GlitchTip.
import os
import secrets

from allauth.account.models import EmailAddress
from django.conf import settings

from apps.api_tokens.models import APIToken
from apps.organizations_ext.models import Organization
from apps.projects.models import Project, ProjectKey
from apps.teams.models import Team
from apps.users.models import User

if os.environ.get("GLITCHTIP_CI") != "true":
    raise SystemExit("refusing to run outside the GlitchTip CI job")

# The settings under test, read back from the running app.
assert settings.GLITCHTIP_EVENT_RETENTION_DAYS == 72, settings.GLITCHTIP_EVENT_RETENTION_DAYS
assert settings.GLITCHTIP_TRANSACTION_RETENTION_DAYS == 72, settings.GLITCHTIP_TRANSACTION_RETENTION_DAYS
assert settings.GLITCHTIP_FILE_RETENTION_DAYS == 72, settings.GLITCHTIP_FILE_RETENTION_DAYS
assert settings.ENABLE_USER_REGISTRATION is False
assert settings.ENABLE_ORGANIZATION_CREATION is False

email = "ci@example.invalid"
user = User.objects.create_superuser(email=email, password=secrets.token_urlsafe(24))
EmailAddress.objects.get_or_create(user=user, email=email, defaults={"primary": True, "verified": True})
org = Organization.objects.create(slug="frostyard", name="frostyard")
org.add_user(user)
project = Project.objects.create(slug="system", name="system", organization=org)
team = Team.objects.create(slug="ci", organization=org)
team.members.add(org.organization_users.get(user=user))
team.projects.add(project)
token = APIToken.objects.create(user=user, label="glitchtip-ci")
token.add_permissions(["org:read", "project:read", "event:read", "event:write", "event:admin"])
key = ProjectKey.objects.filter(project=project).first() or ProjectKey.objects.create(project=project)
print(f"CI_DSN={key.get_dsn()}")
print(f"CI_TOKEN={token.token}")
