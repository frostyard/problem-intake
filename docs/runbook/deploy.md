# Runbook: Deploy the Worker

The host steps for Brian, in order. This runbook names secrets and settings;
it holds no value. Values are typed only into Cloudflare, GitHub, TrueNAS or
caddy's env file, never into Git, the homewiki or a report.

## 1. Repository settings

- Create the labels `risk:high` and `ready-for-human` (the risk-paths caller
  fails without `risk:high`).
- Make the job `ci` (workflow CI) a required check, with the merge queue
  (`merge_group` runs it).

## 2. Cloudflare

1. **KV namespace.** Create a KV namespace for the aggregates, for example
   `problem-intake-stats`. Put its id into `wrangler.jsonc` (binding `STATS`,
   replace `REPLACE_WITH_STATS_KV_NAMESPACE_ID`) by PR. The deploy workflow
   refuses the placeholder.
2. **Analytics Engine.** Enable Workers Analytics Engine on the account
   (Dashboard → Storage & Databases → Analytics Engine) before the first
   deploy. The bindings `REPORTS` and `HEALTH` need it; without it the
   deploy fails with code 10089 "You need to enable Analytics Engine". The
   enablement can take a few minutes to apply.
3. **Deploy token.** Create an API token for GitHub with: Workers Scripts
   Edit, Workers KV Storage Edit, Workers Routes Edit (or the custom domain
   permission) on the zone `frostyard.org`, Account Analytics Read, and
   Account Settings Read. Keep its scope to the frostyard account and zone:
   its Account Resources must include the account of
   `CLOUDFLARE_ACCOUNT_ID` (step 3).
4. **Analytics read token.** Create a second API token with only Account
   Analytics Read. It becomes the Worker secret `AE_READ_TOKEN`.
5. **Zone settings for `report.frostyard.org`.** No Web Analytics (RUM) on
   that host, no Logpush job for it, and no WAF or custom rule that logs
   request fields for it. Cloudflare's own security events stay, and the
   privacy page names them.

## 3. GitHub environment `production`

Create the environment `production` with 2 secrets:

- `CLOUDFLARE_API_TOKEN`: the deploy token of step 2.3;
- `CLOUDFLARE_ACCOUNT_ID`: the frostyard account id.

Restrict the environment to the branch `main`. Until both exist, the deploy
workflow writes a notice and skips the deploy with success.

## 4. Worker secrets (before the first deploy)

`wrangler.jsonc` lists the 4 secrets in `secrets.required`. With that list,
`wrangler deploy` refuses a Worker until every secret is set, and the first
`wrangler secret put` creates a draft Worker. So the secrets come first. On
Brian's machine, in a checkout of this repository, after `npm ci` and
`npx wrangler login` with his own account:

```sh
npx wrangler secret put INTAKE_BEARER    # the shared bearer; the same value goes to caddy (step 6)
npx wrangler secret put GLITCHTIP_DSNS   # JSON {"system": "<dsn>", "<app id>": "<dsn>"} (runbook/glitchtip.md)
npx wrangler secret put AE_READ_TOKEN    # the analytics read token of step 2.4
npx wrangler secret put CF_ACCOUNT_ID    # the frostyard account id (32 hex characters)
```

`wrangler secret put` reads each value from a prompt; the value is not in
the shell history. `INTAKE_BEARER` must be 16 to 512 printable ASCII
characters (for example `openssl rand -hex 32`); a shorter value makes every
forward fail with class `config`.

## 5. First deploy

Merge the KV PR (step 2.1). The push to `main` runs the deploy workflow:
`npm ci`, `make check`, `wrangler deploy`. Then check:

- `curl -s https://report.frostyard.org/v1/health` answers the health
  document (or `no_data` before the first hourly run);
- `curl -s -o /dev/null -w '%{http_code}\n' https://report.frostyard.org/` is
  404;
- the Worker's Observability tab shows no logs (they are off).

## 6. caddy and DNS (Teg, t17)

- DNS: `report.frostyard.org` comes from the Worker's custom domain (the
  deploy creates it). `intake.ketelsen.cloud` (the existing 443 forward to
  caddy) and the LAN-only GlitchTip UI name are Teg's records.
- caddy's env file gets the same bearer as `INTAKE_BEARER`, under the name
  that Teg's Caddyfile reads. caddy compares it, then strips `Authorization`
  before upstream (GlitchTip reads a `Bearer` value as a DSN key), and strips
  `X-Forwarded-For`, `CF-Connecting-IP`, `True-Client-IP` and `X-Real-IP`.

## Troubleshooting the deploy

- **"No access to the specified service"** on
  `/accounts/<id>/workers/services/problem-intake`: the deploy token cannot
  reach the account. Its Account Resources must include the account of
  `CLOUDFLARE_ACCOUNT_ID`, with Workers Scripts Edit (step 2.3). Check that
  `CLOUDFLARE_ACCOUNT_ID` is the account that the token names.
- **Code 10089 "You need to enable Analytics Engine"** (bindings `REPORTS`
  and `HEALTH`): enable Workers Analytics Engine on the account (step 2.2).
  The enablement can take a few minutes to apply: wait about 5 minutes, then
  re-run the failed job. At the go-live (2026-11-05), the deploy at 20:01Z
  still failed with 10089 after the enablement, and the re-run at 20:04Z
  passed with no change.

## Kill switch

Set `KILL_SWITCH` to `on` in the Cloudflare dashboard (Worker → Settings →
Variables) for an immediate stop; the next deploy resets it to the value in
`wrangler.jsonc`. For a lasting stop, change `wrangler.jsonc` by PR. Any value
other than `off` answers 503.

## Rotate a secret

Run `npx wrangler secret put <NAME>` again. For `INTAKE_BEARER`, change
caddy's env file at the same time; between the 2 changes forwards fail with
`4xx` and senders retry the next day.

## References

- Context: [design/intake.md](../design/intake.md)
- GlitchTip: [glitchtip.md](glitchtip.md)
- Rationale: [ADR-0003](../adr/0003-intake-worker-validates-strips-and-forwards.md)
