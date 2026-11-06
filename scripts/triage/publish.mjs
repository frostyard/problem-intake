#!/usr/bin/env node
// The triage publisher (docs/specs/triage.md, "The publisher" and "Close the
// loop"). It reads facts.json, files 1 public issue for each new problem key in
// the routed repository, follows a fix to its release, counts the covered days,
// and reopens the issue when a report comes back at or above the fix. It keeps
// the public health issue and the state files up to date.
//
// A stale or invalid facts.json, or a run that ends in an unexpected error, is
// diagnosed with a fixed string: no value of a report, no token, no response
// body, and no `console` output of `gh`.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ConfigError, loadConfig } from "./lib/config.mjs";
import { assertFacts } from "./lib/facts.mjs";
import { BudgetError, createGitHub, GitHubError } from "./lib/github.mjs";
import { assertIssueBody, assertPublicText, parseIssueBody, routeOf } from "./lib/issue.mjs";
import {
  compareSemver,
  countCoveredDay,
  formatBoundary,
  formatMarker,
  highestMarker,
  parseBoundary,
  parseFixedIn,
  parseMarker,
  qualifying,
  versionToken,
} from "./lib/loop.mjs";
import { emptyPublished, newEntry, readPublished, trackedKeys, writePublished } from "./lib/published.mjs";
import { ensureStateDir, StateError, utcDay } from "./lib/state.mjs";
import * as health from "./lib/health.mjs";
import { createSources, dayOf, SourceError } from "./lib/sources.mjs";

const MACHINE = "frostyard-machines";
const LABEL = "problem-report";
const IMAGE_REPO = "frostyard/snosi";
const CALL_LIMIT = 150;
const RESERVE = 6;
const MAX_NEW_ISSUES = 5;
const MAX_PER_REPO = 2;
const MAX_ACTIONS = 10;
const REGRESSION_SLOTS = 2;
const DEADLINE_MS = 10 * 60 * 1000;
const COVERED_DAYS = 14;
const ROTATION_DAY = 335;
const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-(alpha|beta|rc)\.(0|[1-9][0-9]{0,3}))?$/;
const IMAGE_VERSION = /^[0-9]{14}$/;

// A fixed diagnostic line. Never a value of facts, a token or a response body.
function diagnostic(code) {
  process.stderr.write(`problem-triage: ${code}\n`);
}

function errorCode(error) {
  if (error instanceof ConfigError) return `config:${error.code}`;
  if (error instanceof StateError) return `state:${error.code}`;
  if (error instanceof GitHubError) return `github:${error.code}${error.status === null ? "" : `:${error.status}`}`;
  if (error instanceof SourceError) return "source:source_unavailable";
  return "run_failed";
}

// The facts document of this run, or the reason there is none.
function readFacts(dir, today) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(dir, "facts.json"), "utf8"));
  } catch (error) {
    return { facts: null, reason: error?.code === "ENOENT" ? "no_facts" : "invalid_facts" };
  }
  try {
    assertFacts(doc);
  } catch {
    return { facts: null, reason: "invalid_facts" };
  }
  // A document of another day is stale: it must not drive a second run today.
  if (doc.run.day !== today) return { facts: null, reason: "stale_facts" };
  return { facts: doc, reason: null };
}

// 1 more unit of deferred work of a reason.
function defer(run, reason) {
  const code = health.DEFERRED_REASONS.includes(reason) ? reason : "recovery";
  run.deferred[code] = (run.deferred[code] ?? 0) + 1;
}

// The gate of the loop work: the call budget keeps 6 calls for the health
// issue, and the run stops after 10 minutes.
function gate(run) {
  if (run.stopped !== null) return false;
  if (run.github.overSoft()) {
    run.stopped = "budget";
    return false;
  }
  if (run.clock() > run.deadlineAt) {
    run.stopped = "deadline";
    return false;
  }
  return true;
}

