# Security

If you believe you have found a security vulnerability in
frostyard/problem-intake, report it privately.

## Supported versions

problem-intake holds the Cloudflare Worker that takes opt-in problem reports
from frostyard images, and the GlitchTip Compose file and runbooks for the
store they are forwarded to. It has no releases:
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys the
Worker from `main`.

| What | Gets security fixes |
| --- | --- |
| The deployed Worker, built from `main` | Yes: a fix merges to `main` and the deploy workflow ships it |
| The Compose file at `main` | Yes: a fix merges to `main`; an operator applies it with the [GlitchTip runbook](docs/runbook/glitchtip.md) |
| Older commits and other branches | No |

The senders are not part of this repository. Report a vulnerability in the
chairlift sender to
[frostyard/chairlift](https://github.com/frostyard/chairlift/security), and one
in the snosi sender to [frostyard/snosi](https://github.com/frostyard/snosi/security).

## Reporting a vulnerability

- Do **not** report security vulnerabilities through public GitHub issues.
- Use GitHub private vulnerability reporting for this repository:
  <https://github.com/frostyard/problem-intake/security> (the **Report a
  vulnerability** button on the Security tab).
- If that button is not available, email the project maintainer at
  [bketelsen@gmail.com](mailto:bketelsen@gmail.com). Use a subject such as
  `[problem-intake security] Brief description`.

The **New draft security advisory** page is a maintainer workflow and is not a
fallback reporting channel for people without repository write access.

## Guidelines

- Include the affected endpoint or runbook step, the commit, the impact, and
  complete reproduction steps when possible.
- Never send a report ID that belongs to another person, a DSN, a token, an IP
  address or raw report data. A report holds the content a user chose to send;
  it does not belong in a public issue, a pull request or a vulnerability
  report.
- Do not send credentials, tokens, or private host details.
- Do not send scripts that download and run binaries.
- We prioritize reports that demonstrate realistic impact.
- We do not offer financial rewards. We are happy to acknowledge your research
  publicly when possible.
