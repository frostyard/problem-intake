// The triage publisher and its issue guard (docs/specs/triage.md, "The
// publisher", "Close the loop", "The GitHub issue" and "Required tests").
// No network: the fake `gh` of test/fixtures/triage/gh answers from a JSON
// state file, and each test passes `now`. Image labels and the sysext index
// come from a temporary TRIAGE_SOURCES folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { assertIssueBody, parseIssueBody } from "../../scripts/triage/lib/issue.mjs";
import { assertFacts } from "../../scripts/triage/lib/facts.mjs";
import { main } from "../../scripts/triage/publish.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_GH_DIR = join(root, "test/fixtures/triage/gh");
const DAY = "2026-11-21";
const NOW = "2026-11-21T06:15:00Z";
const KEY = "3f2a1b4c5d6e4f70";
const KEY2 = "9c1d2e3f4a5b6c7d";
const KEY3 = "1122334455667788";

// Every temporary folder this file makes, removed when it ends.
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

const HELD = Object.freeze({
  before_cutoff: 0,
  unknown_route: 0,
  kind_not_filed: 0,
  noise: 0,
  unverified_version: 0,
  unverified_code: 0,
  not_allowlisted: 0,
  source_unavailable: 0,
  request_cap: 0,
});

function factsDoc({ day = DAY, problems = [], watched = [], status = "ok", tokenAgeDays = 10, notes = [] } = {}) {
  return {
    schema: "frostyard.problem-triage-facts/1",
    run: { day, status, token_age_days: tokenAgeDays, notes },
    problems,
    watched,
    held: { ...HELD },
  };
}

function observation({ image = "snow", variant = "standard", version = "20261105093000", featureVersion = null, lastSeenDay = "2026-11-20" } = {}) {
  return { image, variant, version, feature_version: featureVersion, last_seen_day: lastSeenDay };
}

function unitProblem({ key = KEY, repo = "frostyard/snosi", unit = "snosi-health-report.service", cls = "exit-code", observations = [observation()], firstSeenDay = "2026-11-20", ids = [7], coverage = "complete" } = {}) {
  return {
    key,
    repo,
    kind: "unit_failed",
    class: cls,
    fields: { unit, result: cls },
    frames: [],
    location: null,
    observations,
    coverage,
    first_seen_day: firstSeenDay,
    glitchtip_issue_ids: ids,
  };
}

function appProblem({ key = KEY, repo = "frostyard/chairlift", appId = "org.frostyard.ChairLift", cls = "error", code = "store.migrate_failed", observations = [observation({ image: "snow", version: "0.15.0" })], firstSeenDay = "2026-11-20", ids = [7], frames = [], location = null, runtime = "go" } = {}) {
  const fields = { app_id: appId, runtime, component: "gui" };
  if (cls === "error") fields.code = code;
  return {
    key,
    repo,
    kind: "app_problem",
    class: cls,
    fields,
    frames,
    location,
    observations,
    coverage: "complete",
    first_seen_day: firstSeenDay,
    glitchtip_issue_ids: ids,
  };
}

function sysextProblem({ key = KEY, repo = "frostyard/snosi", feature = "gamma", cls = "failed", featureVersion = "1.2", observations = [observation({ featureVersion: "1.2" })], firstSeenDay = "2026-11-20", ids = [7] } = {}) {
  const fields = { feature, outcome: cls };
  if (featureVersion !== null) fields.feature_version = featureVersion;
  return {
    key,
    repo,
    kind: "sysext_update_failed",
    class: cls,
    fields,
    frames: [],
    location: null,
    observations,
    coverage: "complete",
    first_seen_day: firstSeenDay,
    glitchtip_issue_ids: ids,
  };
}

function cachedImageProblem({ key = KEY, repo = "frostyard/snosi", image = "snow", observations = [observation()] } = {}) {
  return {
    key,
    repo,
    kind: "booted_older_image",
    class: "unknown",
    fields: { how: "unknown", newer_version: "20261120093000" },
    frames: [],
    location: null,
    observations,
    coverage: "complete",
    first_seen_day: "2026-11-20",
    glitchtip_issue_ids: [7],
  };
}

function issueEntry({ repo = "frostyard/snosi", number = 1, cycle = 1, state = "filed", boundary = null, releasedDay = null, coveredDays = 0, lastCountedDay = null, featureIndex = null, ids = [7], marker = null } = {}) {
  return {
    repo,
    number,
    cycle,
    state,
    boundary,
    released_day: releasedDay,
    covered_days: coveredDays,
    last_counted_day: lastCountedDay,
    feature_index: featureIndex,
    glitchtip_issue_ids: ids,
    last_comment_marker: marker,
  };
}

function publishedDoc(keys) {
  return { schema: "frostyard.problem-triage-published/1", keys };
}

// The title and body of an issue for a problem, through the guard.
function issueFor(problem) {
  const observations = problem.observations;
  let version = null;
  let images = [];
  if (problem.kind === "app_problem") {
    version = newestVersion(observations.map((item) => item.version));
  } else {
    images = imagesOf(observations);
  }
  return assertIssueBody({
    kind: problem.kind,
    class: problem.class,
    fields: problem.fields,
    frames: problem.frames,
    location: problem.location,
    version,
    images,
    key: problem.key,
    glitchtipIds: problem.glitchtip_issue_ids,
  });
}

function newestVersion(versions) {
  const sorted = [...versions].sort((a, b) => {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
    return 0;
  });
  return sorted.at(-1) ?? null;
}

function imagesOf(observations) {
  const newest = new Map();
  for (const item of observations) {
    const seen = newest.get(item.image);
    if (seen === undefined || Number(item.version) > Number(seen)) newest.set(item.image, item.version);
  }
  return [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, version]) => ({ id, version }));
}

function markerOf({ key, cycle, step, boundary = null }) {
  return `<!-- problem-triage:1 key=${key} cycle=${cycle} step=${step} boundary=${boundary === null ? "none" : boundary} -->`;
}

// The filed marker comment of a tracked issue.
function filedComment(key, cycle = 1) {
  return {
    author: "frostyard-machines",
    association: "MEMBER",
    body: markerOf({ key, cycle, step: "filed", boundary: null }),
    createdAt: "2026-11-19T00:00:00Z",
  };
}

// ------------------------------------------------------------------ a world

function makeWorld({ repos = {}, labels = {}, sources = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "triage-publish-"));
  temps.push(dir);
  const stateDir = join(dir, "state");
  const sourcesDir = join(dir, "sources");
  const ghStatePath = join(dir, "gh.json");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(sourcesDir, "registry"), { recursive: true });
  mkdirSync(join(sourcesDir, "index"), { recursive: true });
  writeFileSync(ghStatePath, `${JSON.stringify({ calls: [], repos, labels, now: "2026-11-21T00:00:00Z" }, null, 2)}\n`);
  const env = {
    ...process.env,
    TRIAGE_TEST: "1",
    TRIAGE_STATE_DIR: stateDir,
    FAKE_GH_STATE: ghStatePath,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
  };
  // `sources: false` runs the production registry reads against a stub fetch.
  if (sources) env.TRIAGE_SOURCES = sourcesDir;
  return { dir, stateDir, sourcesDir, ghStatePath, env };
}

function ghState(world) {
  return JSON.parse(readFileSync(world.ghStatePath, "utf8"));
}

