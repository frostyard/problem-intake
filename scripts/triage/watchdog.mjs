#!/usr/bin/env node
// The triage watchdog (docs/specs/triage.md, "The publisher": watchdog). It
// reads `heartbeat` and, when no run completed for more than 2 days, adds 1
// comment to the public health issue. It runs also when the main timer never
// started, so a dead job is visible. Operational text only: no day, no count.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "./lib/config.mjs";
import { createGitHub, GitHubError } from "./lib/github.mjs";
import * as health from "./lib/health.mjs";
import { utcDay } from "./lib/state.mjs";

const MAX_DAYS = 2;

function diagnostic(code) {
  process.stderr.write(`problem-triage-watchdog: ${code}\n`);
}

// Returns the exit code: 0 when the watchdog did its work (also when it had
// nothing to do), 2 for a refused configuration, 1 for an unexpected error.
export async function main({ now = new Date(), env = process.env } = {}) {
  const today = utcDay(now);
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      diagnostic("config");
      return 2;
    }
    throw error;
  }

  // A fresh heartbeat means the job ran: no request at all.
  const heartbeat = health.readHeartbeat(config.stateDir);
  const age = heartbeat === null ? null : health.daysBetween(heartbeat, today);
  if (age !== null && age <= MAX_DAYS) return 0;

  // 1 warning for each outage: the `watchdog` file holds the day of the last
  // 1. It suppresses this run when it is after the last completed run, and with
  // no heartbeat it suppresses every further run.
  const lastWarning = health.readWatchdog(config.stateDir);
  if (heartbeat === null ? lastWarning !== null : lastWarning !== null && lastWarning > heartbeat) return 0;

  let github;
  try {
    github = createGitHub({ env });
    const issue = await health.findHealthIssue(github);
    if (issue === null) {
      // No health issue to comment on: the publisher makes it on its next run.
      diagnostic("health_issue_missing");
      return 0;
    }
    // The crash guard: a warning of this outage on the issue is not repeated.
    // The read starts at the day after the last completed run, or at the last
    // warning with no heartbeat (and from the beginning with neither).
    let since = null;
    if (heartbeat !== null) since = `${health.dayShift(heartbeat, 1)}T00:00:00Z`;
    else if (lastWarning !== null) since = `${lastWarning}T00:00:00Z`;
    const comments = await health.commentsSince(github, issue.number, since);
    // An incomplete read cannot say that the warning is missing: none is sent.
    if (comments === null) return 0;
    if (health.hasMachineComment(comments, health.WATCHDOG_TEXT)) {
      health.writeWatchdog(config.stateDir, today);
      return 0;
    }
    await health.createComment(github, health.HEALTH_REPO, issue.number, health.WATCHDOG_TEXT);
    health.writeWatchdog(config.stateDir, today);
    return 0;
  } catch (error) {
    diagnostic(error instanceof GitHubError ? `github:${error.code}` : "run_failed");
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      diagnostic("run_failed");
      process.exitCode = 1;
    },
  );
}