function utcStamp(timestamp) {
  if (typeof timestamp !== "string") return null;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  return new Date(time).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function versionOfTag(tag) {
  if (typeof tag !== "string") return null;
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  return SEMVER.test(version) ? version : null;
}

// The newest observation version of an app problem (semver precedence).
function appVersionOf(problem) {
  const versions = problem.observations.map((o) => o.version).filter((v) => SEMVER.test(v));
  versions.sort(compareSemver);
  return versions.at(-1) ?? null;
}

// Each image of the problem with its newest observation version, sorted by id.
function imagesOf(problem) {
  const newest = new Map();
  for (const observation of problem.observations) {
    if (!IMAGE_VERSION.test(String(observation.version))) continue;
    const seen = newest.get(observation.image);
    if (seen === undefined || Number(observation.version) > Number(seen)) newest.set(observation.image, observation.version);
  }
  return [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, version]) => ({ id, version }));
}

// The problem order of the reader's fair order: oldest first_seen_day, then key.
function compareProblems(a, b) {
  if (a.first_seen_day !== b.first_seen_day) return a.first_seen_day < b.first_seen_day ? -1 : 1;
  return a.key < b.key ? -1 : 1;
}

export async function main({ now = new Date(), env = process.env, hooks = {} } = {}) {
  const today = utcDay(now);
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      diagnostic(errorCode(error));
      return 2;
    }
    throw error;
  }
  try {
    ensureStateDir(config.stateDir);
  } catch (error) {
    diagnostic(errorCode(error));
    return 1;
  }
  const clock = () => (typeof hooks.clock === "function" ? hooks.clock() : Date.now());
  const Budget = Number.isSafeInteger(hooks.limit) ? hooks.limit : CALL_LIMIT;
  const run = {
    dir: config.stateDir,
    config,
    today,
    env,
    hooks,
    clock,
    deadlineAt: clock() + DEADLINE_MS,
    github: createGitHub({
      env,
      limit: Budget,
      softLimit: Math.max(0, Budget - RESERVE),
    }),
    sources: createSources({ config }),
    deferred: {},
    stopped: null,
    actions: 0,
    releases: new Map(),
    compares: new Map(),
    info: new Map(),
    fresh: new Set(),
    health: health.readHealth(config.stateDir),
  };
  try {
    return await publish(run);
  } catch (error) {
    diagnostic(errorCode(error));
    return 1;
  }
}

async function publish(run) {
  const read = readFacts(run.dir, run.today);
  if (read.facts === null) return await staleRun(run, read.reason);
  const facts = read.facts;

  let published = null;
  try {
    published = readPublished(run.dir);
  } catch (error) {
    if (!(error instanceof StateError)) throw error;
  }
  if (published === null) published = await rebuild(run);

  // The loop work stops at its soft limit and goes on to the health issue:
  // the reserved calls are the health issue's.
  await stopOnBudget(run, () => sync(run, published));
  applyIssueIds(run, published, facts);
  writePublished(run.dir, published);

  await stopOnBudget(run, () => loop(run, published, facts));
  await stopOnBudget(run, () => fileNew(run, published, facts));

  run.github.raiseBudget();
  const previous = run.health.runs.at(-1) ?? null;
  const rotationDue =
    facts.run.token_age_days === null ? previous?.rotation_due === true : facts.run.token_age_days >= ROTATION_DAY;
  const entry = health.runEntry({
    day: run.today,
    status: facts.run.status,
    notes: facts.run.notes,
    held: facts.held,
    deferred: run.deferred,
    rotationDue,
  });
  const body = health.healthBody({
    status: facts.run.status,
    notes: facts.run.notes,
    rotationDue,
    deferred: entry.deferred,
  });
  assertPublicText(body, { noDigits: true });
  await syncHealthIssue(run, body, previous, entry);

  run.health.runs.push(entry);
  health.writeHealth(run.dir, run.health);
  writePublished(run.dir, published);
  health.writeHeartbeat(run.dir, run.today);
  return 0;
}