function writeGh(world, state) {
  writeFileSync(world.ghStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

// Adds 1 issue to the fake GitHub. `comments` are { author, association,
// body, createdAt }.
function addIssue(world, repo, issue) {
  const state = ghState(world);
  state.repos[repo] ??= { issues: [] };
  state.repos[repo].issues ??= [];
  state.repos[repo].issues.push({
    number: issue.number ?? state.repos[repo].issues.length + 1,
    title: issue.title ?? "",
    body: issue.body ?? "",
    author: issue.author ?? "frostyard-machines",
    labels: issue.labels ?? ["problem-report"],
    state: issue.state ?? "open",
    stateReason: issue.stateReason ?? null,
    closedAt: issue.closedAt ?? null,
    closer: issue.closer ?? null,
    comments: issue.comments ?? [],
  });
  writeGh(world, state);
  return state.repos[repo].issues.at(-1).number;
}

function setRelease(world, repo, releases) {
  const state = ghState(world);
  state.repos[repo] ??= { issues: [] };
  state.repos[repo].releases = releases;
  writeGh(world, state);
}

// The compare answers of a release list, oldest first: `containing` names the
// tags that hold the fix, and every other tag answers `diverged` (the search
// demands an answer for each probe).
function compareMap(sha, releases, containing) {
  const map = {};
  for (const release of releases) {
    map[`${sha}...${release.tag_name}`] = containing.includes(release.tag_name) ? "ahead" : "diverged";
  }
  return map;
}

function setCompare(world, repo, pairs) {
  const state = ghState(world);
  state.repos[repo] ??= { issues: [] };
  state.repos[repo].compare = pairs;
  writeGh(world, state);
}

function setRegistry(world, image, registry) {
  writeFileSync(join(world.sourcesDir, "registry", `${image}.json`), `${JSON.stringify(registry, null, 2)}\n`);
}

function setSums(world, feature, versions) {
  mkdirSync(join(world.sourcesDir, "index", feature), { recursive: true });
  const lines = versions.map((version, i) => `${String(i + 1).padStart(64, "0")}  ${feature}_${version}_x86-64.raw`);
  writeFileSync(join(world.sourcesDir, "index", feature, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

function imageLabels(sha, created) {
  return {
    "org.opencontainers.image.source": `https://github.com/frostyard/snosi/blob/${sha}/mkosi.conf`,
    "org.opencontainers.image.created": created,
  };
}

function writeFacts(world, doc) {
  assertFacts(doc);
  writeFileSync(join(world.stateDir, "facts.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

function writePublishedFile(world, doc) {
  writeFileSync(join(world.stateDir, "published.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

function writeHealthFile(world, doc) {
  writeFileSync(join(world.stateDir, "health.json"), `${JSON.stringify(doc, null, 2)}\n`);
}

function writeHeartbeat(world, day) {
  writeFileSync(join(world.stateDir, "heartbeat"), `${day}\n`);
}

function readPublished(world) {
  return JSON.parse(readFileSync(join(world.stateDir, "published.json"), "utf8"));
}

function readHealth(world) {
  return JSON.parse(readFileSync(join(world.stateDir, "health.json"), "utf8"));
}

function readHeartbeat(world) {
  return readFileSync(join(world.stateDir, "heartbeat"), "utf8").trim();
}

function calls(world, needle = "") {
  return ghState(world).calls.filter((call) => call.join(" ").includes(needle));
}

// The `gh api` calls of 1 path, with 1 method when given.
function apiCalls(world, path, method = null) {
  return ghState(world).calls.filter((call) => {
    if (call[0] !== "api" || call[1] !== path) return false;
    if (method === null) return true;
    const at = call.indexOf("--method");
    return at >= 0 && call[at + 1] === method;
  });
}

// Every comment POST of the run.
function commentPosts(world) {
  return ghState(world).calls.filter(
    (call) => call[0] === "api" && String(call[1]).endsWith("/comments") && call.includes("POST"),
  );
}

// Every fault-issue create POST of the run (the health issue is not 1).
function issuePosts(world) {
  return ghState(world).calls.filter(
    (call) =>
      call[0] === "api" &&
      /repos\/[^/]+\/[^/]+\/issues$/.test(call[1]) &&
      !call[1].startsWith("repos/frostyard/problem-intake/") &&
      call.includes("POST"),
  );
}

// Every state PATCH of the run.
function statePatches(world) {
  return ghState(world).calls.filter((call) => call[0] === "api" && call.includes("PATCH"));
}

function resetCalls(world) {
  const state = ghState(world);
  state.calls = [];
  writeGh(world, state);
}

function issues(world, repo) {
  return ghState(world).repos[repo]?.issues ?? [];
}

function commentsOf(world, repo, number) {
  return issues(world, repo).find((issue) => issue.number === number)?.comments ?? [];
}

async function run(world, { now = NOW, hooks } = {}) {
  return main({ now: new Date(now), env: world.env, hooks });
}

function commentBodies(world, repo, number) {
  return commentsOf(world, repo, number).map((comment) => comment.body);
}

// ---------------------------------------------------------------------------
// The issue guard
// ---------------------------------------------------------------------------

test("assertIssueBody renders the spec example byte for byte", () => {
  const problem = unitProblem({ unit: "snosi-health-report.service" });
  assert.deepEqual(issueFor(problem), {
    title: "Problem report: unit_failed exit-code snosi-health-report.service",
    body: [
      "```",
      "kind: unit_failed",
      "class: exit-code",
      "unit: snosi-health-report.service",
      "result: exit-code",
      "image: snow 20261105093000",
      "```",
      "",
      "Problem key: 3f2a1b4c5d6e4f70",
      "GlitchTip issue: 7",
      "",
      "Opened by the problem-intake triage job from opt-in problem reports. Every value was checked against this repository's public source and release tags. Name this issue in the fix PR (`Fixes #N`). What this issue holds and never holds: https://frostyard.org/privacy/problem-reports/#public-bug-reports",
    ].join("\n"),
  });
});

test("assertIssueBody refuses a field that is not public for its kind", () => {
  const base = {
    kind: "unit_failed",
    class: "exit-code",
    frames: [],
    location: null,
    version: null,
    images: [{ id: "snow", version: "20261105093000" }],
    key: KEY,
    glitchtipIds: [7],
  };
  // A field of another kind, a field of the report that is never published, a
  // variant where the spec shows none.
  for (const extra of [{ retries: "2" }, { bootc_version: "1.0.0" }, { variant: "standard" }, { shipped: "true" }]) {
    assert.throws(
      () => assertIssueBody({ ...base, fields: { unit: "a.service", result: "exit-code", ...extra } }),
      /field_not_public/,
      JSON.stringify(extra),
    );
  }
  // A missing required field.
  assert.throws(() => assertIssueBody({ ...base, fields: { unit: "a.service" } }), /field_missing/);
});

test("assertIssueBody refuses a day, a bare number and a bad version", () => {
  const base = {
    kind: "update_stage_failed",
    class: "network",
    frames: [],
    location: null,
    version: null,
    images: [{ id: "snow", version: "20261105093000" }],
    key: KEY,
    glitchtipIds: [7],
  };
  assert.throws(
    () => assertIssueBody({ ...base, fields: { error_class: "2026-11-20", target_version: "20261105093000" } }),
    /enum|day/,
  );
  assert.throws(
    () => assertIssueBody({ ...base, fields: { error_class: "network", target_version: "12" } }),
    /pattern/,
  );
  assert.throws(() => assertIssueBody({ ...base, fields: { error_class: "network", target_version: "20261105093000", extra: "1" } }), /field_not_public/);
  // A bare number in a field that is not a version.
  assert.throws(
    () => assertIssueBody({ ...base, kind: "unit_failed", class: "exit-code", fields: { unit: "7", result: "exit-code" } }),
    /number|pattern/,
  );
  // A day in a value that fits no field of the kind.
  assert.throws(
    () => assertIssueBody({ ...base, fields: { error_class: "network", target_version: "20261105093000" }, key: "2026-11-20" }),
    /key/,
  );
});

test("assertIssueBody refuses a frame that is not a published form", () => {
  const base = {
    kind: "app_problem",
    class: "panic",
    fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" },
    location: null,
    version: "0.15.0",
    images: [],
    key: KEY,
    glitchtipIds: [7],
  };
  for (const frame of [
    "github.com/frostyard/chairlift/internal/store.Store.Write.func1",
    "github.com/frostyard/chairlift/internal/store.Store.Write.1",
    "src/secret/path.rs",
    "github.com/frostyard/chairlift/internal/store.(*Store).Migrate()",
  ]) {
    assert.throws(() => assertIssueBody({ ...base, frames: [frame] }), /frame/, frame);
  }
  const allowed = [
    "github.com/frostyard/chairlift/internal/store.(*Store).Migrate",
    "net",
    "main",
    "go-imap",
    "frostyard",
    "other",
    "unverified",
  ];
  for (const frame of allowed) {
    const built = assertIssueBody({ ...base, frames: [frame] });
    assert.ok(built.body.includes(`frames: ${frame}`), frame);
  }
  // A frame of another repository is a fixed word, not its own text.
  assert.throws(
    () => assertIssueBody({ ...base, frames: ["github.com/frostyard/updex/v2/internal/index.Write"] }),
    /frame/,
  );
});

test("assertIssueBody renders an app problem with code, frames and a location", () => {
  const withCode = assertIssueBody({
    kind: "app_problem",
    class: "error",
    fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui", code: "store.migrate_failed" },
    frames: [],
    location: null,
    version: "0.15.0",
    images: [],
    key: KEY,
    glitchtipIds: [7, 9],
  });
  assert.equal(withCode.title, "Problem report: app_problem error org.frostyard.ChairLift store.migrate_failed");
  assert.match(withCode.body, /^```\nkind: app_problem\nclass: error\napp_id: org\.frostyard\.ChairLift\nruntime: go\ncomponent: gui\ncode: store\.migrate_failed\nversion: 0\.15\.0\n```$/m);
  assert.ok(withCode.body.includes("GlitchTip issue: 7, 9"));

  const withFrames = assertIssueBody({
    kind: "app_problem",
    class: "panic",
    fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "daemon" },
    frames: ["github.com/frostyard/chairlift/internal/store.Store.Write", "net", "other"],
    location: null,
    version: "0.15.0",
    images: [],
    key: KEY,
    glitchtipIds: [7],
  });
  assert.ok(withFrames.body.includes("frames: github.com/frostyard/chairlift/internal/store.Store.Write, net, other"));

  const withLocation = assertIssueBody({
    kind: "app_problem",
    class: "panic",
    fields: { app_id: "org.frostyard.ChairLift", runtime: "rust", component: "gui" },
    frames: [],
    location: "src/store/migrate.rs:42",
    version: "0.15.0",
    images: [],
    key: KEY,
    glitchtipIds: [7],
  });
  assert.ok(withLocation.body.includes("location: src/store/migrate.rs:42"));

  // A Go panic never shows a location, a Rust panic never shows frames.
  const base = {
    kind: "app_problem",
    class: "panic",
    version: "0.15.0",
    images: [],
    key: KEY,
    glitchtipIds: [7],
  };
  assert.throws(
    () =>
      assertIssueBody({
        ...base,
        fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" },
        frames: ["net"],
        location: "src/a.rs:1",
      }),
    /location_not_public/,
  );
  assert.throws(
    () =>
      assertIssueBody({
        ...base,
        fields: { app_id: "org.frostyard.ChairLift", runtime: "rust", component: "gui" },
        frames: ["net"],
        location: "src/a.rs:1",
      }),
    /frames_not_public/,
  );
  // A Go panic with no frames, and a Rust panic with no location, are filed
  // with app_id, runtime and component only.
  for (const runtime of ["go", "rust"]) {
    const bare = assertIssueBody({
      ...base,
      fields: { app_id: "org.frostyard.ChairLift", runtime, component: "gui" },
      frames: [],
      location: null,
    });
    assert.equal(
      bare.body.split("\n").slice(1, 7).join("\n"),
      ["kind: app_problem", "class: panic", "app_id: org.frostyard.ChairLift", `runtime: ${runtime}`, "component: gui", "version: 0.15.0"].join("\n"),
    );
    assert.doesNotMatch(bare.body, /^(frames|location):/m);
    assert.match(bare.body, /^Problem key: 3f2a1b4c5d6e4f70$/m);
  }
  // A class error still needs its code.
  assert.throws(
    () =>
      assertIssueBody({
        ...base,
        class: "error",
        fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" },
        frames: [],
        location: null,
      }),
    /code_missing/,
  );
});

test("parseIssueBody reads back a body the guard built", () => {
  const problem = appProblem();
  const built = issueFor(problem);
  const parsed = parseIssueBody(built.body);
  assert.equal(parsed.key, problem.key);
  assert.equal(parsed.kind, "app_problem");
  assert.equal(parsed.class, "error");
  assert.equal(parsed.fields.app_id, "org.frostyard.ChairLift");
  assert.equal(parsed.version, "0.15.0");
  assert.deepEqual(parsed.images, []);
  assert.equal(parseIssueBody("no body here"), null);
  assert.equal(parseIssueBody("```\nkind: unit_failed\n```\n"), null);
});

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

test("a key of published.json is never filed again", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", { number: 3, title: built.title, body: built.body });
  writePublishedFile(world, publishedDoc({ [KEY]: issueEntry({ number: 3 }) }));
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  assert.equal(issues(world, "frostyard/snosi").length, 1);
});

test("a search hit is adopted and no issue is filed", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", { number: 8, title: built.title, body: built.body });
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].number, 8);
  assert.equal(published.keys[KEY].repo, "frostyard/snosi");
});

test("a transferred issue is found again and no second issue is filed", async () => {
  const world = makeWorld({ labels: { "frostyard/updex": ["problem-report"] } });
  const problem = sysextProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/updex", { number: 5, title: built.title, body: built.body });
  writePublishedFile(world, publishedDoc({ [KEY]: issueEntry({ repo: "frostyard/snosi", number: 1 }) }));
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].repo, "frostyard/updex");
  assert.equal(published.keys[KEY].number, 5);
});

test("a rerun with the same facts files nothing new", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  writeFacts(world, factsDoc({ problems: [unitProblem()] }));

  assert.equal(await run(world), 0);
  assert.equal(issuePosts(world).length, 1);
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  assert.equal(issues(world, "frostyard/snosi").length, 1);
});

// ---------------------------------------------------------------------------
// Trust rule
// ---------------------------------------------------------------------------

test("an issue by another author with the key is not adopted", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  // The search command filters by author and label, so this 1 is never a hit.
  addIssue(world, "frostyard/snosi", { number: 2, title: built.title, body: built.body, author: "someone-else" });
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  assert.equal(issuePosts(world).length, 1);
  assert.equal(issues(world, "frostyard/snosi").length, 2);
});

test("a marker comment by another author is ignored", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    comments: [
      filedComment(KEY),
      {
        author: "someone-else",
        association: "MEMBER",
        body: `${markerOf({ key: KEY, cycle: 1, step: "released", boundary: "image:snow:20261120093000" })}\n\nFix released in image:snow:20261120093000.`,
        createdAt: "2026-11-20T09:00:00Z",
      },
    ],
  });
  writePublishedFile(world, publishedDoc({ [KEY]: issueEntry({ number: 1, marker: markerOf({ key: KEY, cycle: 1, step: "filed" }) }) }));
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "filed");
  assert.equal(published.keys[KEY].boundary, null);
  assert.deepEqual(commentPosts(world), []);
});

test("a Fixed in line counts only from OWNER, MEMBER or COLLABORATOR", async () => {
  // A CONTRIBUTOR line is not a record: the key stays merged, no comment.
  const outside = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = sysextProblem({ feature: "gamma", featureVersion: "1.3" });
  const built = issueFor(problem);
  addIssue(outside, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    state: "closed",
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    comments: [
      filedComment(KEY),
      { author: "a-drive-by", association: "CONTRIBUTOR", body: "Fixed in: feature gamma 1.3", createdAt: "2026-11-20T11:00:00Z" },
    ],
  });
  setSums(outside, "gamma", ["1.2", "1.3"]);
  writePublishedFile(outside, publishedDoc({ [KEY]: issueEntry({ number: 1, marker: markerOf({ key: KEY, cycle: 1, step: "filed" }) }) }));
  writeFacts(outside, factsDoc({ problems: [problem] }));
  assert.equal(await run(outside), 0);
  assert.deepEqual(commentPosts(outside), []);
  assert.equal(readPublished(outside).keys[KEY].state, "merged");

  // A MEMBER line counts, and the newest trusted line wins.
  const member = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  addIssue(member, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    state: "closed",
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    comments: [
      filedComment(KEY),
      { author: "a-drive-by", association: "CONTRIBUTOR", body: "Fixed in: feature gamma 9.9", createdAt: "2026-11-20T12:00:00Z" },
      { author: "the-owner", association: "NONE", body: "Fixed in: feature gamma 8.8", createdAt: "2026-11-20T12:30:00Z" },
      { author: "a-member", association: "MEMBER", body: "Fixed in: feature gamma 1.3", createdAt: "2026-11-20T11:00:00Z" },
    ],
  });
  setSums(member, "gamma", ["1.2", "1.3"]);
  writePublishedFile(member, publishedDoc({ [KEY]: issueEntry({ number: 1, marker: markerOf({ key: KEY, cycle: 1, step: "filed" }) }) }));
  writeFacts(member, factsDoc({ problems: [problem] }));
  assert.equal(await run(member), 0);
  const posted = commentBodies(member, "frostyard/snosi", 1).filter((body) => body.includes("step=released"));
  assert.equal(posted.length, 1);
  assert.ok(posted[0].includes("Fix released in feature:gamma:1.3."), posted[0]);
  assert.equal(readPublished(member).keys[KEY].state, "released");
  assert.deepEqual(readPublished(member).keys[KEY].feature_index, ["1.2", "1.3"]);
});

// ---------------------------------------------------------------------------
// A tracked issue in the fake GitHub, with the marker the job wrote
// ---------------------------------------------------------------------------

function setupTracked(world, problem, options = {}) {
  const {
    number = 1,
    repo = problem.repo,
    cycle = 1,
    step = "filed",
    boundary = null,
    state = step === "filed" ? "filed" : step,
    releasedDay = null,
    coveredDays = 0,
    lastCountedDay = null,
    featureIndex = null,
    closed = false,
    stateReason = null,
    closer = null,
    closedAt = null,
    extraComments = [],
  } = options;
  const built = issueFor(problem);
  const marker = markerOf({ key: problem.key, cycle, step, boundary });
  const added = addIssue(world, repo, {
    number,
    title: built.title,
    body: built.body,
    state: closed ? "closed" : "open",
    stateReason,
    closedAt,
    closer,
    comments: [{ author: "frostyard-machines", association: "MEMBER", body: marker, createdAt: "2026-11-19T00:00:00Z" }, ...extraComments],
  });
  const entry = issueEntry({
    repo,
    number: added,
    cycle,
    state,
    boundary,
    releasedDay,
    coveredDays,
    lastCountedDay,
    featureIndex,
    ids: problem.glitchtip_issue_ids,
    marker,
  });
  writePublishedFile(world, publishedDoc({ [problem.key]: entry }));
  return { entry, number: added, built };
}

// ---------------------------------------------------------------------------
// The loop steps
// ---------------------------------------------------------------------------

test("the filed step: a new problem gets 1 issue and its filed marker", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "filed");
  assert.equal(published.keys[KEY].cycle, 1);
  assert.equal(published.keys[KEY].last_comment_marker, markerOf({ key: KEY, cycle: 1, step: "filed" }));
  assert.deepEqual(commentBodies(world, "frostyard/snosi", published.keys[KEY].number), [
    markerOf({ key: KEY, cycle: 1, step: "filed" }),
  ]);
  assert.equal(calls(world, "labels/problem-report").length, 1);
});

test("a merged app issue is released at the first release with the fix commit", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.15.0" })] });
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRelease(world, "frostyard/chairlift", [
    { tag_name: "v0.14.0", published_at: "2026-11-01T00:00:00Z", draft: false, prerelease: false },
    { tag_name: "v0.15.0", published_at: "2026-11-20T12:00:00Z", draft: false, prerelease: false },
    { tag_name: "v0.16.0-rc.1", published_at: "2026-11-21T00:00:00Z", draft: false, prerelease: true },
  ]);
  setCompare(world, "frostyard/chairlift", {
    "fix1...v0.14.0": "diverged",
    "fix1...v0.15.0": "ahead",
  });
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].boundary, "app:0.15.0");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.deepEqual(commentBodies(world, "frostyard/chairlift", number).at(-1), `${markerOf({ key: KEY, cycle: 1, step: "released", boundary: "app:0.15.0" })}\n\nFix released in app:0.15.0. The job now watches reports for 14 covered days.`);
});

