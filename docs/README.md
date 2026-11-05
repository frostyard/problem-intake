# Documentation

Docs are split by the question they answer:

| Directory | Question | Contents |
| --- | --- | --- |
| [adr/](adr/) | **Why** did we choose this? | Architecture Decision Records — immutable once accepted; superseded, never edited |
| [design/](design/) | **How** does it fit together? | Living documents describing the current architecture |
| [specs/](specs/) | **What exactly** is the contract? | Precise, testable interface definitions |
| [plans/](plans/) | **When/in what order** do we build? | Roadmaps and phase plans; updated as work lands |
| [runbook/](runbook/) | **How do I operate it?** | Host steps for Brian and the operators |

## Index

### Decisions (ADRs)

- [0001 — Record architecture decisions](adr/0001-record-architecture-decisions.md)
- [0002 — Agent-portable instruction surface](adr/0002-agent-portable-instruction-surface.md)
- [0003 — The intake Worker validates, strips and forwards problem reports](adr/0003-intake-worker-validates-strips-and-forwards.md)
- [0004 — GlitchTip reads its secrets from an env file and keeps data 72 days](adr/0004-glitchtip-env-file-and-72-day-retention.md)

### Design

- [Problem intake](design/intake.md)

### Specs

- [The intake HTTP API](specs/intake-api.md)
- [Analytics Engine data points](specs/analytics-points.md)
- [Weekly aggregates, frostyard.problem-stats/1](specs/stats.md)

### Plans

*(none yet: the plan is frostyard plan T857, task t15)*

### Runbooks

- [Deploy the Worker](runbook/deploy.md)
- [GlitchTip on TrueNAS](runbook/glitchtip.md)

## Conventions

- **New docs start from their category's `TEMPLATE.md`** (in each directory).
- New decision → new ADR with the next number; if it reverses an old one, mark
  the old one `Superseded by NNNN` rather than editing it.
- Design docs are updated in place to always reflect reality.
- Specs change only alongside the code that implements them.
- Cross-links between categories are mandatory in both directions — see the
  documentation rules in [AGENTS.md](../AGENTS.md) (CLAUDE.md/GEMINI.md are
  symlinks to it, ADR-0002).
- Adding a doc means adding it to the index above.