// Stale or invalid facts: the health issue only, no loop step, no covered day.
async function staleRun(run, reason) {
  const previous = run.health.runs.at(-1) ?? null;
  const rotationDue = previous?.rotation_due === true;
  const entry = health.runEntry({
    day: run.today,
    status: "error",
    notes: [reason],
    held: {},
    deferred: run.deferred,
    rotationDue,
  });
  const body = health.healthBody({ status: "error", notes: entry.notes, rotationDue, deferred: entry.deferred });
  assertPublicText(body, { noDigits: true });
  await syncHealthIssue(run, body, previous, entry);
  run.health.runs.push(entry);
  health.writeHealth(run.dir, run.health);
  health.writeHeartbeat(run.dir, run.today);
  return 0;
}

// Runs 1 phase of the loop work. A call over the soft limit ends that phase
// and counts the rest deferred, so the health issue is still written.
async function stopOnBudget(run, phase) {
  try {
    await phase();
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error;
    run.stopped = run.stopped ?? "budget";
    defer(run, "budget");
  }
}

async function syncHealthIssue(run, body, previous, entry) {
  let issue = await health.findHealthIssue(run.github);
  if (issue === null) {
    issue = await health.createHealthIssue(run.github, body);
    run.hooks.afterAction?.("health-create");
  } else if (issue.body !== body) {
    await health.setIssueBody(run.github, health.HEALTH_REPO, issue.number, body);
    run.hooks.afterAction?.("health-body");
  }
  if (previous !== null && previous.status === "ok" && entry.status !== "ok") {
    await health.createComment(
      run.github,
      health.HEALTH_REPO,
      issue.number,
      `The triage job run status changed from ok to ${entry.status}.`,
    );
    run.hooks.afterAction?.("health-comment");
  }
  if (entry.rotation_due === true && previous?.rotation_due !== true) {
    await health.createComment(run.github, health.HEALTH_REPO, issue.number, health.ROTATION_TEXT);
    run.hooks.afterAction?.("health-rotation");
  }
}

// published.json is lost: the state comes back from the job's own issues. The
// markers of each issue set the cycle, the state and the boundary in sync().
async function rebuild(run) {
  const doc = emptyPublished();
  const hits = await run.github.searchIssues('"Problem key:"');
  for (const hit of hits ?? []) {
    const repo = hit?.repository?.nameWithOwner;
    if (typeof repo !== "string") continue;
    if (!Number.isSafeInteger(hit?.number)) continue;
    const parsed = parseIssueBody(hit?.body ?? "");
    if (parsed === null) continue;
    if (doc.keys[parsed.key] !== undefined) continue;
    doc.keys[parsed.key] = newEntry({ repo, number: hit.number });
    run.fresh.add(parsed.key);
  }
  writePublished(run.dir, doc);
  return doc;
}

const ISSUE_FIELDS = [
  "number",
  "state",
  "stateReason",
  "url",
  "repository { nameWithOwner }",
  "author { login }",
  "body",
  "labels(first: 20) { nodes { name } }",
  "comments(last: 100) { nodes { author { login } authorAssociation body createdAt } }",
  "timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { createdAt closer { __typename ... on PullRequest { mergeCommit { oid } } ... on Commit { oid } } } } }",
].join("\n");

function fullQuery(repo, numbers) {
  const aliases = numbers.map((number) => `i${number}: issue(number: ${number}) {\n${ISSUE_FIELDS}\n}`).join("\n");
  return [
    "query($owner: String!, $name: String!) {",
    "  repository(owner: $owner, name: $name) {",
    aliases,
    "  }",
    "}",
  ].join("\n");
}

// The state of each tracked issue from its markers, and from the issue itself.
async function sync(run, published) {
  const groups = new Map();
  for (const key of trackedKeys(published)) {
    const entry = published.keys[key];
    const list = groups.get(entry.repo) ?? [];
    list.push(key);
    groups.set(entry.repo, list);
  }
  for (const [repo, keys] of groups) {
    if (!gate(run)) {
      defer(run, run.stopped);
      break;
    }
    const numbers = keys.map((key) => published.keys[key].number).sort((a, b) => a - b);
    const [owner, name] = repo.split("/");
    const data = await run.github.graphql(fullQuery(repo, numbers), { owner, name });
    for (const key of keys) {
      await syncKey(run, published, key, data?.repository?.[`i${published.keys[key].number}`] ?? null);
    }
    writePublished(run.dir, published);
  }
  writePublished(run.dir, published);
}