test("a merged system issue is released when every image has a tag", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem({
    observations: [observation({ image: "snow", version: "20261105093000" }), observation({ image: "snowfield", version: "20261106093000" })],
  });
  const { number } = setupTracked(world, problem, {
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
  });
  setRegistry(world, "snow", {
    tags: ["20261105093000", "20261120113000"],
    labels: {
      "20261105093000": imageLabels("1".repeat(40), "2026-11-05T09:30:00Z"),
      "20261120113000": imageLabels("2".repeat(40), "2026-11-20T11:30:00Z"),
    },
  });
  setRegistry(world, "snowfield", {
    tags: ["20261106093000", "20261121123000"],
    labels: {
      "20261106093000": imageLabels("3".repeat(40), "2026-11-06T09:30:00Z"),
      "20261121123000": imageLabels("4".repeat(40), "2026-11-21T12:30:00Z"),
    },
  });
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].boundary, "image:snow:20261120113000,image:snowfield:20261121123000");
  assert.equal(published.keys[KEY].released_day, "2026-11-21");
  assert.match(commentBodies(world, "frostyard/snosi", number).at(-1), /Fix released in image:snow:20261120113000,image:snowfield:20261121123000\./);
});

test("an image must have a tag, else the key waits", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem({
    observations: [observation({ image: "snow", version: "20261105093000" }), observation({ image: "floe", version: "20261106093000" })],
  });
  const { number } = setupTracked(world, problem, { closed: true, stateReason: "COMPLETED", closedAt: "2026-11-20T10:00:00Z" });
  setRegistry(world, "snow", {
    tags: ["20261120113000"],
    labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") },
  });
  // floe has no tag after the close time.
  setRegistry(world, "floe", { tags: ["20261105093000"], labels: { "20261105093000": imageLabels("2".repeat(40), "2026-11-05T09:30:00Z") } });
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(commentBodies(world, "frostyard/snosi", number), [markerOf({ key: KEY, cycle: 1, step: "filed" })]);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
});

test("a Fixed in: image comment gives an image boundary", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = sysextProblem({ feature: "gamma", featureVersion: "1.2" });
  const { number } = setupTracked(world, problem, {
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    extraComments: [
      { author: "a-member", association: "MEMBER", body: "Fixed in: image snow 20261120113000", createdAt: "2026-11-20T11:00:00Z" },
    ],
  });
  setRegistry(world, "snow", {
    tags: ["20261120113000"],
    labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") },
  });
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].boundary, "image:snow:20261120113000");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.match(commentBodies(world, "frostyard/snosi", number).at(-1), /step=released boundary=image:snow:20261120113000/);
});

test("14 covered days verify the fix, and the day counts once", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const { number } = setupTracked(world, problem, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
    coveredDays: 13,
    lastCountedDay: "2026-11-20",
  });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].covered_days, 14);
  assert.equal(published.keys[KEY].state, "verified");
  assert.deepEqual(commentBodies(world, "frostyard/snosi", number).at(-1), `${markerOf({ key: KEY, cycle: 1, step: "verified", boundary: "image:snow:20261120093000" })}\n\nNo qualifying reports observed in 14 covered days after image:snow:20261120093000.`);
});

test("a covered day counts once for each UTC day", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  setupTracked(world, problem, { step: "released", state: "released", boundary: "image:snow:20261120093000", releasedDay: "2026-11-20" });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  assert.equal(readPublished(world).keys[KEY].covered_days, 1);
  assert.equal(readPublished(world).keys[KEY].last_counted_day, DAY);
  // A second run on the same day adds nothing.
  assert.equal(await run(world), 0);
  assert.equal(readPublished(world).keys[KEY].covered_days, 1);
  // The next day counts 1 more (its own facts document).
  writeFacts(world, factsDoc({ day: "2026-11-22", problems: [], watched: [{ key: KEY, coverage: "complete" }] }));
  assert.equal(await run(world, { now: "2026-11-22T06:15:00Z" }), 0);
  assert.equal(readPublished(world).keys[KEY].covered_days, 2);
});

test("a partial watched entry, or a partial run, counts no covered day", async () => {
  const partialEntry = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  setupTracked(partialEntry, problem, { step: "released", state: "released", boundary: "image:snow:20261120093000", releasedDay: "2026-11-20" });
  writeFacts(partialEntry, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "partial" }] }));
  assert.equal(await run(partialEntry), 0);
  assert.equal(readPublished(partialEntry).keys[KEY].covered_days, 0);
  assert.equal(readPublished(partialEntry).keys[KEY].last_counted_day, null);

  const partialRun = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  setupTracked(partialRun, problem, { step: "released", state: "released", boundary: "image:snow:20261120093000", releasedDay: "2026-11-20" });
  writeFacts(partialRun, factsDoc({ status: "partial", problems: [], watched: [{ key: KEY, coverage: "complete" }] }));
  assert.equal(await run(partialRun), 0);
  assert.equal(readPublished(partialRun).keys[KEY].covered_days, 0);
});

test("a muted key is never commented on and never reopened", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem({ observations: [observation({ version: "20261121093000", lastSeenDay: "2026-11-21" })] });
  const { number } = setupTracked(world, problem, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "NOT_PLANNED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "muted");
  assert.deepEqual(commentPosts(world), []);
  assert.deepEqual(statePatches(world), []);
  assert.equal(commentBodies(world, "frostyard/snosi", number).length, 1);
});

// ---------------------------------------------------------------------------
// The regression of a released fix
// ---------------------------------------------------------------------------

test("a report at or above an app boundary reopens the issue once, cycle 2", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-21" })] });
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].cycle, 2);
  assert.equal(published.keys[KEY].state, "filed");
  assert.equal(published.keys[KEY].boundary, null);
  assert.equal(published.keys[KEY].released_day, null);
  assert.equal(statePatches(world).length, 1);
  assert.deepEqual(commentBodies(world, "frostyard/chairlift", number).at(-1), `${markerOf({ key: KEY, cycle: 2, step: "regressed", boundary: "app:0.15.0" })}\n\nSeen again in app:0.16.0, at or after the fix release app:0.15.0.`);
});

test("an app report below the fix boundary opens nothing", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.14.0", lastSeenDay: "2026-11-21" })] });
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].covered_days, 1);
  assert.deepEqual(statePatches(world), []);
  assert.deepEqual(commentPosts(world), []);
});

test("a report seen before the released day opens nothing", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-19" })] });
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(statePatches(world), []);
  assert.equal(readPublished(world).keys[KEY].state, "released");
});

test("an image boundary regresses only on an image of the boundary", async () => {
  const inside = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem({ observations: [observation({ image: "snow", version: "20261121093000", lastSeenDay: "2026-11-21" })] });
  setupTracked(inside, problem, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(inside, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));
  assert.equal(await run(inside), 0);
  assert.equal(statePatches(inside).length, 1);
  assert.ok(commentBodies(inside, "frostyard/snosi", 1).at(-1).includes("Seen again in image:snow:20261121093000"));

  // An image that is not in the boundary does not qualify.
  const outside = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const other = unitProblem({ observations: [observation({ image: "floe", version: "20261121093000", lastSeenDay: "2026-11-21" })] });
  setupTracked(outside, other, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(outside, factsDoc({ problems: [other], watched: [{ key: KEY, coverage: "complete" }] }));
  assert.equal(await run(outside), 0);
  assert.deepEqual(statePatches(outside), []);
  assert.equal(readPublished(outside).keys[KEY].state, "released");
});

test("a feature boundary regresses on its own version or on a version outside the index", async () => {
  const cases = [
    { name: "the boundary version", featureVersion: "1.2", reopens: true },
    { name: "a version not in the index", featureVersion: "1.9", reopens: true },
    { name: "a listed older version", featureVersion: "1.1", reopens: false },
  ];
  for (const item of cases) {
    const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
    const problem = sysextProblem({
      feature: "gamma",
      featureVersion: item.featureVersion,
      observations: [observation({ featureVersion: item.featureVersion, lastSeenDay: "2026-11-21" })],
    });
    setupTracked(world, problem, {
      step: "released",
      state: "released",
      boundary: "feature:gamma:1.2",
      releasedDay: "2026-11-20",
      featureIndex: ["1.1", "1.2"],
      closed: true,
      stateReason: "COMPLETED",
      closedAt: "2026-11-20T12:00:00Z",
    });
    writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));
    assert.equal(await run(world), 0, item.name);
    assert.equal(statePatches(world).length, item.reopens ? 1 : 0, item.name);
    assert.equal(readPublished(world).keys[KEY].cycle, item.reopens ? 2 : 1, item.name);
  }
});

test("cycle 2 keeps its number through the next close and release", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-21" })] });
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));
  assert.equal(await run(world), 0);
  assert.ok(commentBodies(world, "frostyard/chairlift", 1).at(-1).includes("cycle=2 step=regressed"));

  // The owner closes it again from the next fix PR, and that release ships.
  const state = ghState(world);
  const issue = state.repos["frostyard/chairlift"].issues[0];
  issue.state = "closed";
  issue.stateReason = "COMPLETED";
  issue.closedAt = "2026-11-21T13:00:00Z";
  issue.closer = { type: "PullRequest", sha: "fix2" };
  writeGh(world, state);
  setRelease(world, "frostyard/chairlift", [{ tag_name: "v0.17.0", published_at: "2026-11-21T14:00:00Z", draft: false, prerelease: false }]);
  setCompare(world, "frostyard/chairlift", { "fix2...v0.17.0": "identical" });
  writeFacts(world, factsDoc({ day: "2026-11-22", problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world, { now: "2026-11-22T06:15:00Z" }), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].cycle, 2);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].boundary, "app:0.17.0");
  assert.ok(commentBodies(world, "frostyard/chairlift", 1).at(-1).includes("cycle=2 step=released boundary=app:0.17.0"));
});

// ---------------------------------------------------------------------------
// The limits of a run
// ---------------------------------------------------------------------------

const keyOf = (n) => n.toString(16).padStart(16, "0");

function sevenProblems() {
  return [
    unitProblem({ key: keyOf(1), unit: "one.service", firstSeenDay: "2026-11-01" }),
    unitProblem({ key: keyOf(2), unit: "two.service", firstSeenDay: "2026-11-02" }),
    unitProblem({ key: keyOf(3), unit: "three.service", firstSeenDay: "2026-11-03" }),
    appProblem({ key: keyOf(4), observations: [observation({ image: "snow", version: "0.15.0" })], firstSeenDay: "2026-11-04" }),
    appProblem({ key: keyOf(5), appId: "org.frostyard.nsl", repo: "frostyard/nsl", observations: [observation({ image: "snow", version: "0.15.0" })], firstSeenDay: "2026-11-05" }),
    appProblem({ key: keyOf(6), observations: [observation({ image: "snow", version: "0.16.0" })], firstSeenDay: "2026-11-06" }),
    appProblem({ key: keyOf(7), appId: "org.frostyard.nsl", repo: "frostyard/nsl", observations: [observation({ image: "snow", version: "0.16.0" })], firstSeenDay: "2026-11-07" }),
  ];
}

test("at most 5 new issues, at most 2 for each repository, oldest first", async () => {
  const world = makeWorld({
    labels: { "frostyard/snosi": ["problem-report"], "frostyard/chairlift": ["problem-report"], "frostyard/nsl": ["problem-report"] },
  });
  const problems = sevenProblems();
  writeFacts(world, factsDoc({ problems }));

  assert.equal(await run(world), 0);
  assert.equal(issuePosts(world).length, 5);
  const snosi = issues(world, "frostyard/snosi").length;
  const chairlift = issues(world, "frostyard/chairlift").length;
  const nsl = issues(world, "frostyard/nsl").length;
  assert.deepEqual([snosi, chairlift, nsl], [2, 2, 1]);
  // The oldest first_seen_day first: keys 1, 2 (snosi), 4, 6 (chairlift), 5 (nsl).
  const published = readPublished(world);
  assert.deepEqual(Object.keys(published.keys).sort(), [keyOf(1), keyOf(2), keyOf(4), keyOf(5), keyOf(6)].sort());
  const health = readHealth(world);
  assert.equal(health.runs.at(-1).deferred.new_issues, 2);

  // The rest is filed by the next run, in the same order.
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.equal(issuePosts(world).length, 2);
  assert.deepEqual(Object.keys(readPublished(world).keys).sort(), problems.map((problem) => problem.key).sort());
});

