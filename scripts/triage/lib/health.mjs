// The health of the triage job (docs/specs/triage.md, "The publisher": health)
// — `health.json` in the state folder, the `heartbeat` file, and the public
// issue `Problem triage health` in frostyard/problem-intake. The public body
// holds the run status only: no day and no count.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeFileAtomic, writeJsonAtomic } from "./state.mjs";

export const HEALTH_SCHEMA = "frostyard.problem-triage-health/1";
export const HEALTH_FILE = "health.json";
export const HEARTBEAT_FILE = "heartbeat";
export const HEALTH_REPO = "frostyard/problem-intake";
export const HEALTH_TITLE = "Problem triage health";
export const LABEL = "problem-report";
export const RUNS_KEPT = 7;

// The reasons work waits for the next run.
export const DEFERRED_REASONS = Object.freeze(["new_issues", "comments", "budget", "deadline", "no_label", "recovery"]);

export const WATCHDOG_TEXT = "The triage job has not completed a run in the last 2 days.";
export const ROTATION_TEXT = "The GlitchTip read token is due for rotation.";

// The health document, with `last_read` and `issue_keys` as they are on disk
// (the reader owns those 2 keys).
export function readHealth(dir) {
  const doc = readJson(join(dir, HEALTH_FILE), null);
  const health = { schema: HEALTH_SCHEMA, runs: [], last_read: {}, issue_keys: {} };
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return health;
  if (Array.isArray(doc.runs)) health.runs = doc.runs.filter((run) => run !== null && typeof run === "object");
  if (doc.last_read !== null && typeof doc.last_read === "object" && !Array.isArray(doc.last_read)) health.last_read = doc.last_read;
  if (doc.issue_keys !== null && typeof doc.issue_keys === "object" && !Array.isArray(doc.issue_keys)) {
    health.issue_keys = doc.issue_keys;
  }
  return health;
}

// Writes `schema` and `runs` (the last 7), and keeps the other 2 keys.
export function writeHealth(dir, health) {
  writeJsonAtomic(join(dir, HEALTH_FILE), {
    schema: HEALTH_SCHEMA,
    runs: health.runs.slice(-RUNS_KEPT),
    last_read: health.last_read ?? {},
    issue_keys: health.issue_keys ?? {},
  });
}

// The run entry of health.json.
export function runEntry({ day, status, notes = [], held = {}, deferred = {}, rotationDue = false }) {
  const counts = {};
  for (const reason of DEFERRED_REASONS) {
    const count = deferred[reason] ?? 0;
    counts[reason] = Number.isSafeInteger(count) && count > 0 ? count : 0;
  }
  return { day, status, notes: [...notes], held: { ...held }, deferred: counts, rotation_due: rotationDue === true };
}

// True when any reason holds a count.
export function workDeferred(entry) {
  return Object.values(entry?.deferred ?? {}).some((count) => count > 0);
}

// The public body of the health issue. No digit and no day.
export function healthBody({ status, notes = [], rotationDue = false, deferred = null }) {
  const note = notes.length === 0 ? "none" : notes.join(", ");
  const deferredText = deferred === null ? false : Object.values(deferred).some((count) => count > 0);
  return [
    "Operational status of the problem-intake triage job. The job rewrites this text on each run. It holds no day and no count.",
    "",
    `- run status: ${status}`,
    `- run notes: ${note}`,
    `- token rotation due: ${rotationDue ? "yes" : "no"}`,
    `- work deferred: ${deferredText ? "yes" : "no"}`,
  ].join("\n");
}

// The `heartbeat` file: the UTC day of the last completed run.
export function readHeartbeat(dir) {
  let text;
  try {
    text = readFileSync(join(dir, HEARTBEAT_FILE), "utf8");
  } catch {
    return null;
  }
  const day = text.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function writeHeartbeat(dir, day) {
  writeFileAtomic(join(dir, HEARTBEAT_FILE), `${day}\n`);
}

// The whole days from `from` to `to`, both `YYYY-MM-DD`.
export function daysBetween(from, to) {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

// The open issue `Problem triage health`, or null.
export async function findHealthIssue(github) {
  const issues = await github.api(
    `repos/${HEALTH_REPO}/issues?state=open&creator=frostyard-machines&labels=${LABEL}&per_page=100`,
  );
  if (!Array.isArray(issues)) return null;
  return issues.find((issue) => issue?.title === HEALTH_TITLE) ?? null;
}

export async function createHealthIssue(github, body) {
  return github.api(`repos/${HEALTH_REPO}/issues`, {
    method: "POST",
    body: { title: HEALTH_TITLE, body, labels: [LABEL] },
  });
}

export async function setIssueBody(github, repo, number, body) {
  return github.api(`repos/${repo}/issues/${number}`, { method: "PATCH", body: { body } });
}

export async function createComment(github, repo, number, body) {
  return github.api(`repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body } });
}

// The newest comment of the machine account on an issue, or null.
export function newestMachineComment(comments) {
  let newest = null;
  for (const comment of comments ?? []) {
    if (comment?.author?.login !== "frostyard-machines") continue;
    if (newest === null || String(comment.createdAt ?? "") > String(newest.createdAt ?? "")) newest = comment;
  }
  return newest;
}