async function syncKey(run, published, key, node) {
  const entry = published.keys[key];
  if (node === null || node === undefined) {
    await relocate(run, published, key, entry);
    return;
  }
  const parsed = parseIssueBody(node.body ?? "");
  const labels = (node.labels?.nodes ?? []).map((label) => label?.name);
  if (parsed === null || parsed.key !== key || node.author?.login !== MACHINE || !labels.includes(LABEL)) {
    // Not this job's record: never acted on again.
    delete published.keys[key];
    run.info.delete(key);
    return;
  }
  const comments = (node.comments?.nodes ?? []).filter((comment) => comment !== null && typeof comment === "object");
  const markers = [];
  for (const comment of comments) {
    if (comment.author?.login !== MACHINE) continue;
    const first = String(comment.body ?? "").split(/\r?\n/)[0];
    const marker = parseMarker(first);
    if (marker !== null && marker.key === key) markers.push(marker);
  }
  // The markers are the truth: the highest 1 sets the cycle, the boundary and
  // the marker of the entry. A different step (higher or lower) means lost
  // progress, and lost progress is reset, never guessed.
  const best = highestMarker(markers);
  const recorded = entry.last_comment_marker === null ? null : parseMarker(entry.last_comment_marker);
  const sameStep = best !== null && recorded !== null && best.cycle === recorded.cycle && best.step === recorded.step;
  if (best !== null) {
    entry.cycle = best.cycle;
    entry.last_comment_marker = best.marker;
    entry.boundary = best.step === "released" || best.step === "verified" ? best.boundary : null;
  }
  if (run.fresh.has(key) || (best !== null && !sameStep)) {
    entry.covered_days = 0;
    entry.last_counted_day = null;
    entry.released_day = null;
    entry.feature_index = null;
  }

  const closedEvent = node.timelineItems?.nodes?.[0] ?? null;
  const closer = closedEvent?.closer ?? null;
  const info = {
    body: String(node.body ?? ""),
    comments,
    closed: String(node.state ?? "").toLowerCase() === "closed",
    stateReason: node.stateReason ?? null,
    closedAt: closedEvent?.createdAt ?? node.closedAt ?? null,
    closerSha: closer?.mergeCommit?.oid ?? closer?.oid ?? null,
  };
  run.info.set(key, info);

  const step = entry.last_comment_marker === null ? null : parseMarker(entry.last_comment_marker)?.step ?? null;
  if (info.closed && (info.stateReason === "NOT_PLANNED" || info.stateReason === "DUPLICATE")) {
    entry.state = "muted";
  } else if (step === "released") {
    entry.state = "released";
  } else if (step === "verified") {
    entry.state = "verified";
  } else if (info.closed && (info.stateReason === "COMPLETED" || info.stateReason === null)) {
    entry.state = "merged";
  } else {
    entry.state = "filed";
  }

  // A tracked issue with no filed marker (a crash after the create) gets it.
  if (entry.last_comment_marker === null && !info.closed) {
    const marker = formatMarker({ key, cycle: entry.cycle, step: "filed", boundary: null });
    await postComment(run, published, entry, marker, null);
    return;
  }

  // The release day and the feature index of a released or verified key come
  // from the public source (spec "Recovery"). A failed read keeps the key in
  // recovery: no progress and no comment this run.
  if ((entry.state === "released" || entry.state === "verified") && entry.released_day === null) {
    await restoreReleased(run, entry);
  }
}