test("a repository without the label defers the problem and creates no label", async () => {
  const world = makeWorld({ labels: {} });
  writeFacts(world, factsDoc({ problems: [unitProblem()] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  // The label is read once and never created.
  assert.equal(calls(world, "repos/frostyard/snosi/labels").length, 1);
  assert.deepEqual(
    ghState(world).calls.filter((call) => call[0] === "api" && String(call[1]).includes("/labels") && call.includes("POST")),
    [],
  );
  assert.deepEqual(commentPosts(world), []);
  const health = readHealth(world);
  assert.equal(health.runs.at(-1).deferred.no_label, 1);
});

test("at most 10 comments a run, the rest next run", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const keys = [];
  const entries = {};
  const problems = [];
  for (let i = 1; i <= 12; i += 1) {
    const key = keyOf(i);
    keys.push(key);
    const problem = unitProblem({ key, unit: `unit-${i}.service` });
    problems.push(problem);
    const built = issueFor(problem);
    const marker = markerOf({ key, cycle: 1, step: "released", boundary: "image:snow:20261120093000" });
    addIssue(world, "frostyard/snosi", {
      number: i,
      title: built.title,
      body: built.body,
      comments: [{ author: "frostyard-machines", association: "MEMBER", body: marker, createdAt: "2026-11-19T00:00:00Z" }],
    });
    entries[key] = issueEntry({
      number: i,
      step: "released",
      state: "released",
      boundary: "image:snow:20261120093000",
      releasedDay: "2026-11-20",
      coveredDays: 13,
      lastCountedDay: "2026-11-20",
      marker,
    });
  }
  writePublishedFile(world, publishedDoc(entries));
  writeFacts(world, factsDoc({ problems: [], watched: keys.map((key) => ({ key, coverage: "complete" })) }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  const verified = keys.filter((key) => published.keys[key].state === "verified");
  assert.equal(verified.length, 10);
  assert.equal(readHealth(world).runs.at(-1).deferred.comments, 2);
  assert.equal(commentPosts(world).length, 10);
});

test("the call budget defers the work and still writes the health issue", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  writeFacts(world, factsDoc({ problems: [unitProblem()] }));

  assert.equal(await run(world, { hooks: { limit: 8 } }), 0);
  const health = readHealth(world);
  assert.equal(health.runs.at(-1).deferred.budget > 0, true);
  const body = ghState(world).repos["frostyard/problem-intake"].issues[0].body;
  assert.ok(body.includes("- work deferred: yes"), body);
  assert.deepEqual(issuePosts(world), []);
});

// ---------------------------------------------------------------------------
// Recovery: the markers are the truth, and no action is repeated
// ---------------------------------------------------------------------------

test("a crash after the create files no second issue, and the marker follows", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  writeFacts(world, factsDoc({ problems: [unitProblem()] }));

  const crash = {
    afterAction(name) {
      if (name === "create") throw new Error("crash after create");
    },
  };
  assert.equal(await run(world, { hooks: crash }), 1);
  assert.equal(issues(world, "frostyard/snosi").length, 1);
  assert.equal(readPublished(world).keys[KEY], undefined);

  // The next run finds the issue by its key: no second issue.
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  assert.equal(issues(world, "frostyard/snosi").length, 1);
  assert.equal(readPublished(world).keys[KEY].state, "filed");

  // The run after that posts the filed marker of the issue with none.
  assert.equal(await run(world), 0);
  assert.deepEqual(commentBodies(world, "frostyard/snosi", 1), [markerOf({ key: KEY, cycle: 1, step: "filed" })]);
  assert.equal(readPublished(world).keys[KEY].last_comment_marker, markerOf({ key: KEY, cycle: 1, step: "filed" }));
});

test("a crash after a comment repeats no comment", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.15.0" })] });
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRelease(world, "frostyard/chairlift", [{ tag_name: "v0.15.0", published_at: "2026-11-20T12:00:00Z", draft: false, prerelease: false }]);
  setCompare(world, "frostyard/chairlift", { "fix1...v0.15.0": "ahead" });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  const crash = {
    afterAction(name) {
      if (name === "comment") throw new Error("crash after comment");
    },
  };
  assert.equal(await run(world, { hooks: crash }), 1);
  assert.equal(commentBodies(world, "frostyard/chairlift", number).length, 2);
  assert.equal(readPublished(world).keys[KEY].state, "merged");

  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(commentBodies(world, "frostyard/chairlift", number).length, 2);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].boundary, "app:0.15.0");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.equal(published.keys[KEY].covered_days, 1);
});

test("a crash after a reopen reopens nothing twice", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-21" })] });
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  const crash = {
    afterAction(name) {
      if (name === "reopen") throw new Error("crash after reopen");
    },
  };
  assert.equal(await run(world, { hooks: crash }), 1);
  // The reopen landed before the crash, and then the comment: the state is
  // cycle 2 and the issue is open. The next run repeats no action.
  assert.equal(issues(world, "frostyard/chairlift")[0].state, "open");
  assert.equal(commentBodies(world, "frostyard/chairlift", number).filter((body) => body.includes("step=regressed")).length, 1);
  assert.equal(readPublished(world).keys[KEY].cycle, 2);

  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.deepEqual(statePatches(world), []);
  assert.equal(readPublished(world).keys[KEY].cycle, 2);
});

test("a lost published.json is rebuilt from the markers, with no action repeated", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/chairlift", {
    number: 1,
    title: built.title,
    body: built.body,
    comments: [
      filedComment(KEY),
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "released", boundary: "app:0.15.0" }) + "\n\nFix released.", createdAt: "2026-11-20T09:00:00Z" },
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "verified", boundary: "app:0.15.0" }) + "\n\nNo reports.", createdAt: "2026-11-20T10:00:00Z" },
    ],
  });
  setRelease(world, "frostyard/chairlift", [{ tag_name: "v0.15.0", published_at: "2026-11-20T12:00:00Z", draft: false, prerelease: false }]);
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "verified");
  assert.equal(published.keys[KEY].cycle, 1);
  assert.equal(published.keys[KEY].boundary, "app:0.15.0");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.equal(published.keys[KEY].covered_days, 0);
  assert.equal(published.keys[KEY].last_counted_day, null);
  assert.deepEqual(issuePosts(world), []);
  assert.deepEqual(commentPosts(world), []);
});

test("a lost published.json restores an image released day from the label", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    comments: [
      filedComment(KEY),
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "released", boundary: "image:snow:20261120113000" }), createdAt: "2026-11-20T09:00:00Z" },
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "verified", boundary: "image:snow:20261120113000" }), createdAt: "2026-11-20T10:00:00Z" },
    ],
  });
  setRegistry(world, "snow", { tags: ["20261120113000"], labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") } });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "verified");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.equal(published.keys[KEY].covered_days, 0);
  assert.deepEqual(commentPosts(world), []);
});

test("a lost published.json takes the recovery day for a feature boundary", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = sysextProblem({ feature: "gamma", featureVersion: "1.2" });
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    comments: [
      filedComment(KEY),
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "released", boundary: "feature:gamma:1.2" }), createdAt: "2026-11-20T09:00:00Z" },
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "verified", boundary: "feature:gamma:1.2" }), createdAt: "2026-11-20T10:00:00Z" },
    ],
  });
  setSums(world, "gamma", ["1.1", "1.2"]);
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].released_day, DAY);
  assert.deepEqual(published.keys[KEY].feature_index, ["1.1", "1.2"]);
  assert.deepEqual(commentPosts(world), []);
});

test("a failed source read keeps the key in recovery, and the next run completes it", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    comments: [
      filedComment(KEY),
      { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "released", boundary: "image:snow:20261120113000" }), createdAt: "2026-11-20T09:00:00Z" },
    ],
  });
  // No registry fixture: the read fails, so the key stays in recovery.
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  let published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].released_day, null);
  assert.equal(published.keys[KEY].covered_days, 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery > 0, true);

  // The fixture is there on the next run: the key leaves recovery.
  setRegistry(world, "snow", { tags: ["20261120113000"], labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") } });
  resetCalls(world);
  assert.equal(await run(world), 0);
  published = readPublished(world);
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.equal(published.keys[KEY].covered_days, 1);
  assert.deepEqual(commentPosts(world), []);
});

// ---------------------------------------------------------------------------
// A stale or invalid facts.json
// ---------------------------------------------------------------------------

test("facts from yesterday write the health status only", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  setupTracked(world, problem, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
  });
  writeFacts(world, factsDoc({ day: "2026-11-20", problems: [], watched: [{ key: KEY, coverage: "complete" }] }));
  const before = readFileSync(join(world.stateDir, "published.json"), "utf8");

  assert.equal(await run(world), 0);
  assert.equal(readHealth(world).runs.at(-1).status, "error");
  assert.deepEqual(readHealth(world).runs.at(-1).notes, ["stale_facts"]);
  assert.equal(readFileSync(join(world.stateDir, "published.json"), "utf8"), before);
  for (const call of ghState(world).calls) {
    assert.ok(String(call[1]).startsWith("repos/frostyard/problem-intake"), `only the health issue: ${call.join(" ")}`);
  }
  assert.ok(ghState(world).repos["frostyard/problem-intake"].issues.length >= 1);
  assert.equal(readHeartbeat(world), DAY);
});

test("facts that fail assertFacts write the health status only", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  setupTracked(world, problem, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
  });
  // A report id is a forbidden key at any depth: the document is refused.
  const bad = factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] });
  bad.problems[0].report_id = "0f0f0f0f-0000-4000-8000-000000000000";
  writeFileSync(join(world.stateDir, "facts.json"), `${JSON.stringify(bad, null, 2)}\n`);
  const before = readFileSync(join(world.stateDir, "published.json"), "utf8");

  assert.equal(await run(world), 0);
  assert.equal(readHealth(world).runs.at(-1).status, "error");
  assert.deepEqual(readHealth(world).runs.at(-1).notes, ["invalid_facts"]);
  assert.equal(readFileSync(join(world.stateDir, "published.json"), "utf8"), before);
  assert.equal(readPublished(world).keys[KEY].covered_days, 0);
  for (const call of ghState(world).calls) {
    assert.ok(String(call[1]).startsWith("repos/frostyard/problem-intake"), `only the health issue: ${call.join(" ")}`);
  }
});

test("a missing facts.json is stale mode too", async () => {
  const world = makeWorld({ labels: {} });
  assert.equal(await run(world), 0);
  assert.equal(readHealth(world).runs.at(-1).status, "error");
  assert.deepEqual(readHealth(world).runs.at(-1).notes, ["no_facts"]);
});

// ---------------------------------------------------------------------------
// The health issue
// ---------------------------------------------------------------------------

test("the health issue is created with a body of no digit and no day", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  writeFacts(world, factsDoc({ problems: [unitProblem()], notes: ["checkout_failed"], tokenAgeDays: 15 }));

  assert.equal(await run(world), 0);
  const health = ghState(world).repos["frostyard/problem-intake"].issues;
  assert.equal(health.length, 1);
  assert.equal(health[0].title, "Problem triage health");
  assert.deepEqual(health[0].labels, ["problem-report"]);
  assert.equal(
    health[0].body,
    [
      "Operational status of the problem-intake triage job. The job rewrites this text on each run. It holds no day and no count.",
      "",
      "- run status: ok",
      "- run notes: checkout_failed",
      "- token rotation due: no",
      "- work deferred: no",
    ].join("\n"),
  );
  assert.doesNotMatch(health[0].body, /[0-9]/);
  assert.equal(readHeartbeat(world), DAY);
  assert.equal(readHealth(world).runs.at(-1).day, DAY);
});

test("the health body is rewritten only when it differs", async () => {
  const world = makeWorld({ labels: {} });
  writeFacts(world, factsDoc({}));
  assert.equal(await run(world), 0);
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(statePatches(world), []);

  writeFacts(world, factsDoc({ status: "unreachable" }));
  assert.equal(await run(world), 0);
  assert.equal(statePatches(world).length, 1);
  assert.ok(ghState(world).repos["frostyard/problem-intake"].issues[0].body.includes("- run status: unreachable"));
});

test("a comment is added only when the status turns from ok", async () => {
  const world = makeWorld({ labels: {} });
  writeFacts(world, factsDoc({}));
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);

  writeFacts(world, factsDoc({ status: "auth" }));
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);
  assert.match(
    commentBodies(world, "frostyard/problem-intake", 1).at(-1),
    /^<!-- problem-triage-health:1 id=[0-9a-f]{16} -->\n\nThe triage job run status changed from ok to auth\.$/,
  );

  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);
});

test("the rotation comment is written once, from token day 335", async () => {
  const world = makeWorld({ labels: {} });
  writeFacts(world, factsDoc({ tokenAgeDays: 334 }));
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);

  writeFacts(world, factsDoc({ tokenAgeDays: 335 }));
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);
  assert.match(
    commentBodies(world, "frostyard/problem-intake", 1).at(-1),
    /^<!-- problem-triage-health:1 id=[0-9a-f]{16} -->\n\nThe GlitchTip read token is due for rotation\.$/,
  );
  assert.ok(ghState(world).repos["frostyard/problem-intake"].issues[0].body.includes("- token rotation due: yes"));

  writeFacts(world, factsDoc({ tokenAgeDays: 336 }));
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);
});

test("assertPublicText refuses a day and a number that is not a version", async () => {
  const { assertPublicText } = await import("../../scripts/triage/lib/issue.mjs");
  assert.equal(assertPublicText("Fix released in app:0.15.0."), "Fix released in app:0.15.0.");
  assert.throws(() => assertPublicText("Seen on 2026-11-20."), /text_day/);
  assert.throws(() => assertPublicText("Seen 3 times."), /text_number/);
  assert.throws(() => assertPublicText("ok 1", { noDigits: true }), /text_digit/);
});

// ---------------------------------------------------------------------------
// The counter of the GitHub client and the close-the-loop helpers
// ---------------------------------------------------------------------------

test("the GitHub client counts each call and refuses the call over its limit", async () => {
  const { createGitHub, BudgetError } = await import("../../scripts/triage/lib/github.mjs");
  const world = makeWorld({ labels: {} });
  const github = createGitHub({ env: world.env, limit: 1 });
  assert.equal(github.used(), 0);
  assert.equal(github.remaining(), 1);
  assert.deepEqual(await github.api("repos/frostyard/problem-intake/issues"), []);
  assert.equal(github.used(), 1);
  assert.equal(github.remaining(), 0);
  assert.throws(() => github.api("repos/frostyard/problem-intake/issues"), (error) => error instanceof BudgetError && error.code === "budget");
  assert.equal(github.used(), 1);
});

test("the markers round-trip and the step order is (cycle, rank)", async () => {
  const { formatMarker, parseMarker, highestMarker, isHigherStep, STEP_RANK } = await import("../../scripts/triage/lib/loop.mjs");
  const marker = formatMarker({ key: KEY, cycle: 2, step: "released", boundary: "app:0.15.0" });
  assert.equal(marker, "<!-- problem-triage:1 key=3f2a1b4c5d6e4f70 cycle=2 step=released boundary=app:0.15.0 -->");
  assert.deepEqual(parseMarker(marker), { key: KEY, cycle: 2, step: "released", boundary: "app:0.15.0", marker });
  assert.equal(parseMarker(formatMarker({ key: KEY, cycle: 1, step: "filed" })).boundary, null);
  assert.equal(parseMarker("<!-- problem-triage:1 key=zzz cycle=1 step=filed boundary=none -->"), null);
  assert.equal(parseMarker("Fix released in app:0.15.0."), null);
  assert.equal(parseMarker("<!-- problem-triage:1 key=3f2a1b4c5d6e4f70 cycle=1 step=filed boundary=nonsense -->"), null);
  assert.deepEqual(STEP_RANK, { filed: 0, regressed: 0, released: 1, verified: 2 });
  const best = highestMarker([
    { cycle: 1, step: "released", key: KEY, boundary: null, marker: "a" },
    { cycle: 1, step: "verified", key: KEY, boundary: null, marker: "b" },
    { cycle: 2, step: "filed", key: KEY, boundary: null, marker: "c" },
  ]);
  assert.equal(best.marker, "c");
  assert.equal(isHigherStep({ cycle: 2, step: "filed" }, { cycle: 1, step: "verified" }), true);
  assert.equal(isHigherStep({ cycle: 1, step: "filed" }, { cycle: 1, step: "released" }), false);
});

