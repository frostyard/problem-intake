# CI only (.github/workflows/glitchtip.yml): create the reader user of the test
# GlitchTip with a read-only token, and print 1 line with the values read back
# from the database and 1 line with the token. It proves the scopes of the
# token that the production reader uses: event:read and project:read only.
# Never run this on the production GlitchTip.
import os

from allauth.account.models import EmailAddress

from apps.api_tokens.models import APIToken
from apps.organizations_ext.constants import OrganizationUserRole
from apps.organizations_ext.models import Organization
from apps.users.models import User

if os.environ.get("GLITCHTIP_CI") != "true":
    raise SystemExit("refusing to run outside the GlitchTip CI job")

email = "reader@example.invalid"
user = User(email=email, is_staff=False, is_superuser=False)
# No password can be used to sign in with this user.
user.set_unusable_password()
user.save()
EmailAddress.objects.get_or_create(user=user, email=email, defaults={"primary": True, "verified": True})

org = Organization.objects.get(slug="frostyard")
org.add_user(user, role=OrganizationUserRole.MEMBER)

token = APIToken.objects.create(user=user, label="triage-reader-ci")
token.add_permissions(["event:read", "project:read"])

# The values under test, read back from the database.
reader = User.objects.get(email=email)
org_user = org.organization_users.get(user=reader)
role = OrganizationUserRole(org_user.role).label.lower()
scopes = sorted(APIToken.objects.get(id=token.id).get_scopes())
print(
    "READER "
    f"is_superuser={reader.is_superuser} "
    f"is_staff={reader.is_staff} "
    f"usable_password={reader.has_usable_password()} "
    f"role={role} "
    f"scopes={','.join(scopes)}"
)
print(f"CI_READ_TOKEN={token.token}")