// An issue that did not come back from the GraphQL query may have moved: 1
// search finds it again and updates repo and number.
async function relocate(run, published, key, entry) {
  const hits = await run.github.searchIssues(`"Problem key: ${key}"`);
  const hit = (hits ?? []).find((item) => String(item?.body ?? "").includes(`Problem key: ${key}`));
  const repo = hit?.repository?.nameWithOwner;
  if (typeof repo !== "string" || !Number.isSafeInteger(hit?.number)) return;
  entry.repo = repo;
  entry.number = hit.number;
  writePublished(run.dir, published);
}

// The public source of the released day of a boundary. Sets released_day and
// feature_index; on a failed read it leaves released_day null.
async function restoreReleased(run, entry) {
  const boundary = parseBoundary(entry.boundary ?? "");
  if (boundary === null) {
    entry.released_day = null;
    entry.feature_index = null;
    return false;
  }
  try {
    if (boundary.type === "app") {
      const releases = await releasesOf(run, entry.repo);
      const release = releases.find((item) => versionOfTag(item.tag_name) === boundary.version) ?? null;
      const day = dayOf(release?.published_at ?? null);
      if (day === null) {
        entry.released_day = null;
        return false;
      }
      entry.released_day = day;
      entry.feature_index = null;
      return true;
    }
    if (boundary.type === "image") {
      let latest = null;
      for (const image of boundary.images) {
        const labels = await run.sources.imageLabels(image.id, image.version);
        const day = dayOf(labels.created);
        if (day === null) {
          entry.released_day = null;
          return false;
        }
        if (latest === null || day > latest) latest = day;
      }
      entry.released_day = latest;
      entry.feature_index = null;
      return true;
    }
    // A feature boundary: no public source keeps the old day, so the recovery
    // day is the released day and the index list of that day is kept.
    const versions = await run.sources.featureVersions(boundary.name);
    entry.released_day = run.today;
    entry.feature_index = versions;
    return true;
  } catch (error) {
    if (error instanceof SourceError) {
      entry.released_day = null;
      entry.feature_index = null;
      defer(run, "recovery");
      return false;
    }
    throw error;
  }
}

async function releasesOf(run, repo) {
  if (run.releases.has(repo)) return run.releases.get(repo);
  const answer = await run.github.api(`repos/${repo}/releases?per_page=100`);
  const list = (Array.isArray(answer) ? answer : []).filter(
    (item) =>
      item !== null &&
      typeof item === "object" &&
      item.draft !== true &&
      item.prerelease !== true &&
      typeof item.tag_name === "string" &&
      typeof item.published_at === "string",
  );
  run.releases.set(repo, list);
  return list;
}

async function compareStatus(run, repo, base, head) {
  const id = `${repo}:${base}...${head}`;
  if (run.compares.has(id)) return run.compares.get(id);
  let status = null;
  try {
    const answer = await run.github.api(`repos/${repo}/compare/${base}...${head}`);
    status = typeof answer?.status === "string" ? answer.status : null;
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) status = null;
    else throw error;
  }
  run.compares.set(id, status);
  return status;
}

function containsFix(status) {
  return status === "ahead" || status === "identical";
}

// The fix boundary of an app problem: the oldest release of the repository
// whose tag contains the fix commit.
async function appBoundary(run, entry, info) {
  const releases = await releasesOf(run, entry.repo);
  const closeAt = info.closedAt ?? null;
  const candidates = releases
    .filter((item) => closeAt === null || Date.parse(item.published_at) >= Date.parse(closeAt))
    .slice()
    .sort((a, b) => (a.published_at < b.published_at ? -1 : a.published_at > b.published_at ? 1 : 0));
  for (const release of candidates) {
    const version = versionOfTag(release.tag_name);
    const day = dayOf(release.published_at);
    if (version === null || day === null) continue;
    if (info.closerSha === null) return { boundary: { type: "app", version }, releasedDay: day };
    const status = await compareStatus(run, entry.repo, info.closerSha, release.tag_name);
    if (containsFix(status)) return { boundary: { type: "app", version }, releasedDay: day };
  }
  return null;
}

