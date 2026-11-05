<!-- The repository owner (Murbella) reviews risk:high pull requests. Branch
from the latest main. Never paste a secret, a DSN, a token, an address or a
raw report here. -->

## Summary

<!-- What changes and why, in a few sentences. Link the plan item or issue. -->

## Risk tier

Declare the highest applicable tier, never lower. A `risk:high` label (a path in `.github/risk-paths.json`) means tier 3.

Scale: 1 low = docs, tests, comments; 2 medium = behaviour change in code; 3 high = privacy, secrets, data deletion, publishing or deploy, CI and permissions, or any `risk:high` label.

Risk tier: 1 — <!-- justification -->

<!-- For tier 3: name each matched risk path and why the change is safe. -->

## Privacy

- [ ] No new header, `request.cf` or client data is read; no `console` in `src/` (privacy scan green)
- [ ] No secret, DSN, token or real address in the diff, the tests or this PR
- [ ] Schema copy unchanged, or a new schema version deploys before any sender uses it

## Docs housekeeping

<!-- Delete rows that do not apply. -->

- [ ] New docs started from their category's `TEMPLATE.md`
- [ ] Every new doc indexed in `docs/README.md`
- [ ] Cross-links added in both directions (ADR ↔ design ↔ spec)
- [ ] New or edited ADRs are fact-only: context, decision and consequences

## Verification

<!-- Paste evidence for every applicable gate. -->

- [ ] `make ci BASE=origin/main` green
- [ ] Revert proof: the new test fails with the fix reverted; command and failing test: <!-- name them -->
- [ ] Workflows changed: every action is SHA-pinned with `# vX.Y.Z`, `permissions: {}`, and `persist-credentials: false`
- [ ] Blocking review point fixed: guard added and 1 `.memory/corrections.jsonl` line added