test("semver precedence and the 14 digit image order", async () => {
  const { compareSemver, compareImage } = await import("../../scripts/triage/lib/loop.mjs");
  assert.equal(compareSemver("0.15.0", "0.15.0"), 0);
  assert.equal(compareSemver("0.15.0", "0.14.9"), 1);
  assert.equal(compareSemver("0.9.0", "0.10.0"), -1);
  assert.equal(compareSemver("0.15.0-rc.1", "0.15.0"), -1);
  assert.equal(compareSemver("0.15.0-alpha.2", "0.15.0-beta.1"), -1);
  assert.equal(compareSemver("0.15.0-beta.2", "0.15.0-beta.10"), -1);
  assert.throws(() => compareSemver("0.15", "0.15.0"));
  assert.equal(compareImage("20261120113000", "20261120113000"), 0);
  assert.equal(compareImage("20261120113000", "20261120103000"), 1);
});

test("a fix boundary parses and formats, and a qualifying report is the highest 1", async () => {
  const { parseBoundary, formatBoundary, qualifying } = await import("../../scripts/triage/lib/loop.mjs");
  for (const text of ["app:0.15.0", "image:snow:20261120093000", "image:snow:20261120093000,image:floe:20261121093000", "feature:gamma:1.2"]) {
    assert.equal(formatBoundary(parseBoundary(text)), text);
  }
  assert.equal(parseBoundary("image:snow:2026112009300"), null);
  assert.equal(parseBoundary("app:0.15"), null);
  assert.equal(parseBoundary("nonsense"), null);

  const observations = [
    observation({ image: "snow", version: "0.15.0", lastSeenDay: "2026-11-21" }),
    observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-21" }),
    observation({ image: "snow", version: "0.17.0", lastSeenDay: "2026-11-19" }),
  ];
  assert.equal(qualifying(parseBoundary("app:0.15.0"), observations, "2026-11-20").version, "0.16.0");
  assert.equal(qualifying(parseBoundary("app:0.17.0"), observations, "2026-11-20"), null);
  assert.equal(qualifying(parseBoundary("app:0.15.0"), observations, null), null);
});

test("parseFixedIn takes the newest trusted comment, and countCoveredDay the 3 rules", async () => {
  const { parseFixedIn, countCoveredDay } = await import("../../scripts/triage/lib/loop.mjs");
  const comments = [
    { author: "x", authorAssociation: "MEMBER", body: "Fixed in: image snow 20261120113000", createdAt: "2026-11-20T09:00:00Z" },
    { author: "y", authorAssociation: "NONE", body: "Fixed in: feature gamma 9.9", createdAt: "2026-11-20T10:00:00Z" },
    { author: "z", authorAssociation: "OWNER", body: "Fixed in: feature gamma 1.3", createdAt: "2026-11-20T11:00:00Z" },
  ];
  assert.deepEqual(parseFixedIn(comments), {
    type: "feature",
    name: "gamma",
    version: "1.3",
    comment: "Fixed in: feature gamma 1.3",
    createdAt: "2026-11-20T11:00:00Z",
  });
  assert.equal(parseFixedIn([{ author: "x", authorAssociation: "CONTRIBUTOR", body: "Fixed in: feature gamma 1.3" }]), null);
  assert.equal(parseFixedIn([]), null);

  const entry = { last_counted_day: null };
  assert.equal(countCoveredDay(entry, { runStatus: "ok", watched: { coverage: "complete" }, today: DAY }), true);
  assert.equal(countCoveredDay(entry, { runStatus: "partial", watched: { coverage: "complete" }, today: DAY }), false);
  assert.equal(countCoveredDay(entry, { runStatus: "ok", watched: { coverage: "partial" }, today: DAY }), false);
  assert.equal(countCoveredDay(entry, { runStatus: "ok", watched: null, today: DAY }), false);
  assert.equal(countCoveredDay({ last_counted_day: DAY }, { runStatus: "ok", watched: { coverage: "complete" }, today: DAY }), false);
});

test("the 10 minute deadline stops the loop work and keeps the health issue", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  writeFacts(world, factsDoc({ problems: [unitProblem()] }));
  let reads = 0;
  const clock = () => {
    reads += 1;
    // The first reading starts the run; every later 1 is 30 seconds past the
    // 10 minute deadline, inside the 60 second reserve of the health phase.
    return reads === 1 ? 0 : 10 * 60 * 1000 + 30 * 1000;
  };

  assert.equal(await run(world, { hooks: { clock } }), 0);
  assert.deepEqual(issuePosts(world), []);
  const entry = readHealth(world).runs.at(-1);
  assert.equal(entry.deferred.deadline > 0, true);
  assert.ok(ghState(world).repos["frostyard/problem-intake"].issues[0].body.includes("- work deferred: yes"));
});

test("health.json keeps the reader's keys, and a key takes its GlitchTip ids", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem({ ids: [7] });
  setupTracked(world, problem, {
    step: "released",
    state: "released",
    boundary: "image:snow:20261120093000",
    releasedDay: "2026-11-20",
  });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [],
    last_read: { 7: "2026-11-20" },
    issue_keys: { 9: KEY, 11: KEY },
  });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const health = readHealth(world);
  assert.equal(health.schema, "frostyard.problem-triage-health/1");
  assert.deepEqual(health.last_read, { 7: "2026-11-20" });
  assert.deepEqual(health.issue_keys, { 9: KEY, 11: KEY });
  assert.equal(health.runs.length, 1);
  assert.deepEqual(readPublished(world).keys[KEY].glitchtip_issue_ids, [7, 9, 11]);
});

test("the health.json run list keeps the last 7 runs", async () => {
  const world = makeWorld({ labels: {} });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: Array.from({ length: 7 }, (_, i) => ({ day: `2026-11-1${i + 1}`, status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false })),
    last_read: {},
    issue_keys: {},
  });
  writeFacts(world, factsDoc({}));
  assert.equal(await run(world), 0);
  const runs = readHealth(world).runs;
  assert.equal(runs.length, 7);
  assert.equal(runs.at(-1).day, DAY);
  // The oldest of the 7 old runs is dropped.
  assert.equal(runs[0].day, "2026-11-12");
});

// ---------------------------------------------------------------------------
// The review points
// ---------------------------------------------------------------------------

test("a lower marker is the truth too: the entry follows it and drops lost progress", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  // The issue holds only the filed marker of cycle 1; the entry claims the
  // regressed step of cycle 2, with progress that was never confirmed.
  addIssue(world, "frostyard/snosi", { number: 1, title: built.title, body: built.body, comments: [filedComment(KEY)] });
  writePublishedFile(
    world,
    publishedDoc({
      [KEY]: issueEntry({
        number: 1,
        cycle: 2,
        state: "filed",
        boundary: null,
        releasedDay: "2026-11-20",
        coveredDays: 3,
        lastCountedDay: "2026-11-20",
        marker: markerOf({ key: KEY, cycle: 2, step: "regressed" }),
      }),
    }),
  );
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].cycle, 1);
  assert.equal(published.keys[KEY].last_comment_marker, markerOf({ key: KEY, cycle: 1, step: "filed" }));
  assert.equal(published.keys[KEY].covered_days, 0);
  assert.equal(published.keys[KEY].last_counted_day, null);
  assert.equal(published.keys[KEY].released_day, null);
  assert.equal(published.keys[KEY].feature_index, null);
});

test("a failed regressed comment changes no state and repeats no cycle", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-21" })] });
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  // The comment POST fails with HTTP 500: the issue is never reopened.
  const state = ghState(world);
  state.failCommentPost = 1;
  writeGh(world, state);
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 1);
  assert.equal(issues(world, "frostyard/chairlift")[0].state, "closed");
  // The comment never landed, so the entry still says released, cycle 1.
  const failed = readPublished(world).keys[KEY];
  assert.equal(failed.cycle, 1);
  assert.equal(failed.state, "released");
  assert.equal(failed.boundary, "app:0.15.0");
  assert.equal(failed.last_comment_marker, markerOf({ key: KEY, cycle: 1, step: "released", boundary: "app:0.15.0" }));

  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.equal(statePatches(world).length, 1);
  const regressed = commentBodies(world, "frostyard/chairlift", number).filter((body) => body.includes("step=regressed"));
  assert.equal(regressed.length, 1);
  assert.ok(regressed[0].startsWith(markerOf({ key: KEY, cycle: 2, step: "regressed", boundary: "app:0.15.0" })));
  assert.equal(readPublished(world).keys[KEY].cycle, 2);
  assert.equal(readPublished(world).keys[KEY].state, "filed");
});

test("compare calls that pass the soft limit still leave the health issue", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  // 20 merged keys of 1 repository, and 40 releases that no 1 of contains: the
  // binary search of each key spends compare calls until the soft limit stops
  // the loop work.
  const entries = {};
  for (let i = 1; i <= 20; i += 1) {
    const key = keyOf(i);
    const problem = appProblem({ key, observations: [observation({ image: "snow", version: `0.${i}.0` })] });
    const built = issueFor(problem);
    const marker = markerOf({ key, cycle: 1, step: "filed" });
    addIssue(world, "frostyard/chairlift", {
      number: i,
      title: built.title,
      body: built.body,
      state: "closed",
      stateReason: "COMPLETED",
      closedAt: "2026-11-20T00:00:00Z",
      closer: { type: "PullRequest", sha: `fix${i}` },
      comments: [{ author: "frostyard-machines", association: "MEMBER", body: marker, createdAt: "2026-11-19T00:00:00Z" }],
    });
    entries[key] = issueEntry({ repo: "frostyard/chairlift", number: i, marker });
  }
  writePublishedFile(world, publishedDoc(entries));
  setRelease(
    world,
    "frostyard/chairlift",
    Array.from({ length: 40 }, (_, i) => ({
      tag_name: `v1.${i}.0`,
      published_at: new Date(Date.parse("2026-12-31T12:00:00Z") - i * 3_600_000).toISOString(),
      draft: false,
      prerelease: false,
    })),
  );
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world, { hooks: { limit: 20 } }), 0);
  const entry = readHealth(world).runs.at(-1);
  assert.equal(entry.deferred.budget > 0, true);
  assert.ok(ghState(world).repos["frostyard/problem-intake"].issues[0].body.includes("- work deferred: yes"));
  assert.equal(readHeartbeat(world), DAY);
  assert.equal(calls(world).length < 20, true);
});

test("a NOT_FOUND GraphQL answer is used, so 1 deleted issue stops nothing", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const first = unitProblem({ key: keyOf(1), unit: "one.service" });
  const second = unitProblem({ key: keyOf(2), unit: "two.service" });
  const built = issueFor(first);
  // The entry of key 1 points at issue 1, which the fake GitHub does not hold.
  addIssue(world, "frostyard/snosi", { number: 2, title: issueFor(second).title, body: issueFor(second).body, comments: [filedComment(keyOf(2))] });
  writePublishedFile(
    world,
    publishedDoc({
      [keyOf(1)]: issueEntry({ number: 1, marker: markerOf({ key: keyOf(1), cycle: 1, step: "filed" }) }),
      [keyOf(2)]: issueEntry({ number: 2, marker: markerOf({ key: keyOf(2), cycle: 1, step: "filed" }) }),
    }),
  );
  writeFacts(world, factsDoc({ problems: [], watched: [] }));

  assert.equal(await run(world), 0);
  // The other key was synced, so the run went on after the NOT_FOUND answer.
  const published = readPublished(world);
  assert.equal(published.keys[keyOf(2)].state, "filed");
  assert.ok(built.title.length > 0);
});

test("a GraphQL answer with another error type is refused", async () => {
  const world = makeWorld({ labels: {} });
  const state = ghState(world);
  state.graphqlErrors = [{ type: "FORBIDDEN", message: "no" }];
  writeGh(world, state);
  const { createGitHub, GitHubError } = await import("../../scripts/triage/lib/github.mjs");
  const github = createGitHub({ env: world.env });
  const query = "query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { i1: issue(number: 1) } }";
  assert.throws(
    () => github.graphql(query, { owner: "frostyard", name: "snosi" }),
    (error) => error instanceof GitHubError && error.code === "graphql_errors",
  );
});

test("a Fixed in line with CRLF counts, and an image id outside the enum never does", async () => {
  const { parseFixedIn } = await import("../../scripts/triage/lib/loop.mjs");
  const crlf = [
    {
      author: "a-member",
      authorAssociation: "MEMBER",
      body: "Note.\r\nFixed in: image snow 20261120113000\r\nFixed in: image floe 20261121123000\r\n",
      createdAt: "2026-11-20T11:00:00Z",
    },
  ];
  assert.deepEqual(parseFixedIn(crlf).images, [
    { id: "snow", version: "20261120113000" },
    { id: "floe", version: "20261121123000" },
  ]);
  // An id that is not 1 of the schema images is not a Fixed in line.
  const bogus = [
    {
      author: "a-member",
      authorAssociation: "MEMBER",
      body: "Fixed in: image snow\r\nX 20261120113000",
      createdAt: "2026-11-20T11:00:00Z",
    },
  ];
  assert.equal(parseFixedIn(bogus), null);
  assert.equal(
    parseFixedIn([{ author: "a-member", authorAssociation: "MEMBER", body: "Fixed in: image bogus 20261120113000" }]),
    null,
  );
});

test("a marker comment with CRLF is read", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  const released = markerOf({ key: KEY, cycle: 1, step: "released", boundary: "image:snow:20261120113000" });
  addIssue(world, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    comments: [
      { author: "frostyard-machines", association: "MEMBER", body: `${markerOf({ key: KEY, cycle: 1, step: "filed" })}\r\n`, createdAt: "2026-11-19T00:00:00Z" },
      { author: "frostyard-machines", association: "MEMBER", body: `${released}\r\n\r\nFix released.\r\n`, createdAt: "2026-11-20T09:00:00Z" },
    ],
  });
  setRegistry(world, "snow", { tags: ["20261120113000"], labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") } });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  // published.json is lost: the rebuild reads the markers of the issue.
  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].boundary, "image:snow:20261120113000");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.deepEqual(commentPosts(world), []);
});