// The fix boundary of a system problem: for each image, the oldest tag that
// contains the fix commit. Every image must have 1, else the key waits.
async function imageBoundary(run, info, images) {
  if (images.length === 0) return null;
  const stamp = utcStamp(info.closedAt);
  const found = [];
  for (const image of images) {
    const tags = await run.sources.listTags(image.id);
    const candidates = tags
      .filter((tag) => IMAGE_VERSION.test(tag) && (stamp === null || tag >= stamp))
      .sort((a, b) => (Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0));
    let hit = null;
    for (const tag of candidates) {
      const labels = await run.sources.imageLabels(image.id, tag);
      if (info.closerSha === null) {
        if (labels.created !== null && info.closedAt !== null && Date.parse(labels.created) >= Date.parse(info.closedAt)) {
          hit = { id: image.id, version: tag, day: dayOf(labels.created) };
          break;
        }
        continue;
      }
      if (labels.sourceSha === null) continue;
      const status = await compareStatus(run, IMAGE_REPO, info.closerSha, labels.sourceSha);
      if (containsFix(status)) {
        hit = { id: image.id, version: tag, day: dayOf(labels.created) };
        break;
      }
    }
    if (hit === null) return null;
    found.push(hit);
  }
  const days = found.map((item) => item.day).filter((day) => day !== null).sort();
  if (days.length !== found.length) return null;
  return {
    boundary: { type: "image", images: found.map(({ id, version }) => ({ id, version })) },
    releasedDay: days.at(-1),
  };
}

// The `Fixed in:` boundary of a sysext problem or of an issue that moved to
// another repository.
async function fixedInBoundary(run, info) {
  const fixed = parseFixedIn(info.comments);
  if (fixed === null) return null;
  if (fixed.type === "image") {
    let latest = null;
    for (const image of fixed.images) {
      const labels = await run.sources.imageLabels(image.id, image.version);
      const day = dayOf(labels.created);
      if (day === null) return null;
      if (latest === null || day > latest) latest = day;
    }
    return { boundary: { type: "image", images: fixed.images }, releasedDay: latest };
  }
  const versions = await run.sources.featureVersions(fixed.name);
  if (!versions.includes(fixed.version)) return null;
  const day = dayOf(fixed.createdAt) ?? run.today;
  return { boundary: { type: "feature", name: fixed.name, version: fixed.version }, releasedDay: day, featureIndex: versions };
}

// The public comment of a step: the marker line first, then the text. The
// state is written after the hook, so a crash there repeats no action.
async function postComment(run, published, entry, marker, text) {
  const body = text === null ? marker : `${marker}\n\n${text}`;
  await run.github.api(`repos/${entry.repo}/issues/${entry.number}/comments`, { method: "POST", body: { body } });
  entry.last_comment_marker = marker;
  run.hooks.afterAction?.("comment");
  writePublished(run.dir, published);
}

async function reopen(run, published, entry) {
  await run.github.api(`repos/${entry.repo}/issues/${entry.number}`, { method: "PATCH", body: { state: "open" } });
  run.hooks.afterAction?.("reopen");
  writePublished(run.dir, published);
}

async function loop(run, published, facts) {
  const problems = new Map();
  for (const problem of facts.problems) problems.set(problem.key, problem);
  for (const key of trackedKeys(published)) {
    const entry = published.keys[key];
    const info = run.info.get(key);
    if (info === undefined) continue;
    if (entry.state === "muted" || entry.state === "filed") continue;
    if (!gate(run)) {
      defer(run, run.stopped);
      continue;
    }
    if (entry.state === "merged") await stepMerged(run, published, key, entry, info);
    else await stepWatching(run, published, key, entry, info, problems.get(key) ?? null, facts);
  }
  writePublished(run.dir, published);
}

