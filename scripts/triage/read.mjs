#!/usr/bin/env node
// The reader of the problem triage job (docs/specs/triage.md, "Reader"): it
// lists the GlitchTip issues, reads the events in the fair order, rebuilds the
// report of each event, verifies every value against a public source, and
// writes facts.json through assertFacts(). It sends GET only, it writes no
// event id, no report id and no token anywhere, and each diagnostic is a fixed
// string with a reason code.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as sleepDefault } from "node:timers/promises";
import { classOf } from "../../src/dimensions.ts";
import { REPO_ROOT, ConfigError, loadConfig } from "./lib/config.mjs";
import { FACTS_SCHEMA, FactsError, HELD_REASONS, assertFacts, failedFacts } from "./lib/facts.mjs";
import { grepPattern, grepPathspecs, keyForm, parseRoutedFrame, repoName } from "./lib/frames.mjs";
import { CapError, ReadError, createClient } from "./lib/glitchtip.mjs";
import { SourceError, createSources } from "./lib/sources.mjs";
import {
  compareImageVersion,
  compareSemver,
  isNoise,
  problemKey,
  rawFingerprint,
  rebuildReport,
  route,
} from "./lib/report.mjs";
import { ensureStateDir, readJson, utcDay, writeJsonAtomic } from "./lib/state.mjs";

const execFileAsync = promisify(execFile);

const WINDOW_MS = 30 * 86400000;
const DEADLINE_MS = 15 * 60 * 1000;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const TOKEN = /^[0-9a-f]{64}\n?$/;
const CREATED = /^\d{4}-\d{2}-\d{2}$/;
const CUTOFF = /^\d{4}-\d{2}-\d{2}T00:00:00Z$/;
// A GlitchTip issue row number that fits a safe integer.
const ISSUE_ID = /^[0-9]{1,15}$/;

const EXIT = { auth: 3, unreachable: 4, error: 5 };

// A fatal reading error: the run stops, facts.json holds the status, and
// health.json stays as it was.
class StopRun extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function statusFor(code) {
  if (code === "auth") return "auth";
  if (code === "unreachable") return "unreachable";
  return "error";
}

function gitLine(runGit, dir, args) {
  const options = { timeout: 120000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } };
  return Promise.resolve()
    .then(() => runGit(["-C", dir, ...args], options))
    .then((result) => {
      const text = typeof result === "string" ? result : String(result?.stdout ?? "");
      const line = text.split("\n")[0].trim();
      return line === "" ? null : line;
    })
    .catch(() => null);
}

// True when the checkout that runs this job is not at origin/main, or its last
// fetch is older than 6 hours (docs/design/triage.md, "Host items").
async function checkoutFailed(codeDir, nowMs, runGit) {
  const head = await gitLine(runGit, codeDir, ["rev-parse", "HEAD"]);
  const main = await gitLine(runGit, codeDir, ["rev-parse", "refs/remotes/origin/main"]);
  if (head === null || main === null || head !== main) return true;
  const gitDir = await gitLine(runGit, codeDir, ["rev-parse", "--absolute-git-dir"]);
  let stat;
  try {
    stat = statSync(join(gitDir === null ? join(codeDir, ".git") : gitDir, "FETCH_HEAD"));
  } catch {
    return true;
  }
  return stat.mtimeMs < nowMs - SIX_HOURS_MS;
}

function parseIssueRow(row) {
  if (!isObject(row)) throw new ReadError("error");
  const id = typeof row.id === "number" && Number.isSafeInteger(row.id) ? String(row.id) : row.id;
  if (typeof id !== "string" || !ISSUE_ID.test(id) || Number(id) < 1) throw new ReadError("error");
  const firstSeen = typeof row.firstSeen === "string" ? Date.parse(row.firstSeen) : Number.NaN;
  if (!Number.isFinite(firstSeen)) throw new ReadError("error");
  return {
    id: Number(id),
    idText: id,
    firstSeenTime: firstSeen,
    key: null,
    name: null,
    route: null,
    reports: [],
    pages: 0,
    cut: false,
    gone: false,
    status: null,
  };
}