test("a created label with an offset and a fraction is compared by its instant", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const { number } = setupTracked(world, problem, { closed: true, stateReason: "COMPLETED", closedAt: "2026-11-20T11:30:00Z" });
  // The same instant as the close time, in another written form.
  setRegistry(world, "snow", {
    tags: ["20261120113000"],
    labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00.123456789+00:00") },
  });
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].boundary, "image:snow:20261120113000");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.match(commentBodies(world, "frostyard/snosi", number).at(-1), /Fix released in image:snow:20261120113000\./);
});

test("a release published at a fractional second after the close counts", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  // Just after the close, in another written form, and with no closer.
  setRelease(world, "frostyard/chairlift", [{ tag_name: "v0.15.0", published_at: "2026-11-20T12:00:00.500+00:00", draft: false, prerelease: false }]);
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  assert.equal(readPublished(world).keys[KEY].state, "released");
  assert.equal(readPublished(world).keys[KEY].boundary, "app:0.15.0");
});

test("publish.mjs holds 1 semver compare only, the 1 of lib/loop.mjs", () => {
  const source = readFileSync(join(root, "scripts/triage/publish.mjs"), "utf8");
  const loop = readFileSync(join(root, "scripts/triage/lib/loop.mjs"), "utf8");
  assert.match(loop, /export function compareSemver/);
  assert.match(source, /compareSemver/);
  assert.doesNotMatch(source, /function (versionCompare|compareVersions|semverCompare)/);
  assert.doesNotMatch(source, /\.split\(\/\[\.-\]\/\)/);
});

test("the newest app version of an issue body is a semver maximum", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({
    observations: [
      observation({ image: "snow", version: "0.9.0", lastSeenDay: "2026-11-20" }),
      observation({ image: "snow", version: "0.10.0", lastSeenDay: "2026-11-21" }),
      observation({ image: "snow", version: "0.10.0-rc.2", lastSeenDay: "2026-11-21" }),
    ],
  });
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  assert.ok(issues(world, "frostyard/chairlift")[0].body.includes("version: 0.10.0\n"));
});

// ---------------------------------------------------------------------------
// The blocking points of the cross-review
// ---------------------------------------------------------------------------

test("a day in a Fixed in feature version writes no comment and defers the key", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = sysextProblem({ feature: "foo", featureVersion: "1.2" });
  const { number } = setupTracked(world, problem, {
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    extraComments: [
      { author: "a-member", association: "MEMBER", body: "Fixed in: feature foo 2026-11-20", createdAt: "2026-11-20T11:00:00Z" },
    ],
  });
  // The index lists the version, so the boundary would be a day.
  setSums(world, "foo", ["1.2", "2026-11-20"]);
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.guard, 1);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
  assert.equal(commentBodies(world, "frostyard/snosi", number).filter((body) => body.includes("step=released")).length, 0);
});

test("a day in a frame files no issue and the run still writes the health issue", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({
    cls: "panic",
    observations: [observation({ image: "snow", version: "0.15.0" })],
    frames: ["github.com/frostyard/chairlift/internal/snapshot2026-11-20.Foo"],
  });
  writeFacts(world, factsDoc({ problems: [problem] }));

  assert.equal(await run(world), 0);
  assert.deepEqual(issuePosts(world), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.guard, 1);
  assert.equal(ghState(world).repos["frostyard/problem-intake"].issues.length, 1);
});

test("the production source reader sends the token and reads the labels blob", async () => {
  const { createDelivery: createSources } = await import("../../scripts/triage/lib/delivery.mjs");
  const token = "test-token-not-a-real-secret";
  const sha = "a".repeat(40);
  const seen = [];
  const labels = {
    "org.opencontainers.image.source": `https://github.com/frostyard/snosi/blob/${sha}/mkosi.conf`,
    "org.opencontainers.image.created": "2026-11-20T11:30:00Z",
  };
  const json = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
  const fetchStub = async (url, options = {}) => {
    seen.push({ url: String(url), headers: options.headers ?? {} });
    const at = String(url);
    if (at.includes("ghcr.io/token?")) return json({ token });
    if (at.includes("/tags/list") && !at.includes("page=2")) {
      return new Response(JSON.stringify({ tags: ["20261105093000"] }), {
        status: 200,
        headers: { link: '<https://ghcr.io/v2/frostyard/snow/tags/list?page=2>; rel="next"' },
      });
    }
    if (at.includes("page=2")) return json({ tags: ["20261120093000"] });
    if (at.includes("/manifests/20261120093000")) {
      return json({
        manifests: [
          { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
          { digest: "sha256:amd", platform: { os: "linux", architecture: "amd64" } },
        ],
      });
    }
    if (at.endsWith("/manifests/sha256:amd")) return json({ config: { digest: "sha256:blob" } });
    if (at.includes("/blobs/sha256:blob")) return json({ architecture: "amd64", config: { Labels: labels } });
    return new Response("", { status: 404 });
  };
  const sources = createSources({
    config: { sources: null, registryUrl: "https://ghcr.io/", indexUrl: "https://repository.frostyard.org/ext/" },
    fetch: fetchStub,
  });

  assert.deepEqual(await sources.listTags("snow"), ["20261105093000", "20261120093000"]);
  assert.ok(seen[0].url.includes("token?scope=repository:frostyard/snow:pull"), seen[0].url);
  const lists = seen.filter((entry) => entry.url.includes("/tags/list"));
  assert.equal(lists.length, 2);
  for (const entry of lists) assert.equal(entry.headers.authorization, `Bearer ${token}`, entry.url);

  assert.deepEqual(await sources.imageLabels("snow", "20261120093000"), {
    sourceSha: sha,
    created: "2026-11-20T11:30:00Z",
  });
  // The OCI index gives the linux/amd64 manifest, and the labels are in
  // `config.Labels` of the config blob.
  assert.ok(seen.some((entry) => entry.url.endsWith("/manifests/sha256:amd")));
  assert.ok(seen.some((entry) => entry.url.endsWith("/blobs/sha256:blob")));
});

test("the sysext index read: a 404 is no version, a 500 is source_unavailable", async () => {
  const { createDelivery: createSources, DeliveryError: SourceError } = await import("../../scripts/triage/lib/delivery.mjs");
  const config = { sources: null, registryUrl: "https://ghcr.io/", indexUrl: "https://repository.frostyard.org/ext/" };
  const sha = "b".repeat(64);
  const fetchStub = async (url) => {
    const at = String(url);
    if (at.endsWith("/ext/gamma/SHA256SUMS")) {
      return new Response(`${sha}  gamma_1.2_x86-64.raw\n${sha}  gamma_1.3_x86-64.raw\n`, { status: 200 });
    }
    if (at.endsWith("/ext/delta/SHA256SUMS")) return new Response("", { status: 404 });
    return new Response("", { status: 500 });
  };
  const sources = createSources({ config, fetch: fetchStub });
  assert.deepEqual(await sources.featureVersions("gamma"), ["1.2", "1.3"]);
  assert.deepEqual(await sources.featureVersions("delta"), []);
  await assert.rejects(() => sources.featureVersions("epsilon"), (error) => error instanceof SourceError && error.code === "source_unavailable");
});

test("a marker older than the last 100 comments is still read", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  const comments = [
    { author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "filed" }), createdAt: "2026-11-18T00:00:00Z" },
    {
      author: "frostyard-machines",
      association: "MEMBER",
      body: markerOf({ key: KEY, cycle: 1, step: "released", boundary: "image:snow:20261120113000" }),
      createdAt: "2026-11-19T00:00:00Z",
    },
  ];
  for (let i = 0; i < 120; i += 1) {
    comments.push({ author: "a-drive-by", association: "NONE", body: `chatter ${i}`, createdAt: "2026-11-20T00:00:00Z" });
  }
  addIssue(world, "frostyard/snosi", { number: 1, title: built.title, body: built.body, comments });
  setRegistry(world, "snow", { tags: ["20261120113000"], labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") } });
  writePublishedFile(world, publishedDoc({ [KEY]: issueEntry({ number: 1, marker: markerOf({ key: KEY, cycle: 1, step: "filed" }) }) }));
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].boundary, "image:snow:20261120113000");
  assert.equal(published.keys[KEY].released_day, "2026-11-20");
  assert.deepEqual(commentPosts(world), []);
});

test("the rebuild reads the search/issues pages, 1 counted call for each", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  // 250 job issues: 3 pages of 100, 100 and 50.
  for (let i = 1; i <= 250; i += 1) {
    const problem = unitProblem({ key: keyOf(i), unit: `unit-${i}.service` });
    const built = issueFor(problem);
    addIssue(world, "frostyard/snosi", { number: i, title: built.title, body: built.body, comments: [filedComment(keyOf(i))] });
  }
  // A hit of another organization is skipped: its repository_url is not ours.
  const foreign = unitProblem({ key: keyOf(99), unit: "foreign.service" });
  const foreignBuilt = issueFor(foreign);
  addIssue(world, "evil/snosi", { number: 1, title: foreignBuilt.title, body: foreignBuilt.body, comments: [filedComment(keyOf(99))] });
  writeFacts(world, factsDoc({}));

  assert.equal(await run(world), 0);
  const pages = calls(world, "search/issues");
  assert.equal(pages.length, 3);
  pages.forEach((call, i) => {
    const text = call.join(" ");
    assert.ok(text.includes(`page=${i + 1}`), text);
    assert.ok(text.includes("per_page=100"), text);
    assert.ok(text.includes("org:frostyard author:frostyard-machines label:problem-report is:issue"), text);
  });
  assert.equal(Object.keys(readPublished(world).keys).length, 250);
});

test("a release far back is found by reading every page", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  // 150 releases, newest first: the fix is in the oldest 1 (page 2).
  const newest = Date.parse("2026-12-31T12:00:00Z");
  const releases = Array.from({ length: 150 }, (_, i) => ({
    tag_name: `v1.${i}.0`,
    published_at: new Date(newest - i * 3_600_000).toISOString(),
    draft: false,
    prerelease: false,
  }));
  setRelease(world, "frostyard/chairlift", releases);
  // Containment is monotonic: the newest release holds the fix, and every
  // release before it does not (index 0 of the array is the newest).
  setCompare(world, "frostyard/chairlift", compareMap("fix1", releases, ["v1.0.0"]));
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "released");
  assert.equal(published.keys[KEY].boundary, "app:1.0.0");
  assert.equal(calls(world, "releases?per_page=100&page=2").length, 1);
});

test("a regression whose reopen failed is reopened once, with no second comment", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem({ observations: [observation({ image: "snow", version: "0.16.0", lastSeenDay: "2026-11-21" })] });
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    step: "released",
    state: "released",
    boundary: "app:0.15.0",
    releasedDay: "2026-11-20",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T12:00:00Z",
  });
  const state = ghState(world);
  state.failReopen = 1;
  writeGh(world, state);
  writeFacts(world, factsDoc({ problems: [problem], watched: [{ key: KEY, coverage: "complete" }] }));

  // The comment lands, the reopen fails: exit 1.
  assert.equal(await run(world), 1);
  assert.equal(issues(world, "frostyard/chairlift")[0].state, "closed");
  assert.equal(commentBodies(world, "frostyard/chairlift", number).filter((body) => body.includes("step=regressed")).length, 1);
  assert.equal(readPublished(world).keys[KEY].cycle, 2);
  assert.equal(readPublished(world).keys[KEY].state, "filed");

  // The next run has facts without the observation: it reopens, once.
  resetCalls(world);
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));
  assert.equal(await run(world), 0);
  assert.equal(statePatches(world).length, 1);
  assert.equal(issues(world, "frostyard/chairlift")[0].state, "open");
  assert.equal(commentBodies(world, "frostyard/chairlift", number).filter((body) => body.includes("step=regressed")).length, 1);
  assert.equal(readPublished(world).keys[KEY].cycle, 2);
  assert.equal(readPublished(world).keys[KEY].state, "filed");
});

test("the run has 10 comments or reopens in all, the filed markers included", async () => {
  const world = makeWorld({
    labels: { "frostyard/snosi": ["problem-report"], "frostyard/chairlift": ["problem-report"], "frostyard/nsl": ["problem-report"] },
  });
  const keys = [];
  const entries = {};
  for (let i = 1; i <= 9; i += 1) {
    const key = keyOf(i);
    keys.push(key);
    const problem = unitProblem({ key, unit: `unit-${i}.service` });
    const built = issueFor(problem);
    const marker = markerOf({ key, cycle: 1, step: "released", boundary: "image:snow:20261120093000" });
    addIssue(world, "frostyard/snosi", {
      number: i,
      title: built.title,
      body: built.body,
      comments: [{ author: "frostyard-machines", association: "MEMBER", body: marker, createdAt: "2026-11-19T00:00:00Z" }],
    });
    entries[key] = issueEntry({
      number: i,
      state: "released",
      boundary: "image:snow:20261120093000",
      releasedDay: "2026-11-20",
      coveredDays: 13,
      lastCountedDay: "2026-11-20",
      marker,
    });
  }
  // 1 tracked key with no marker at all, and 3 new problems.
  const bare = unitProblem({ key: keyOf(10), unit: "bare.service" });
  const bareIssue = issueFor(bare);
  addIssue(world, "frostyard/snosi", { number: 10, title: bareIssue.title, body: bareIssue.body });
  entries[keyOf(10)] = issueEntry({ number: 10, marker: null });
  // 3 new problems in 3 repositories: 1 per repository, so the per-repository
  // cap of the run does not decide the result.
  const fresh = [
    unitProblem({ key: keyOf(11), unit: "new-one.service", firstSeenDay: "2026-11-20" }),
    appProblem({ key: keyOf(12), repo: "frostyard/chairlift", observations: [observation({ image: "snow", version: "0.15.0" })], firstSeenDay: "2026-11-20" }),
    appProblem({ key: keyOf(13), repo: "frostyard/nsl", appId: "org.frostyard.nsl", observations: [observation({ image: "snow", version: "0.15.0" })], firstSeenDay: "2026-11-20" }),
  ];
  writePublishedFile(world, publishedDoc(entries));
  writeFacts(world, factsDoc({ problems: fresh, watched: keys.map((key) => ({ key, coverage: "complete" })) }));

  assert.equal(await run(world), 0);
  const actions = commentPosts(world).length + statePatches(world).length;
  assert.equal(actions, 10);
  assert.deepEqual(issuePosts(world), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.new_issues, 3);

  // The rest is done by the next run.
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.equal(issuePosts(world).length, 3);
});