async function stepMerged(run, published, key, entry, info) {
  const parsed = parseIssueBody(info.body);
  if (parsed === null) return;
  const routed = routeOf(parsed.kind, parsed.fields);
  const useFixedIn = parsed.kind === "sysext_update_failed" || routed === null || routed !== entry.repo;
  let found = null;
  try {
    if (useFixedIn) found = await fixedInBoundary(run, info);
    else if (parsed.kind === "app_problem") found = await appBoundary(run, entry, info);
    else found = await imageBoundary(run, info, parsed.images);
  } catch (error) {
    if (error instanceof SourceError) {
      defer(run, "recovery");
      return;
    }
    throw error;
  }
  if (found === null) return;
  if (run.actions + 1 > MAX_ACTIONS) {
    defer(run, "comments");
    return;
  }
  if (!gate(run)) {
    defer(run, run.stopped);
    return;
  }
  const boundary = formatBoundary(found.boundary);
  const marker = formatMarker({ key, cycle: entry.cycle, step: "released", boundary });
  const text = `Fix released in ${boundary}. The job now watches reports for 14 covered days.`;
  await postComment(run, published, entry, marker, text);
  run.actions += 1;
  entry.state = "released";
  entry.boundary = boundary;
  entry.released_day = found.releasedDay;
  entry.feature_index = found.featureIndex ?? null;
  entry.covered_days = 0;
  entry.last_counted_day = null;
  writePublished(run.dir, published);
}

async function stepWatching(run, published, key, entry, info, problem, facts) {
  if (entry.released_day === null) return;
  const boundary = parseBoundary(entry.boundary ?? "");
  const hit = boundary === null || problem === null ? null : qualifying(boundary, problem.observations, entry.released_day, entry.feature_index);
  if (hit !== null) {
    await stepRegressed(run, published, key, entry, info, boundary, hit);
    return;
  }
  if (entry.state !== "released") return;
  const watched = (facts.watched ?? []).find((item) => item.key === key) ?? null;
  if (countCoveredDay(entry, { runStatus: facts.run.status, watched, today: run.today })) {
    entry.covered_days += 1;
    entry.last_counted_day = run.today;
    writePublished(run.dir, published);
  }
  if (entry.covered_days < COVERED_DAYS) return;
  if (run.actions + 1 > MAX_ACTIONS) {
    defer(run, "comments");
    return;
  }
  if (!gate(run)) {
    defer(run, run.stopped);
    return;
  }
  const marker = formatMarker({ key, cycle: entry.cycle, step: "verified", boundary: entry.boundary });
  const text = `No qualifying reports observed in ${COVERED_DAYS} covered days after ${entry.boundary}.`;
  await postComment(run, published, entry, marker, text);
  run.actions += 1;
  entry.state = "verified";
  writePublished(run.dir, published);
}

async function stepRegressed(run, published, key, entry, info, boundary, observation) {
  if (run.actions + REGRESSION_SLOTS > MAX_ACTIONS) {
    defer(run, "comments");
    return;
  }
  if (!gate(run)) {
    defer(run, run.stopped);
    return;
  }
  // The entry changes only after the regressed comment landed, so a failed
  // comment repeats the comment, not a second cycle.
  const cycle = entry.cycle + 1;
  if (info.closed) {
    await reopen(run, published, entry);
    run.actions += 1;
  }
  const token = versionToken(boundary, observation);
  const marker = formatMarker({ key, cycle, step: "regressed", boundary: entry.boundary });
  const text = `Seen again in ${token}, at or after the fix release ${entry.boundary}.`;
  await postComment(run, published, entry, marker, text);
  run.actions += 1;
  entry.cycle = cycle;
  entry.state = "filed";
  entry.boundary = null;
  entry.released_day = null;
  entry.feature_index = null;
  entry.covered_days = 0;
  entry.last_counted_day = null;
  writePublished(run.dir, published);
}