// GlitchTip 6.2.6 answers the event list of an issue with the field names of
// its schema (`date_created`): that route has no `by_alias`, unlike the issue
// list. The Sentry form `dateCreated` is read too.
function parseEventRow(row) {
  if (!isObject(row)) throw new ReadError("error");
  const created = typeof row.date_created === "string" ? row.date_created : row.dateCreated;
  const time = typeof created === "string" ? Date.parse(created) : Number.NaN;
  if (!Number.isFinite(time)) throw new ReadError("error");
  return { dateCreated: created, time, tags: row.tags, context: row.context };
}

function readNameList(path) {
  const names = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const name = line.trim();
    if (name === "" || name.startsWith("#")) continue;
    names.add(name);
  }
  return names;
}

function splitLocation(location) {
  const at = location.lastIndexOf(":");
  return { path: location.slice(0, at), line: Number(location.slice(at + 1)) };
}

function variantOf(report) {
  return report.secure === true ? "secure" : "standard";
}

// The public fields of 1 kind (the KINDS table of facts.mjs is the closed
// list). Each value that can differ between events comes from the
// representative event.
function publicFields(report, featureVersion) {
  const detail = report.detail;
  switch (report.kind) {
    case "app_problem": {
      const fields = { app_id: detail.app_id, runtime: detail.runtime, component: detail.component };
      if (classOf(report) === "error") fields.code = detail.code;
      return fields;
    }
    case "unit_failed":
      return { unit: detail.unit, result: detail.result };
    case "update_stage_failed":
      return { error_class: detail.error_class, target_version: detail.target_version };
    case "booted_older_image":
      return { how: detail.how, newer_version: detail.newer_version };
    case "sysext_update_failed": {
      const fields = { feature: detail.feature, outcome: detail.outcome };
      if (typeof detail.error_class === "string") fields.error_class = detail.error_class;
      if (featureVersion !== null) fields.feature_version = featureVersion;
      return fields;
    }
    case "tpm_unlock":
      return { outcome: detail.outcome, tpm_rc: detail.tpm_rc, variant: variantOf(report) };
    case "integrity_error":
      return { subsystem: detail.subsystem, variant: variantOf(report) };
    default:
      return {};
  }
}