test("a fix that shipped before the issue closed is released at the closer date", async () => {
  // App: the release is from 2026-11-12 and the issue closed on 2026-11-20, so
  // a close-time filter would miss it, but its tag holds the fix.
  const app = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(app, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRelease(app, "frostyard/chairlift", [{ tag_name: "v0.15.0", published_at: "2026-11-12T09:00:00Z", draft: false, prerelease: false }]);
  setCompare(app, "frostyard/chairlift", { "fix1...v0.15.0": "ahead" });
  writeFacts(app, factsDoc({ problems: [] }));
  assert.equal(await run(app), 0);
  assert.equal(readPublished(app).keys[KEY].state, "released");
  assert.equal(readPublished(app).keys[KEY].boundary, "app:0.15.0");
  assert.equal(readPublished(app).keys[KEY].released_day, "2026-11-12");

  // Image: the tag is from 2026-11-12, and the issue closed on 2026-11-20.
  const image = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  setupTracked(image, unitProblem(), {
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T10:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRegistry(image, "snow", {
    tags: ["20261112093000"],
    labels: { "20261112093000": imageLabels("2".repeat(40), "2026-11-12T09:30:00Z") },
  });
  const imageState = ghState(image);
  imageState.repos["frostyard/snosi"].compare = { [`fix1...${"2".repeat(40)}`]: "identical" };
  writeGh(image, imageState);
  writeFacts(image, factsDoc({ problems: [] }));
  assert.equal(await run(image), 0);
  assert.equal(readPublished(image).keys[KEY].state, "released");
  assert.equal(readPublished(image).keys[KEY].boundary, "image:snow:20261112093000");
});

test("a health comment of the day is written once, also after a crash", async () => {
  // The status comment.
  const status = makeWorld({ labels: {} });
  writeHealthFile(status, {
    schema: "frostyard.problem-triage-health/1",
    runs: [{ day: "2026-11-20", status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false }],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(status, factsDoc({ status: "auth" }));
  const crashStatus = {
    afterAction(name) {
      if (name === "health-comment") throw new Error("crash after the status comment");
    },
  };
  assert.equal(await run(status, { hooks: crashStatus }), 1);
  assert.equal(commentPosts(status).length, 1);
  resetCalls(status);
  assert.equal(await run(status), 0);
  assert.equal(commentPosts(status).length, 0);
  assert.equal(commentBodies(status, "frostyard/problem-intake", 1).length, 1);

  // The rotation comment.
  const rotation = makeWorld({ labels: {} });
  writeHealthFile(rotation, {
    schema: "frostyard.problem-triage-health/1",
    runs: [{ day: "2026-11-20", status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false }],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(rotation, factsDoc({ tokenAgeDays: 335 }));
  const crashRotation = {
    afterAction(name) {
      if (name === "health-rotation") throw new Error("crash after the rotation comment");
    },
  };
  assert.equal(await run(rotation, { hooks: crashRotation }), 1);
  assert.equal(commentPosts(rotation).length, 1);
  resetCalls(rotation);
  assert.equal(await run(rotation), 0);
  assert.equal(commentPosts(rotation).length, 0);
  assert.equal(commentBodies(rotation, "frostyard/problem-intake", 1).length, 1);
});

// ---------------------------------------------------------------------------
// The blocking points of re-review 1
// ---------------------------------------------------------------------------

test("an incomplete rebuild writes no state and files nothing", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", { number: 1, title: built.title, body: built.body, comments: [filedComment(KEY)] });
  // GitHub reports more hits than its 1000 hit cap can return.
  const state = ghState(world);
  state.searchTotalCount = 1200;
  writeGh(world, state);
  writeFacts(world, factsDoc({ problems: [unitProblem({ key: keyOf(9), unit: "other.service" })] }));

  assert.equal(await run(world), 0);
  assert.equal(existsSync(join(world.stateDir, "published.json")), false);
  assert.deepEqual(issuePosts(world), []);
  assert.deepEqual(statePatches(world), []);
  assert.deepEqual(calls(world, "graphql"), []);
  const entry = readHealth(world).runs.at(-1);
  assert.equal(entry.deferred.recovery, 1);
  assert.equal(ghState(world).repos["frostyard/problem-intake"].issues.length, 1);
  assert.equal(readHeartbeat(world), DAY);
});

test("a marker read that the page cap cuts takes no action", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  const built = issueFor(problem);
  const comments = [
    filedComment(KEY),
    {
      author: "frostyard-machines",
      association: "MEMBER",
      body: markerOf({ key: KEY, cycle: 1, step: "released", boundary: "image:snow:20261120113000" }),
      createdAt: "2026-11-19T00:00:00Z",
    },
  ];
  for (let i = 0; i < 250; i += 1) {
    comments.push({ author: "a-drive-by", association: "NONE", body: `chatter ${i}`, createdAt: "2026-11-20T00:00:00Z" });
  }
  addIssue(world, "frostyard/snosi", { number: 1, title: built.title, body: built.body, comments });
  setRegistry(world, "snow", { tags: ["20261120113000"], labels: { "20261120113000": imageLabels("1".repeat(40), "2026-11-20T11:30:00Z") } });
  writePublishedFile(world, publishedDoc({ [KEY]: issueEntry({ number: 1, marker: markerOf({ key: KEY, cycle: 1, step: "filed" }) }) }));
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world, { hooks: { commentPages: 1 } }), 0);
  assert.deepEqual(commentPosts(world), []);
  const published = readPublished(world);
  assert.equal(published.keys[KEY].state, "filed");
  assert.equal(published.keys[KEY].released_day, null);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery, 1);
});

test("a release read that the page cap cuts keeps the key merged", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  // Exactly 1 full page: more releases may hold the fix.
  setRelease(
    world,
    "frostyard/chairlift",
    Array.from({ length: 100 }, (_, i) => ({
      tag_name: `v1.${i}.0`,
      published_at: new Date(Date.parse("2026-12-31T12:00:00Z") - i * 3_600_000).toISOString(),
      draft: false,
      prerelease: false,
    })),
  );
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world, { hooks: { releasePages: 1 } }), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery > 0, true);
});

test("a close in the same second as the regressed marker is a pending reopen", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  const { number } = setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    cycle: 2,
    step: "regressed",
    boundary: null,
    state: "filed",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-19T00:00:00Z",
  });
  writeFacts(world, factsDoc({ problems: [], watched: [{ key: KEY, coverage: "complete" }] }));

  assert.equal(await run(world), 0);
  assert.equal(statePatches(world).length, 1);
  assert.equal(issues(world, "frostyard/chairlift")[0].state, "open");
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readPublished(world).keys[KEY].cycle, 2);
  assert.equal(readPublished(world).keys[KEY].state, "filed");
  assert.equal(commentBodies(world, "frostyard/chairlift", number).length, 1);
});

test("the oldest release that holds the fix costs at most 7 compares", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  // 40 releases, newest first: the newest 5 hold the fix, so the oldest 1 that
  // holds it is v1.4.0.
  const releases = Array.from({ length: 40 }, (_, i) => ({
    tag_name: `v1.${i}.0`,
    published_at: new Date(Date.parse("2026-12-31T12:00:00Z") - i * 3_600_000).toISOString(),
    draft: false,
    prerelease: false,
  }));
  setRelease(world, "frostyard/chairlift", releases);
  setCompare(world, "frostyard/chairlift", compareMap("fix1", releases, ["v1.0.0", "v1.1.0", "v1.2.0", "v1.3.0", "v1.4.0"]));
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  assert.equal(readPublished(world).keys[KEY].state, "released");
  assert.equal(readPublished(world).keys[KEY].boundary, "app:1.4.0");
  assert.equal(calls(world, "/compare/").length <= 7, true);
});

test("a health comment is not repeated by a run on the next day", async () => {
  const world = makeWorld({ labels: {} });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [{ day: "2026-11-20", status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false }],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(world, factsDoc({ status: "auth" }));
  const crash = {
    afterAction(name) {
      if (name === "health-comment") throw new Error("crash after the status comment");
    },
  };
  assert.equal(await run(world, { hooks: crash }), 1);
  assert.equal(commentPosts(world).length, 1);

  resetCalls(world);
  writeFacts(world, factsDoc({ day: "2026-11-22", status: "auth" }));
  assert.equal(await run(world, { now: "2026-11-22T06:15:00Z" }), 0);
  assert.equal(commentPosts(world).length, 0);
  assert.equal(commentBodies(world, "frostyard/problem-intake", 1).length, 1);
});

test("a delivered notification after 150 other comments is not repeated", async () => {
  const world = makeWorld({ labels: {} });
  const id = "0123456789abcdef";
  const comments = [];
  for (let i = 0; i < 150; i += 1) {
    comments.push({ author: "a-drive-by", association: "NONE", body: `chatter ${i}`, createdAt: "2026-11-21T10:00:00Z" });
  }
  comments.push({
    author: "frostyard-machines",
    association: "MEMBER",
    body: `<!-- problem-triage-health:1 id=${id} -->\n\nThe GlitchTip read token is due for rotation.`,
    createdAt: "2026-11-21T12:00:00Z",
  });
  addIssue(world, "frostyard/problem-intake", {
    number: 1,
    title: "Problem triage health",
    body: "Operational status of the problem-intake triage job.",
    labels: ["problem-report"],
    comments,
  });
  // A notification of an earlier run that crashed before it was removed.
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [],
    notifications: [{ id, text: "The GlitchTip read token is due for rotation.", since: DAY }],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(world, factsDoc({}));

  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 0);
  // The read went to the second page, and it was complete.
  assert.equal(calls(world, "issues/1/comments").length, 2);
  assert.deepEqual(readHealth(world).notifications, []);
});

test("the deadline stops the release search between 2 pages", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRelease(
    world,
    "frostyard/chairlift",
    Array.from({ length: 150 }, (_, i) => ({
      tag_name: `v1.${i}.0`,
      published_at: new Date(Date.parse("2026-12-31T12:00:00Z") - i * 3_600_000).toISOString(),
      draft: false,
      prerelease: false,
    })),
  );
  writeFacts(world, factsDoc({ problems: [] }));
  let reads = 0;
  const clock = () => {
    reads += 1;
    // The run starts at 0; from the 5th reading on, the deadline has passed.
    return reads <= 4 ? 0 : 10 * 60 * 1000 + 30 * 1000;
  };

  assert.equal(await run(world, { hooks: { clock } }), 0);
  assert.equal(calls(world, "releases?per_page=100&page=2").length, 0);
  assert.equal(readHealth(world).runs.at(-1).deferred.deadline > 0, true);
  assert.equal(ghState(world).repos["frostyard/problem-intake"].issues.length, 1);
  assert.equal(readHeartbeat(world), DAY);
});

// ---------------------------------------------------------------------------
// The blocking points of re-review 2
// ---------------------------------------------------------------------------

function seedJobIssues(world, count, repo = "frostyard/snosi") {
  for (let i = 1; i <= count; i += 1) {
    const problem = unitProblem({ key: keyOf(i), unit: `unit-${i}.service` });
    const built = issueFor(problem);
    addIssue(world, repo, { number: i, title: built.title, body: built.body, comments: [filedComment(keyOf(i))] });
  }
}

test("a search answer with incomplete_results is no rebuild", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  seedJobIssues(world, 3);
  const state = ghState(world);
  state.searchIncomplete = true;
  writeGh(world, state);
  writeFacts(world, factsDoc({ problems: [unitProblem({ key: keyOf(9), unit: "other.service" })] }));

  assert.equal(await run(world), 0);
  assert.equal(existsSync(join(world.stateDir, "published.json")), false);
  assert.deepEqual(issuePosts(world), []);
  assert.deepEqual(calls(world, "graphql"), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery, 1);
});

test("a short search page that leaves hits unread is no rebuild", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  seedJobIssues(world, 130);
  // GitHub reports 250 hits but answers 130: 120 stayed unread.
  const state = ghState(world);
  state.searchTotalCount = 250;
  writeGh(world, state);
  writeFacts(world, factsDoc({}));

  assert.equal(await run(world), 0);
  assert.equal(existsSync(join(world.stateDir, "published.json")), false);
  assert.deepEqual(calls(world, "graphql"), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery, 1);
});

test("exactly 1000 hits take 10 pages and no page 11", async () => {
  const world = makeWorld({
    labels: {
      "frostyard/snosi": ["problem-report"],
      "frostyard/chairlift": ["problem-report"],
      "frostyard/nsl": ["problem-report"],
      "frostyard/updex": ["problem-report"],
    },
  });
  // 1000 job issues over 4 repositories.
  const repos = ["frostyard/snosi", "frostyard/chairlift", "frostyard/nsl", "frostyard/updex"];
  for (let i = 1; i <= 1000; i += 1) {
    const repo = repos[i % 4];
    const problem = unitProblem({ key: keyOf(i), unit: `unit-${i}.service`, repo });
    const built = issueFor(problem);
    addIssue(world, repo, { number: i, title: built.title, body: built.body });
  }
  writeFacts(world, factsDoc({}));

  assert.equal(await run(world), 0);
  const pages = calls(world, "search/issues");
  assert.equal(pages.length, 10);
  assert.equal(pages.filter((call) => call.join(" ").includes("page=11")).length, 0);
  assert.equal(Object.keys(readPublished(world).keys).length, 1000);
});

