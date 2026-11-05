# problem-intake

The Cloudflare Worker that takes opt-in problem reports from frostyard
images (schema `frostyard.problem/1`), drops the client address, forwards
each problem to a self-hosted GlitchTip, and publishes weekly aggregates with
small cells suppressed. It also holds the GlitchTip Compose file and its
runbooks. Owner: Murbella. Start at [docs/README.md](docs/README.md).

This file (`AGENTS.md`) is the CANONICAL agent instructions — `CLAUDE.md`,
`GEMINI.md`, and `.github/copilot-instructions.md` are symlinks to it, and
`.claude/skills` symlinks to `.agents/skills/`
([ADR-0002](docs/adr/0002-agent-portable-instruction-surface.md)). Edit only
the canonical paths; keep content tool-agnostic.

## Commands

- `make verify`: tools present (Node 24 from `mise.toml`), `npm ci` done,
  `.memory/corrections.jsonl` valid.
- `make check`: `make verify`, then `npm run check`: `tsc`, `wrangler types
  --check`, the generated-validator drift check, the node tests
  (`test/node/`), vitest with coverage (`test/*.test.ts`, in workerd), and
  `wrangler deploy --dry-run` into a temporary folder.
- `make ci BASE=origin/main`: `make check` plus the append-only check of
  `.memory/corrections.jsonl` against `BASE`. CI job `ci` runs it.
- `npm run build:validator`: regenerate `src/generated/validate-v1.js` from
  `schema/v1.json`.

Run `make ci BASE=origin/main` before you call any change done.

## Hard rules (privacy)

These are tested; never weaken a test to pass a change.

- **No IP.** `src/` reads only `Content-Type`, `Content-Length` and
  `CF-Connecting-IP`, and `CF-Connecting-IP` only in `src/report.ts` as the
  rate-limit key. Never read another header, `request.cf`, or store, log or
  forward the address (`test/node/privacy-scan.test.mjs`).
- **No logs.** No `console` in `src/`. Observability, logs, traces and
  Logpush stay off in `wrangler.jsonc` (`test/node/wrangler-config.test.mjs`).
- **No secret in Git.** Secrets are Worker secrets (`INTAKE_BEARER`,
  `GLITCHTIP_DSNS`, `AE_READ_TOKEN`, `CF_ACCOUNT_ID`) or GitHub environment
  secrets. Tests use obvious fakes (`test-…-not-a-real-secret`,
  `*.test.invalid`). The Compose file takes secrets only as `${NAME:?}`.
- **New request, no copy.** The forward to GlitchTip is a request built new
  in `src/forward.ts`, with exactly 3 headers. Never pass or clone the
  incoming request or its headers.
- **Schema copy.** `schema/v1.json` is a byte copy of frostyard/core
  `docs/specs/schemas/problem-report/v1.json`; its sha256 is pinned in
  `test/node/schema-and-envelope.test.mjs` to the value that core's test pins.
  Never edit it; a new version is a new file.
- **Aggregates.** Never publish a value from 1 to 4; keep complementary
  suppression (`src/suppress.ts`, `test/suppress.test.ts`).

## Code conventions (live)

- The Worker is at the repository root: `src/index.ts` routes,
  `src/report.ts` handles `POST /v1/report`, `src/forward.ts` forwards,
  `src/envelope.ts` builds the event, `src/jobs.ts` runs the crons.
- Imports inside `src/` use the `.ts` extension, and `src/envelope.ts` and
  its imports use only erasable TypeScript: Node 24 imports it directly in
  `scripts/glitchtip-send-event.mjs`.
- Error bodies are fixed JSON from `src/http.ts`; never echo the request.
- vitest runs in workerd and cannot read host files; a test that reads files
  (privacy scan, config and Compose pins, schema pin) is a `node --test` file
  in `test/node/`.
- Mock every outgoing request in vitest (`mockFetch` in `test/helpers.ts`);
  no test reaches the network.
- Scripts are shellcheck-clean; scratch files use `mktemp`.

**Deploy order.** The Worker accepts a schema version before any sender
release uses it (core spec rule 6). A new schema version adds a schema file,
a generated validator and a pin in 1 PR, and that PR deploys first.

**Test reliability.** No sleeps for timing. No network and no wall clock in
unit tests (the jobs take `now` as an argument). A flaky test gets an issue,
then a fix or a quarantine in the same PR.

**Blocker to guard.** When a review finds a blocking point, the PR that
fixes it also adds a guard: a targeted test that fails without the fix, or an
`AGENTS.md` rule when no test can catch it, and 1 line in
`.memory/corrections.jsonl` ([.memory/README.md](.memory/README.md)).

**Risk paths.** [.github/risk-paths.json](.github/risk-paths.json) lists the
high-risk paths; each `why` names 1 protected boundary of
[policies/agent-governance.json](policies/agent-governance.json). A PR that
touches one gets `risk:high` from `.github/workflows/risk-paths-caller.yml`
and declares tier 3; its body names each matched path and why the change is
safe. The paths: the list, the policy, `.github/workflows/**`,
`wrangler.jsonc`, `glitchtip/compose.yaml`, `src/forward.ts`, `src/sql.ts`,
`src/report.ts`, `scripts/glitchtip-delete-report.sh`, `Makefile`,
`scripts/check-*.mjs`, `scripts/lib/**`, `test/node/privacy-scan.test.mjs`.

**Vendored files.** `scripts/lib/risk-paths.mjs` and
`scripts/check-corrections.mjs` are copies from frostyard/core; never edit
them by hand (`test/node/repo.test.mjs` pins their sha256).

## Repository boundary

- No deploy from a workstation: `.github/workflows/deploy.yml` deploys from
  `main`. Agents never run `wrangler deploy` without `--dry-run`, never run
  `wrangler login`, and never set a secret.
- The GlitchTip app itself, its dataset and snapshots live on TrueNAS
  (Moneo); caddy lives in bketelsen/fleet (Teg).
- No raw report data, DSN, token or address in this repository, an issue or a
  PR.

## Documentation rules (enforced)

Docs live in `docs/` in four categories plus runbooks. **Every new doc
starts from its category's `TEMPLATE.md`**. Every doc has a line in
[docs/README.md](docs/README.md), and relative links must resolve
(`test/node/repo.test.mjs`). ADRs state facts only (core ADR-0051): context,
decision, consequences. Cross-links are mandatory in both directions: an ADR
links the design docs and specs it shapes; a design doc links its ADRs and
specs; a spec links its ADR and design doc. Convert relative dates to
absolute dates.