function compareText(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function observationOrder(kind) {
  const byVersion = kind === "app_problem" ? compareSemver : compareImageVersion;
  return (a, b) =>
    compareText(a.image, b.image) ||
    compareText(a.variant, b.variant) ||
    byVersion(a.version, b.version) ||
    (a.feature_version === b.feature_version
      ? 0
      : a.feature_version === null
        ? -1
        : b.feature_version === null
          ? 1
          : compareText(a.feature_version, b.feature_version));
}

function runLine(facts, counts) {
  const held = HELD_REASONS.map((reason) => `${reason}:${facts.held[reason]}`).join(",");
  return `triage-read: status=${facts.run.status} problems=${facts.problems.length} requests=${counts.requests} dropped_events=${counts.droppedEvents} dropped_observations=${counts.droppedObservations} held=${held}\n`;
}

// The newest event of the newest verified app version for an app, and the
// newest kept event for every other kind.
function newest(entries) {
  return entries.reduce((a, b) => (b.observation.when > a.observation.when ? b : a));
}

function keepRepresentative(kept) {
  if (kept[0].report.kind !== "app_problem") return newest(kept);
  const newestVersion = kept.map((entry) => entry.observation.version).sort(compareSemver).at(-1);
  return newest(kept.filter((entry) => entry.observation.version === newestVersion));
}

// Reads GlitchTip and writes facts.json. Returns { exitCode, facts }.
export async function runReader(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now();
  const day = utcDay(nowMs);
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const triageDir = options.triageDir ?? join(REPO_ROOT, "triage");
  const runGit = options.runGit ?? ((args, gitOptions) => execFileAsync("git", args, gitOptions));
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? sleepDefault;
  // A test fixes `now` and so freezes the clock; production reads the real one.
  const clock = options.clock ?? (Number.isFinite(options.now) ? () => nowMs : () => Date.now());

  let partialRun = false;
  let droppedEvents = 0;
  let droppedObservations = 0;
  let tokenAgeDays = null;
  const notes = [];
  let watchedKeys = [];
  let client = null;
  let listComplete = true;
  const issues = [];
  const candidates = [];
  const held = Object.fromEntries(HELD_REASONS.map((reason) => [reason, 0]));
  const newLastRead = new Map();
  const newIssueKeys = new Map();

  // Step 0: the configuration. An override without TRIAGE_TEST=1 stops the run
  // before any file is written: the state folder is not known then.
  let config;
  try {
    config = loadConfig(env, home);
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`triage-read: config ${error.code}\n`);
      return { exitCode: 2, facts: null };
    }
    throw error;
  }
  const stateDir = config.stateDir;
  const factsPath = join(stateDir, "facts.json");

  const fail = (status, code, exitCode) => {
    const facts = failedFacts({ day, status, tokenAgeDays, notes, watchedKeys });
    try {
      writeJsonAtomic(factsPath, facts);
    } catch {
      // The run has already failed; there is no other record to write.
    }
    stderr.write(`triage-read: ${status} ${code}\n`);
    stdout.write(runLine(facts, { requests: client === null ? 0 : client.requests(), droppedEvents, droppedObservations }));
    return { exitCode, facts };
  };

  try {
    ensureStateDir(stateDir);
  } catch {
    stderr.write("triage-read: error state_dir\n");
    return { exitCode: 5, facts: null };
  }

  // Step 1: the token and its creation day.
  let token = null;
  try {
    const text = readFileSync(config.tokenFile, "utf8");
    if (TOKEN.test(text)) token = text.trim();
  } catch {
    token = null;
  }
  if (token === null) return fail("config", "token", 2);

  try {
    const created = readFileSync(config.createdFile, "utf8").trim();
    if (!CREATED.test(created)) throw new Error("bad");
    const age = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${created}T00:00:00Z`)) / 86400000);
    if (!Number.isSafeInteger(age) || age < 0) throw new Error("bad");
    tokenAgeDays = age;
  } catch {
    tokenAgeDays = null;
    notes.push("token_created_unknown");
  }

  const codeDir = options.codeDir ?? null;
  if (codeDir !== null && existsSync(join(codeDir, ".git")) && (await checkoutFailed(codeDir, nowMs, runGit))) {
    notes.push("checkout_failed");
  }

  // The state: published.json holds the loop, health.json the fair order.
  let published = null;
  let stored = null;
  try {
    published = readJson(join(stateDir, "published.json"), null);
    stored = readJson(join(stateDir, "health.json"), null);
  } catch {
    return fail("error", "state", 5);
  }
  if (published !== null && !isObject(published)) return fail("error", "state", 5);
  if (stored !== null && !isObject(stored)) return fail("error", "state", 5);
  const health = isObject(stored) ? stored : {};
  const publishedKeys = isObject(published?.keys) ? published.keys : {};
  const healthLastRead = isObject(health.last_read) ? health.last_read : {};
  const healthIssueKeys = isObject(health.issue_keys) ? health.issue_keys : {};
  watchedKeys = Object.keys(publishedKeys)
    .filter((key) => isObject(publishedKeys[key]) && publishedKeys[key].state === "released")
    .sort();
  const watchedSet = new Set(watchedKeys);

  const keyOfPublishedIssue = new Map();
  for (const [key, entry] of Object.entries(publishedKeys)) {
    if (!isObject(entry) || !Array.isArray(entry.glitchtip_issue_ids)) continue;
    for (const id of entry.glitchtip_issue_ids) keyOfPublishedIssue.set(String(id), key);
  }

  // The data files of this checkout: the cutoff, the routes, the allowlists.
  let cutoff = null;
  let routes = null;
  let units = new Set();
  let features = new Set();
  try {
    const triageConfig = readJson(join(triageDir, "config.json"), null);
    if (!isObject(triageConfig)) throw new Error("config");
    cutoff = triageConfig.first_seen_cutoff ?? null;
    if (!(cutoff === null || (typeof cutoff === "string" && CUTOFF.test(cutoff)))) throw new Error("config");
    routes = readJson(join(triageDir, "routes.json"), null);
    if (!isObject(routes) || typeof routes.schema !== "string") throw new Error("routes");
    units = readNameList(join(triageDir, "allow", "units.txt"));
    features = readNameList(join(triageDir, "allow", "features.txt"));
  } catch {
    return fail("error", "triage_data", 5);
  }

  const baseUrl = config.glitchtipUrl.endsWith("/") ? config.glitchtipUrl : `${config.glitchtipUrl}/`;
  client = createClient({
    baseUrl,
    token,
    cap: options.cap ?? 1000,
    pauseMs: options.pauseMs ?? 200,
    timeoutMs: options.timeoutMs ?? 20000,
    deadline: nowMs + (options.deadlineMs ?? DEADLINE_MS),
    now: clock,
    sleep,
    fetchImpl,
  });
  const deadline = nowMs + (options.deadlineMs ?? DEADLINE_MS);
  const sources = createSources({ config, stateDir, runGit, fetchImpl, deadline, now: clock });
  // The deadline covers the source checks too: past it, the rest of the work
  // is held request_cap and the run is partial.
  const checkDeadline = () => {
    if (clock() >= deadline) throw new CapError("deadline");
  };

  // The result of each source check is kept for 1 (value, tag) pair for the
  // rest of the run; a failed check keeps its failure.
  const checkCache = new Map();
  async function checked(id, run) {
    if (checkCache.has(id)) {
      const known = checkCache.get(id);
      if (known.error !== undefined) throw known.error;
      return known.value;
    }
    try {
      const value = await run();
      checkCache.set(id, { value });
      return value;
    } catch (error) {
      // The deadline stops the check; it is no result of the check.
      if (error instanceof CapError) throw error;
      const wrapped = error instanceof SourceError ? error : new SourceError("check");
      checkCache.set(id, { error: wrapped });
      throw wrapped;
    }
  }

  async function moduleOf(repo, tag) {
    return await checked(`${repo}\u0000${tag}\u0000module`, () => sources.goModule(repo, tag));
  }

  // True or false for a frame of the routed module, null for a frame that is
  // not of it (that frame needs no tag check).
  async function frameVerifies(repo, tag, frame, name, module) {
    const parsed = parseRoutedFrame(frame, name);
    if (parsed === null) return null;
    if (parsed.parsed === null) return false;
    if (parsed.module !== module) return false;
    const pattern = grepPattern(parsed.parsed);
    const id = `${repo}\u0000${tag}\u0000frame\u0000${JSON.stringify([parsed.pkgpath, pattern])}`;
    return await checked(id, () => sources.grepFrame(repo, tag, pattern, grepPathspecs(parsed.pkgpath)));
  }

  // What goes out about the frames of the representative event: the first 3 in
  // their key form, each later 1 as its parent form when it verifies at that
  // version, else `unverified`.
  async function shownFrames(group, report) {
    if (report.kind !== "app_problem" || !Array.isArray(report.detail.frames)) return [];
    const tag = `v${report.detail.app_version}`;
    const list = report.detail.frames.slice(0, 32);
    const module = list.length === 0 ? null : await moduleOf(group.repo, tag);
    const shown = [];
    for (const [index, frame] of list.entries()) {
      const parsed = parseRoutedFrame(frame, group.name);
      if (index < 3) {
        const verified = parsed !== null && (await frameVerifies(group.repo, tag, frame, group.name, module)) === true;
        shown.push({ value: keyForm(frame, group.name) ?? "unverified", verified });
      } else if (parsed === null || parsed.parsed === null) {
        shown.push({ value: keyForm(frame, group.name) ?? "unverified", verified: false });
      } else {
        const verified = (await frameVerifies(group.repo, tag, frame, group.name, module)) === true;
        shown.push({ value: verified ? parsed.parsed.published : "unverified", verified });
      }
    }
    return shown;
  }

  // The version checks and the fingerprint checks of 1 event, at the tag of its
  // own app version. A version that fails drops the observation; a code, frame
  // or location value that fails drops it too.
  async function verifyObservation(entry, group) {
    checkDeadline();
    const report = entry.report;
    const image = report.image.id;
    const variant = variantOf(report);
    const when = Date.parse(entry.event.dateCreated);

    if (report.kind === "app_problem") {
      const appVersion = report.detail.app_version;
      const tag = `v${appVersion}`;
      const tags = await sources.tags(group.repo);
      if (!tags.has(tag)) return { ok: false, versionOk: false };
      await sources.ensureTag(group.repo, tag);
      if (typeof report.detail.code === "string") {
        const code = report.detail.code;
        const found = await checked(`${group.repo}\u0000${tag}\u0000code\u0000${code}`, () =>
          sources.grepFixed(group.repo, tag, `"${code}"`),
        );
        if (!found) return { ok: false, versionOk: true };
      }
      const frames = Array.isArray(report.detail.frames) ? report.detail.frames.slice(0, 32) : [];
      if (frames.length > 0) {
        const module = await moduleOf(group.repo, tag);
        for (const frame of frames.slice(0, 3)) {
          if ((await frameVerifies(group.repo, tag, frame, group.name, module)) === false) {
            return { ok: false, versionOk: true };
          }
        }
        // At least 1 frame of the routed module among the frames that the issue
        // would show must verify at this observation's own version. A check of
        // each observation, so a forged event cannot hold a real 1 back by
        // being the representative event.
        let anyVerified = false;
        for (const frame of frames) {
          if ((await frameVerifies(group.repo, tag, frame, group.name, module)) === true) {
            anyVerified = true;
            break;
          }
        }
        if (!anyVerified) return { ok: false, versionOk: true };
      }
      if (typeof report.detail.location === "string") {
        const location = report.detail.location;
        const found = await checked(`${group.repo}\u0000${tag}\u0000location\u0000${location}`, async () => {
          const { path, line } = splitLocation(location);
          const lines = await sources.locationLines(group.repo, tag, path);
          return lines !== null && lines >= line;
        });
        if (!found) return { ok: false, versionOk: true };
      }
      return { ok: true, versionOk: true, observation: { image, variant, version: appVersion, featureVersion: null, when } };
    }

    const imageTags = await sources.imageTags(image);
    if (!imageTags.includes(report.image.version)) return { ok: false, versionOk: false };
    if (report.kind === "update_stage_failed" && !imageTags.includes(report.detail.target_version)) {
      return { ok: false, versionOk: false };
    }
    if (report.kind === "booted_older_image" && !imageTags.includes(report.detail.newer_version)) {
      return { ok: false, versionOk: false };
    }
    let featureVersion = null;
    if (report.kind === "sysext_update_failed") {
      const feature = report.detail.feature;
      const names = await sources.featureFiles(feature);
      const prefix = `${feature}_${report.detail.version}_`;
      if (names.some((name) => name.startsWith(prefix))) featureVersion = report.detail.version;
    }
    return {
      ok: true,
      versionOk: true,
      observation: { image, variant, version: report.image.version, featureVersion, when },
    };
  }

  try {
    // Step 2: the issue list, every page. An issue before the cutoff takes no
    // further part in the run.
    const cutoffTime = cutoff === null ? null : Date.parse(cutoff);
    try {
      let cursor = null;
      for (;;) {
        const url =
          `${baseUrl}organizations/${encodeURIComponent(config.org)}/issues/` +
          (cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`);
        const page = await client.get(url);
        for (const row of page.body) issues.push(parseIssueRow(row));
        if (page.cursor === null) break;
        cursor = page.cursor;
      }
    } catch (error) {
      if (error instanceof CapError) {
        listComplete = false;
        partialRun = true;
      } else if (error instanceof ReadError) {
        throw new StopRun(statusFor(error.code), error.code);
      } else {
        throw error;
      }
    }

    for (const issue of issues) {
      if (cutoffTime === null || issue.firstSeenTime < cutoffTime) {
        issue.status = "before_cutoff";
        held.before_cutoff += 1;
      } else {
        candidates.push(issue);
      }
    }

    // Step 3: the fair order. A watched key first, then an issue whose key is
    // not known yet, then the rest; inside each group the oldest read first and
    // an issue never read before the others. The issue id breaks a tie.
    const knownKey = (issue) => healthIssueKeys[issue.idText] ?? keyOfPublishedIssue.get(issue.idText) ?? null;
    const groupOf = (issue) => {
      const key = knownKey(issue);
      if (key !== null && watchedSet.has(key)) return 0;
      return key === null ? 1 : 2;
    };
    candidates.sort((a, b) => {
      const byGroup = groupOf(a) - groupOf(b);
      if (byGroup !== 0) return byGroup;
      const left = healthLastRead[a.idText] ?? null;
      const right = healthLastRead[b.idText] ?? null;
      if (left === null && right !== null) return -1;
      if (left !== null && right === null) return 1;
      if (left !== null && right !== null && left !== right) return left < right ? -1 : 1;
      return a.id - b.id;
    });

    // Steps 4 and 5: the events of each issue, newest first, until 30 days
    // back; then the main raw fingerprint of the issue and its problem key.
    const windowStart = nowMs - WINDOW_MS;
    for (const issue of candidates) {
      let cursor = null;
      let cut = false;
      let gone = false;
      let firstOld = null;
      const events = [];
      try {
        for (;;) {
          const url =
            `${baseUrl}issues/${issue.idText}/events/?full=true` +
            (cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`);
          const page = await client.get(url);
          issue.pages += 1;
          let reachedOld = false;
          for (const row of page.body) {
            const event = parseEventRow(row);
            if (event.time < windowStart) {
              reachedOld = true;
              if (firstOld === null) firstOld = event;
              continue;
            }
            events.push(event);
          }
          if (reachedOld || page.cursor === null) break;
          cursor = page.cursor;
        }
      } catch (error) {
        if (error instanceof CapError) {
          cut = true;
        } else if (error instanceof ReadError && error.code === "not_found") {
          // The issue was deleted during the run: it takes no part.
          gone = true;
        } else if (error instanceof ReadError) {
          throw new StopRun(statusFor(error.code), error.code);
        } else {
          throw error;
        }
      }
      if (gone) {
        issue.gone = true;
        continue;
      }
      if (issue.pages > 0) newLastRead.set(issue.idText, day);
      if (issue.pages === 0) {
        // The cap or the deadline stopped the read before its first page.
        issue.cut = true;
        held.request_cap += 1;
        partialRun = true;
        continue;
      }
      if (cut) {
        issue.cut = true;
        partialRun = true;
      }

      const reports = [];
      for (const event of events) {
        const report = rebuildReport(event);
        if (report === null) {
          droppedEvents += 1;
          continue;
        }
        reports.push({ event, report, fingerprint: JSON.stringify(rawFingerprint(report)) });
      }
      if (reports.length === 0) {
        // No valid report in the last 30 days. The newest older event still
        // tells the key, so the watched coverage knows this issue; it gives no
        // observation.
        const old = firstOld === null ? null : rebuildReport(firstOld);
        if (old !== null) {
          const oldRoute = route(old, routes);
          issue.key = problemKey(old, oldRoute.repo === undefined ? "" : repoName(oldRoute.repo));
          newIssueKeys.set(issue.idText, issue.key);
        }
        continue;
      }

      // The main raw fingerprint: the one of most of the events, and of the
      // newest event when 2 have the same count.
      const counts = new Map();
      for (const entry of reports) {
        const seen = counts.get(entry.fingerprint) ?? { count: 0, newest: Number.NEGATIVE_INFINITY };
        seen.count += 1;
        seen.newest = Math.max(seen.newest, entry.event.time);
        counts.set(entry.fingerprint, seen);
      }
      let main = null;
      let best = null;
      for (const [fingerprint, seen] of counts) {
        if (best === null || seen.count > best.count || (seen.count === best.count && seen.newest > best.newest)) {
          main = fingerprint;
          best = seen;
        }
      }
      const kept = reports.filter((entry) => entry.fingerprint === main);
      droppedEvents += reports.length - kept.length;
      const newestEntry = kept.reduce((a, b) => (b.event.time > a.event.time ? b : a));
      const routed = route(newestEntry.report, routes);
      issue.route = routed;
      issue.reports = kept;
      // The key comes from the raw fingerprint alone, so a held issue has 1 too.
      issue.name = routed.repo === undefined ? "" : repoName(routed.repo);
      issue.key = problemKey(newestEntry.report, issue.name);
      newIssueKeys.set(issue.idText, issue.key);
      if (routed.held !== undefined) {
        held[routed.held] += 1;
        continue;
      }
    }

    // Steps 6 and 7: group the issues by key and decide each problem.
    const groups = new Map();
    for (const issue of candidates) {
      if (issue.key === null || !isObject(issue.route) || issue.route.repo === undefined) continue;
      let group = groups.get(issue.key);
      if (group === undefined) {
        group = { key: issue.key, repo: issue.route.repo, name: issue.name, issues: [] };
        groups.set(issue.key, group);
      }
      group.issues.push(issue);
    }

    const problems = [];
    for (const group of [...groups.values()].sort((a, b) => compareText(a.key, b.key))) {
      const issueCount = group.issues.length;
      const entries = group.issues.flatMap((issue) => issue.reports);
      let reason = null;
      let pending = null;
      try {
        checkDeadline();
        const live = entries.filter((entry) => !isNoise(entry.report));
        const first = live[0]?.report ?? null;
        if (live.length === 0) {
          reason = "noise";
        } else if (
          (first.kind === "unit_failed" && !units.has(first.detail.unit)) ||
          (first.kind === "sysext_update_failed" && !features.has(first.detail.feature))
        ) {
          reason = "not_allowlisted";
        } else {
          const kept = [];
          let versionOk = false;
          for (const entry of live) {
            const result = await verifyObservation(entry, group);
            if (result.ok) {
              kept.push({ ...entry, observation: result.observation });
              versionOk = true;
            } else {
              droppedObservations += 1;
              if (result.versionOk) versionOk = true;
            }
          }
          if (kept.length === 0) {
            reason = versionOk ? "unverified_code" : "unverified_version";
          } else {
            const representative = keepRepresentative(kept);
            const shown = await shownFrames(group, representative.report);
            if (shown.length > 0 && !shown.some((frame) => frame.verified)) {
              reason = "unverified_code";
            } else {
              const featureVersion = representative.observation.featureVersion;
              const location =
                representative.report.kind === "app_problem" &&
                classOf(representative.report) === "panic" &&
                representative.report.detail.runtime === "rust" &&
                typeof representative.report.detail.location === "string"
                  ? representative.report.detail.location
                  : null;
              const observations = new Map();
              for (const entry of kept) {
                const one = entry.observation;
                const id = JSON.stringify([one.image, one.variant, one.version, one.featureVersion]);
                const seen = observations.get(id);
                const observedDay = utcDay(one.when);
                if (seen === undefined || observedDay > seen.last_seen_day) {
                  observations.set(id, {
                    image: one.image,
                    variant: one.variant,
                    version: one.version,
                    feature_version: one.featureVersion,
                    last_seen_day: observedDay,
                  });
                }
              }
              pending = {
                key: group.key,
                repo: group.repo,
                kind: representative.report.kind,
                class: classOf(representative.report),
                fields: publicFields(representative.report, featureVersion),
                frames: shown.map((frame) => frame.value),
                location,
                observations: [...observations.values()].sort(observationOrder(representative.report.kind)),
                coverage: group.issues.some((issue) => issue.cut) ? "partial" : "complete",
                first_seen_day: utcDay(Math.min(...group.issues.map((issue) => issue.firstSeenTime))),
                glitchtip_issue_ids: group.issues.map((issue) => issue.id).sort((a, b) => a - b),
              };
            }
          }
        }
        // A key's result counts only when its checks ended inside the deadline.
        checkDeadline();
        if (pending !== null) problems.push(pending);
      } catch (error) {
        if (error instanceof CapError) {
          // The deadline stopped the checks of this key.
          reason = "request_cap";
          partialRun = true;
          for (const issue of group.issues) issue.cut = true;
        } else if (error instanceof SourceError) {
          reason = "source_unavailable";
        } else {
          throw error;
        }
      }
      if (reason !== null) {
        held[reason] += issueCount;
        if (reason === "source_unavailable") for (const issue of group.issues) issue.cut = true;
      }
    }

    // The `watched` entries: a released key collects no covered day unless the
    // whole read of that key was complete (docs/specs/triage.md, the facts
    // schema).
    // Every issue whose key is still unknown must have been read in full:
    // then it holds no valid report of the last 30 days, and so no qualifying
    // observation of any key. An issue the cap or the deadline cut is not.
    const readEnough = !candidates.some(
      (issue) => !issue.gone && issue.key === null && knownKey(issue) === null && (issue.pages === 0 || issue.cut),
    );
    const inList = new Map(issues.map((issue) => [issue.idText, issue]));
    const watched = watchedKeys.map((key) => {
      let complete = listComplete && !partialRun && readEnough;
      if (complete) {
        const ids = new Set();
        for (const [id, value] of Object.entries(healthIssueKeys)) if (value === key) ids.add(id);
        for (const id of publishedKeys[key]?.glitchtip_issue_ids ?? []) ids.add(String(id));
        // And every issue whose key this run learned.
        for (const issue of candidates) if (issue.key === key) ids.add(issue.idText);
        for (const id of ids) {
          const issue = inList.get(id);
          if (issue === undefined || issue.gone) continue;
          // An issue before the cutoff takes no part in the coverage rule.
          if (issue.status === "before_cutoff") continue;
          if (issue.pages === 0 || issue.cut) {
            complete = false;
            break;
          }
        }
      }
      return { key, coverage: complete ? "complete" : "partial" };
    });

    const facts = {
      schema: FACTS_SCHEMA,
      run: { day, status: partialRun ? "partial" : "ok", token_age_days: tokenAgeDays, notes: [...new Set(notes)] },
      problems: problems.sort((a, b) => compareText(a.key, b.key)),
      watched,
      held,
    };
    try {
      assertFacts(facts);
    } catch (error) {
      if (error instanceof FactsError) return fail("error", "facts", 5);
      throw error;
    }
    writeJsonAtomic(factsPath, facts);

    // health.json: everything the reader found stays; only last_read and
    // issue_keys change, and an id that left the list is dropped.
    const nextHealth = { ...health };
    const lastRead = { ...healthLastRead };
    const issueKeys = { ...healthIssueKeys };
    for (const [id, value] of newLastRead) lastRead[id] = value;
    for (const [id, value] of newIssueKeys) issueKeys[id] = value;
    if (listComplete) {
      const present = new Set(issues.filter((issue) => !issue.gone).map((issue) => issue.idText));
      for (const id of Object.keys(lastRead)) if (!present.has(id)) delete lastRead[id];
      for (const id of Object.keys(issueKeys)) if (!present.has(id)) delete issueKeys[id];
    }
    nextHealth.last_read = lastRead;
    nextHealth.issue_keys = issueKeys;
    writeJsonAtomic(join(stateDir, "health.json"), nextHealth);

    stdout.write(runLine(facts, { requests: client.requests(), droppedEvents, droppedObservations }));
    return { exitCode: 0, facts };
  } catch (error) {
    if (error instanceof StopRun) return fail(error.status, error.code, EXIT[error.status]);
    throw error;
  }
}

// The verified summary of the last facts.json. It sends no request, so the
// request and drop counts of its line are 0; the counts of a run are not
// stored in facts.json.
export function printSummary(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  let config;
  try {
    config = loadConfig(env, home);
  } catch (error) {
    if (error instanceof ConfigError) {
      stderr.write(`triage-read: config ${error.code}\n`);
      return 1;
    }
    throw error;
  }
  let facts;
  try {
    facts = readJson(join(config.stateDir, "facts.json"), null);
  } catch {
    facts = null;
  }
  if (facts === null) {
    stderr.write("triage-read: no facts\n");
    return 1;
  }
  try {
    assertFacts(facts);
  } catch (error) {
    if (error instanceof FactsError) {
      stderr.write(`triage-read: facts invalid ${error.code}\n`);
      return 5;
    }
    throw error;
  }
  stdout.write(runLine(facts, { requests: 0, droppedEvents: 0, droppedObservations: 0 }));
  for (const problem of facts.problems) {
    const fields = Object.entries(problem.fields)
      .map(([name, value]) => `${name}=${value}`)
      .join(",");
    const observations = problem.observations
      .map((one) => `${one.image}/${one.variant}/${one.version}/${one.feature_version ?? "-"}/${one.last_seen_day}`)
      .join(",");
    stdout.write(
      `triage-read: problem key=${problem.key} repo=${problem.repo} kind=${problem.kind} class=${problem.class}` +
        ` fields=${fields} frames=${problem.frames.join(",")} location=${problem.location ?? "-"}` +
        ` observations=${observations} coverage=${problem.coverage}` +
        ` first_seen_day=${problem.first_seen_day} issues=${problem.glitchtip_issue_ids.join(",")}\n`,
    );
  }
  for (const entry of facts.watched) stdout.write(`triage-read: watched key=${entry.key} coverage=${entry.coverage}\n`);
  const held = HELD_REASONS.map((reason) => `${reason}=${facts.held[reason]}`).join(" ");
  stdout.write(`triage-read: held ${held}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = process.argv.includes("--summary") ? { exitCode: printSummary() } : await runReader({ codeDir: REPO_ROOT });
  process.exit(result.exitCode);
}