test("a capped notification read keeps the entry, and the next run delivers it once", async () => {
  const world = makeWorld({ labels: {} });
  const id = "fedcba9876543210";
  const comments = [];
  for (let i = 0; i < 120; i += 1) {
    comments.push({ author: "a-drive-by", association: "NONE", body: `chatter ${i}`, createdAt: "2026-11-21T10:00:00Z" });
  }
  addIssue(world, "frostyard/problem-intake", {
    number: 1,
    title: "Problem triage health",
    body: "Operational status of the problem-intake triage job.",
    labels: ["problem-report"],
    comments,
  });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [],
    notifications: [{ id, text: "The GlitchTip read token is due for rotation.", since: DAY }],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(world, factsDoc({}));

  // 1 page only: more comments may hold the marker, so nothing is sent.
  assert.equal(await run(world, { hooks: { commentPages: 1 } }), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).notifications.length, 1);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery, 1);
  // The body of the health issue holds that deferral.
  assert.ok(ghState(world).repos["frostyard/problem-intake"].issues[0].body.includes("- work deferred: yes"));

  // A complete read delivers it once, and then the entry is gone.
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);
  assert.match(commentBodies(world, "frostyard/problem-intake", 1).at(-1), /^<!-- problem-triage-health:1 id=fedcba9876543210 -->\n\nThe GlitchTip read token is due for rotation\.$/);
  assert.deepEqual(readHealth(world).notifications, []);

  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);
});

test("ok to auth to ok to auth on 1 day writes 2 status comments", async () => {
  const world = makeWorld({ labels: {} });
  writeFacts(world, factsDoc({ status: "ok" }));
  assert.equal(await run(world), 0);

  writeFacts(world, factsDoc({ status: "auth" }));
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);

  writeFacts(world, factsDoc({ status: "ok" }));
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);

  writeFacts(world, factsDoc({ status: "auth" }));
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 2);
  const bodies = commentBodies(world, "frostyard/problem-intake", 1).filter((body) => body.includes("changed from ok to auth"));
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0], bodies[1], "the 2 notifications hold different ids");
});

test("a rotation comment that crashed is not written twice the next day", async () => {
  const world = makeWorld({ labels: {} });
  writeFacts(world, factsDoc({ tokenAgeDays: 335 }));
  const crash = {
    afterAction(name) {
      if (name === "health-rotation") throw new Error("crash after the rotation comment");
    },
  };
  // No previous run entry at all: the transition is the rotation itself.
  assert.equal(await run(world, { hooks: crash }), 1);
  assert.equal(commentPosts(world).length, 1);
  assert.equal(readHealth(world).notifications.length, 1);
  // The checkpoint of the crashed run is already the run entry.
  assert.equal(readHealth(world).runs.length, 1);
  assert.equal(readHealth(world).runs.at(-1).rotation_due, true);

  // The next day, the pending entry is still there and its comment is found.
  resetCalls(world);
  writeFacts(world, factsDoc({ day: "2026-11-22", tokenAgeDays: 336 }));
  assert.equal(await run(world, { now: "2026-11-22T06:15:00Z" }), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(commentBodies(world, "frostyard/problem-intake", 1).length, 1);
  assert.deepEqual(readHealth(world).notifications, []);
});

test("the deadline stops the rebuild between 2 search pages", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  // 350 hits are 4 pages: 2 are read before the deadline stops the third.
  seedJobIssues(world, 350);
  writeFacts(world, factsDoc({}));
  let reads = 0;
  const clock = () => {
    reads += 1;
    // Readings 1 to 5 are the run's start, page 1 and page 2; the 6th is the
    // gate of page 3, past the deadline.
    return reads <= 5 ? 0 : 10 * 60 * 1000 + 30 * 1000;
  };

  assert.equal(await run(world, { hooks: { clock } }), 0);
  assert.equal(calls(world, "search/issues").length, 2);
  assert.equal(existsSync(join(world.stateDir, "published.json")), false);
  assert.equal(readHealth(world).runs.at(-1).deferred.deadline > 0, true);
  assert.equal(ghState(world).repos["frostyard/problem-intake"].issues.length, 1);
});

test("the deadline stops the registry tag pages between 2 of them", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] }, sources: false });
  const problem = unitProblem();
  const built = issueFor(problem);
  addIssue(world, "frostyard/snosi", {
    number: 1,
    title: built.title,
    body: built.body,
    state: "closed",
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
    comments: [{ author: "frostyard-machines", association: "MEMBER", body: markerOf({ key: KEY, cycle: 1, step: "filed" }), createdAt: "2026-11-19T00:00:00Z" }],
  });
  writePublishedFile(world, publishedDoc({ [KEY]: issueEntry({ number: 1, marker: markerOf({ key: KEY, cycle: 1, step: "filed" }) }) }));
  writeFacts(world, factsDoc({ problems: [] }));

  const tags = Array.from({ length: 100 }, (_, i) => `2026110${(i % 9) + 1}093000`);
  const requests = [];
  const fetchStub = async (url) => {
    requests.push(String(url));
    if (String(url).includes("ghcr.io/token?")) {
      return new Response(JSON.stringify({ token: "test-token-not-a-real-secret" }), { status: 200 });
    }
    if (String(url).includes("page=2")) return new Response(JSON.stringify({ tags }), { status: 200 });
    return new Response(JSON.stringify({ tags }), {
      status: 200,
      headers: { link: '<https://ghcr.io/v2/frostyard/snow/tags/list?page=2>; rel="next"' },
    });
  };
  let reads = 0;
  const clock = () => {
    reads += 1;
    // Readings 1 to 5 are the run's start, the 2 gates and the first 2 registry
    // reads; the 6th is the second tag page, past the deadline.
    return reads <= 5 ? 0 : 10 * 60 * 1000 + 30 * 1000;
  };

  assert.equal(await run(world, { hooks: { clock, fetch: fetchStub } }), 0);
  assert.equal(requests.filter((url) => url.includes("page=2")).length, 0);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
  assert.equal(readHealth(world).runs.at(-1).deferred.deadline > 0, true);
});

test("an unknown containment of an app release makes the key wait", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  const releases = Array.from({ length: 3 }, (_, i) => ({
    tag_name: `v1.${i}.0`,
    published_at: new Date(Date.parse("2026-12-31T12:00:00Z") - i * 3_600_000).toISOString(),
    draft: false,
    prerelease: false,
  }));
  setRelease(world, "frostyard/chairlift", releases);
  // The middle probe has no answer at all: its containment is unknown.
  setCompare(world, "frostyard/chairlift", { "fix1...v1.0.0": "diverged", "fix1...v1.2.0": "diverged" });
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery > 0, true);
});

test("an image tag with no source commit makes the key wait", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  const problem = unitProblem();
  setupTracked(world, problem, {
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRegistry(world, "snow", {
    tags: ["20261101093000", "20261102093000", "20261103093000"],
    labels: {
      "20261101093000": imageLabels("1".repeat(40), "2026-11-01T09:30:00Z"),
      // No source label at all: the containment of this tag is unknown.
      "20261102093000": { "org.opencontainers.image.created": "2026-11-02T09:30:00Z" },
      "20261103093000": imageLabels("3".repeat(40), "2026-11-03T09:30:00Z"),
    },
  });
  const state = ghState(world);
  state.repos["frostyard/snosi"].compare = {
    [`fix1...${"1".repeat(40)}`]: "diverged",
    [`fix1...${"3".repeat(40)}`]: "behind",
  };
  writeGh(world, state);
  writeFacts(world, factsDoc({ problems: [] }));

  assert.equal(await run(world), 0);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery > 0, true);
});

// ---------------------------------------------------------------------------
// The blocking points of re-review 3
// ---------------------------------------------------------------------------

test("a crash after a delivered notification sends no second comment", async () => {
  const world = makeWorld({ labels: {} });
  // The health issue exists with an old body, so the final body is a patch.
  addIssue(world, "frostyard/problem-intake", {
    number: 1,
    title: "Problem triage health",
    body: "Operational status of the problem-intake triage job.",
    labels: ["problem-report"],
    comments: [],
  });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [{ day: "2026-11-20", status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false }],
    notifications: [],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(world, factsDoc({ status: "auth" }));
  const crash = {
    afterAction(name) {
      if (name === "health-body") throw new Error("crash after the body patch");
    },
  };

  // The notification was delivered; the crash comes after it.
  assert.equal(await run(world, { hooks: crash }), 1);
  assert.equal(commentPosts(world).length, 1);
  assert.deepEqual(readHealth(world).notifications, []);
  // The checkpoint already holds this run's status.
  assert.equal(readHealth(world).runs.at(-1).status, "auth");

  // A retry the same day, and 1 the next day, detect no transition.
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);

  writeFacts(world, factsDoc({ day: "2026-11-22", status: "auth" }));
  resetCalls(world);
  assert.equal(await run(world, { now: "2026-11-22T06:15:00Z" }), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(commentBodies(world, "frostyard/problem-intake", 1).length, 1);
});

test("the notification work leaves 2 calls for the body, and the next run delivers it", async () => {
  const world = makeWorld({ labels: {} });
  // 350 comments: the read needs 4 pages, so the post would take the reserve.
  const comments = [];
  for (let i = 0; i < 350; i += 1) {
    comments.push({ author: "a-drive-by", association: "NONE", body: `chatter ${i}`, createdAt: "2026-11-21T10:00:00Z" });
  }
  addIssue(world, "frostyard/problem-intake", {
    number: 1,
    title: "Problem triage health",
    body: "Operational status of the problem-intake triage job.",
    labels: ["problem-report"],
    comments,
  });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [{ day: "2026-11-20", status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false }],
    notifications: [],
    last_read: {},
    issue_keys: {},
  });
  writeFacts(world, factsDoc({ status: "auth" }));

  // 8 calls: the rebuild page, the issue lookup, 4 comment pages, then the 2
  // calls of the reserve for the body patch.
  assert.equal(await run(world, { hooks: { limit: 8 } }), 0);
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).notifications.length, 1);
  assert.ok(readHealth(world).runs.at(-1).deferred.budget > 0);
  // The body and the heartbeat are written, with the deferral in the body.
  const issue = ghState(world).repos["frostyard/problem-intake"].issues[0];
  assert.ok(issue.body.includes("- work deferred: yes"), issue.body);
  assert.equal(readHeartbeat(world), DAY);
  assert.equal(ghState(world).calls.length <= 8, true);

  // The next run delivers the notification once.
  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.equal(commentPosts(world).length, 1);
  assert.deepEqual(readHealth(world).notifications, []);
});

test("a search page that repeats an issue is no rebuild", async () => {
  const world = makeWorld({ labels: { "frostyard/snosi": ["problem-report"] } });
  seedJobIssues(world, 250);
  // The second page starts 1 item early: its first issue was already read.
  const state = ghState(world);
  state.searchOverlap = true;
  writeGh(world, state);
  writeFacts(world, factsDoc({}));

  assert.equal(await run(world), 0);
  assert.equal(existsSync(join(world.stateDir, "published.json")), false);
  assert.deepEqual(calls(world, "graphql"), []);
  assert.equal(readHealth(world).runs.at(-1).deferred.recovery, 1);
});

test("2 transitions with capped reads are both delivered once", async () => {
  const world = makeWorld({ labels: {} });
  // 150 comments since the run's day: every capped read is incomplete.
  const comments = [];
  for (let i = 0; i < 150; i += 1) {
    comments.push({ author: "a-drive-by", association: "NONE", body: `chatter ${i}`, createdAt: "2026-11-21T10:00:00Z" });
  }
  addIssue(world, "frostyard/problem-intake", {
    number: 1,
    title: "Problem triage health",
    body: "Operational status of the problem-intake triage job.",
    labels: ["problem-report"],
    comments,
  });
  writeHealthFile(world, {
    schema: "frostyard.problem-triage-health/1",
    runs: [{ day: "2026-11-20", status: "ok", notes: [], held: {}, deferred: {}, rotation_due: false }],
    notifications: [],
    last_read: {},
    issue_keys: {},
  });
  const capped = { hooks: { commentPages: 1 } };

  // ok, auth, ok, auth: 2 transitions, and neither can be delivered yet.
  for (const status of ["ok", "auth", "ok", "auth"]) {
    writeFacts(world, factsDoc({ status }));
    assert.equal(await run(world, capped), 0);
  }
  assert.deepEqual(commentPosts(world), []);
  assert.equal(readHealth(world).notifications.length, 2);
  assert.notEqual(readHealth(world).notifications[0].id, readHealth(world).notifications[1].id);

  // A complete read delivers both, each once.
  assert.equal(await run(world), 0);
  const statusComments = commentBodies(world, "frostyard/problem-intake", 1).filter((body) =>
    body.includes("changed from ok to auth"),
  );
  assert.equal(statusComments.length, 2);
  assert.notEqual(statusComments[0], statusComments[1], "each notification has its own id");
  assert.deepEqual(readHealth(world).notifications, []);

  resetCalls(world);
  assert.equal(await run(world), 0);
  assert.deepEqual(commentPosts(world), []);
});

test("a work call killed at the remaining work time defers the deadline", async () => {
  const world = makeWorld({ labels: { "frostyard/chairlift": ["problem-report"] } });
  const problem = appProblem();
  setupTracked(world, problem, {
    repo: "frostyard/chairlift",
    closed: true,
    stateReason: "COMPLETED",
    closedAt: "2026-11-20T00:00:00Z",
    closer: { type: "PullRequest", sha: "fix1" },
  });
  setRelease(world, "frostyard/chairlift", [
    { tag_name: "v0.15.0", published_at: "2026-11-20T12:00:00Z", draft: false, prerelease: false },
  ]);
  writeFacts(world, factsDoc({ problems: [] }));
  // The releases call answers after 3 seconds; the work time left is 1.5.
  const state = ghState(world);
  state.slowPath = "releases";
  state.slowMs = 3000;
  writeGh(world, state);
  let reads = 0;
  const clock = () => {
    reads += 1;
    return reads === 1 ? 0 : 10 * 60 * 1000 - 1500;
  };

  assert.equal(await run(world, { hooks: { clock } }), 0);
  const entry = readHealth(world).runs.at(-1);
  assert.equal(entry.deferred.deadline > 0, true);
  assert.equal(ghState(world).repos["frostyard/problem-intake"].issues.length, 1);
  assert.equal(readHeartbeat(world), DAY);
  assert.equal(readPublished(world).keys[KEY].state, "merged");
});