// The GlitchTip issue ids of each tracked key: from health.json issue_keys and
// from the problem of the facts document.
function applyIssueIds(run, published, facts) {
  const byKey = new Map();
  for (const [id, key] of Object.entries(run.health.issue_keys ?? {})) {
    const number = Number(id);
    if (!Number.isSafeInteger(number) || typeof key !== "string") continue;
    const list = byKey.get(key) ?? [];
    list.push(number);
    byKey.set(key, list);
  }
  for (const problem of facts.problems) {
    const list = byKey.get(problem.key) ?? [];
    list.push(...problem.glitchtip_issue_ids);
    byKey.set(problem.key, list);
  }
  for (const [key, entry] of Object.entries(published.keys)) {
    // The ids of this run, and the ids the entry already holds: an id never
    // moves to another key, so a quiet run loses none.
    const list = [...(Array.isArray(entry.glitchtip_issue_ids) ? entry.glitchtip_issue_ids : []), ...(byKey.get(key) ?? [])];
    entry.glitchtip_issue_ids = [...new Set(list)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  }
}

async function labelPresent(run, repo, cache) {
  if (cache.has(repo)) return cache.get(repo);
  let present = false;
  try {
    const label = await run.github.api(`repos/${repo}/labels/${LABEL}`);
    present = label !== null && typeof label === "object";
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) present = false;
    else throw error;
  }
  cache.set(repo, present);
  return present;
}

// The new problems of this run: dedupe first, then the issue, then the filed
// marker. At most 5 issues, at most 2 for each repository, oldest first.
async function fileNew(run, published, facts) {
  const candidates = facts.problems.filter((problem) => published.keys[problem.key] === undefined).sort(compareProblems);
  const labels = new Map();
  const perRepo = new Map();
  let filed = 0;
  for (const problem of candidates) {
    if (filed >= MAX_NEW_ISSUES) {
      defer(run, "new_issues");
      continue;
    }
    if (!gate(run)) {
      defer(run, run.stopped);
      continue;
    }
    const hits = await run.github.searchIssues(`"Problem key: ${problem.key}"`);
    const hit = (hits ?? []).find((item) => String(item?.body ?? "").includes(`Problem key: ${problem.key}`));
    if (hit !== undefined && typeof hit?.repository?.nameWithOwner === "string" && Number.isSafeInteger(hit?.number)) {
      // The issue exists already: never filed a second time.
      published.keys[problem.key] = newEntry({
        repo: hit.repository.nameWithOwner,
        number: hit.number,
        ids: problem.glitchtip_issue_ids,
      });
      run.fresh.add(problem.key);
      writePublished(run.dir, published);
      continue;
    }
    if ((perRepo.get(problem.repo) ?? 0) >= MAX_PER_REPO) {
      defer(run, "new_issues");
      continue;
    }
    if (!gate(run)) {
      defer(run, run.stopped);
      continue;
    }
    if (!(await labelPresent(run, problem.repo, labels))) {
      defer(run, "no_label");
      continue;
    }
    if (!gate(run)) {
      defer(run, run.stopped);
      continue;
    }
    const built = assertIssueBody({
      kind: problem.kind,
      class: problem.class,
      fields: problem.fields,
      frames: problem.frames,
      location: problem.location,
      version: problem.kind === "app_problem" ? appVersionOf(problem) : null,
      images: problem.kind === "app_problem" ? [] : imagesOf(problem),
      key: problem.key,
      glitchtipIds: problem.glitchtip_issue_ids,
    });
    const created = await run.github.api(`repos/${problem.repo}/issues`, {
      method: "POST",
      body: { title: built.title, body: built.body, labels: [LABEL] },
    });
    run.hooks.afterAction?.("create");
    if (!Number.isSafeInteger(created?.number)) throw new GitHubError("issue_number");
    const entry = newEntry({ repo: problem.repo, number: created.number, ids: problem.glitchtip_issue_ids });
    published.keys[problem.key] = entry;
    writePublished(run.dir, published);
    filed += 1;
    perRepo.set(problem.repo, (perRepo.get(problem.repo) ?? 0) + 1);
    const marker = formatMarker({ key: problem.key, cycle: 1, step: "filed", boundary: null });
    await postComment(run, published, entry, marker, null);
  }
  writePublished(run.dir, published);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      diagnostic(errorCode(error));
      process.exitCode = 1;
    },
  );
}
