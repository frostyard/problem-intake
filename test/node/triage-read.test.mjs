// The reader of the problem triage job (docs/specs/triage.md, "Reader", "The
// facts schema", "Required tests"). No test reaches an outside host: the
// GlitchTip answers come from a node:http mock on 127.0.0.1, and the git,
// registry and index answers come from the fixture folder that
// test/fixtures/triage/build-sources.mjs builds. `now` is fixed, so no test
// depends on the wall clock, and the pause between requests is 0.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { assertFacts } from "../../scripts/triage/lib/facts.mjs";
import { keyForm, parseRoutedFrame } from "../../scripts/triage/lib/frames.mjs";
import {
  compareImageVersion,
  compareSemver,
  isNoise,
  problemKey,
  rawFingerprint,
  rebuildReport,
  route,
} from "../../scripts/triage/lib/report.mjs";
import { printSummary, runReader } from "../../scripts/triage/read.mjs";
import { buildEvent } from "../../src/envelope.ts";
import { FAKE_TOKEN, eventRow, exampleReport, startMock } from "./triage-helpers.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const READ = join(ROOT, "scripts", "triage", "read.mjs");
const BUILD_SOURCES = join(ROOT, "test", "fixtures", "triage", "build-sources.mjs");
const ROUTES = JSON.parse(readFileSync(join(ROOT, "triage", "routes.json"), "utf8"));
const NOW = Date.parse("2026-11-21T00:00:00Z");
const DAY = "2026-11-21";

let TMP = "";
let SOURCES = "";
let mock = null;
const ALL_REQUESTS = [];
const temps = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(TMP, prefix));
  temps.push(dir);
  return dir;
}

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "triage-read-"));
  SOURCES = join(TMP, "sources");
  execFileSync(process.execPath, [BUILD_SOURCES, SOURCES], { stdio: ["ignore", "pipe", "pipe"] });
  mock = await startMock();
});

after(async () => {
  if (mock !== null) await mock.close();
  for (const entry of ALL_REQUESTS) {
    assert.equal(entry.method, "GET", `${entry.method} ${entry.path}`);
    assert.equal(entry.path.includes("/events/latest/"), false, entry.path);
  }
  rmSync(TMP, { recursive: true, force: true });
});

function sink() {
  return {
    text: "",
    write(text) {
      this.text += text;
    },
  };
}

// A token file, a created file, a state folder and a triage folder of its own
// for 1 case.
function prepare(options = {}) {
  const dir = tempDir("case-");
  const stateDir = join(dir, "state");
  const tokenFile = join(dir, "glitchtip-read.token");
  if (options.token !== null) writeFileSync(tokenFile, `${options.token ?? FAKE_TOKEN}\n`, { mode: 0o600 });
  if (options.created !== null) writeFileSync(join(dir, "glitchtip-read.created"), `${options.created ?? "2026-11-01"}\n`);
  const triageDir = join(dir, "triage");
  execFileSync("cp", ["-r", join(ROOT, "triage"), triageDir]);
  const cutoff = "cutoff" in options ? options.cutoff : "2026-01-01T00:00:00Z";
  writeFileSync(join(triageDir, "config.json"), `${JSON.stringify({ first_seen_cutoff: cutoff })}\n`);
  if (options.routes !== null && options.routes !== undefined) {
    writeFileSync(join(triageDir, "routes.json"), `${JSON.stringify(options.routes)}\n`);
  }
  mkdirSync(stateDir, { recursive: true });
  if (options.published !== null && options.published !== undefined) {
    writeFileSync(join(stateDir, "published.json"), `${JSON.stringify(options.published)}\n`, { mode: 0o600 });
  }
  if (options.health !== null && options.health !== undefined) {
    writeFileSync(join(stateDir, "health.json"), `${JSON.stringify(options.health)}\n`, { mode: 0o600 });
  }
  return { dir, stateDir, tokenFile, triageDir, out: sink(), err: sink() };
}

// 1 issue of the mock: its reports and their event times.
function issue(id, reports, firstSeen = reports[0].dateCreated) {
  return {
    id,
    firstSeen,
    lastSeen: reports.at(-1).dateCreated,
    events: reports.map((one) => ({ report: one.report, dateCreated: one.dateCreated })),
  };
}

// Runs the reader in this process, with the mock as GlitchTip and the fixture
// folder as the sources.
async function read(options = {}) {
  const prepared = options.prepared ?? prepare(options);
  mock.setIssues(options.issues ?? []);
  mock.clearLog();
  mock.state.plan.length = 0;
  mock.state.handler = options.handler ?? null;
  mock.state.delayMs = options.delayMs ?? 0;
  if (Array.isArray(options.plan)) mock.state.plan.push(...options.plan);
  const env = {
    TRIAGE_TEST: "1",
    TRIAGE_GLITCHTIP_URL: options.baseUrl ?? mock.baseUrl,
    TRIAGE_TOKEN_FILE: prepared.tokenFile,
    TRIAGE_STATE_DIR: prepared.stateDir,
    ...(options.sources === null ? {} : { TRIAGE_SOURCES: options.sources ?? SOURCES }),
    ...(options.env ?? {}),
  };
  const result = await runReader({
    env,
    home: prepared.dir,
    now: options.now ?? NOW,
    triageDir: prepared.triageDir,
    cap: options.cap ?? 1000,
    pauseMs: options.pauseMs ?? 0,
    sleep: options.sleep ?? (async () => {}),
    timeoutMs: options.timeoutMs ?? 20000,
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.runGit === undefined ? {} : { runGit: options.runGit }),
    ...(options.codeDir === undefined ? {} : { codeDir: options.codeDir }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    stdout: prepared.out,
    stderr: prepared.err,
  });
  mock.state.delayMs = 0;
  if (result.facts !== null) assertFacts(result.facts);
  ALL_REQUESTS.push(...mock.log);
  return { ...prepared, result, facts: result.facts, log: [...mock.log], exitCode: result.exitCode };
}

const factsOf = (prepared) => JSON.parse(readFileSync(join(prepared.stateDir, "facts.json"), "utf8"));
const healthOf = (prepared) => JSON.parse(readFileSync(join(prepared.stateDir, "health.json"), "utf8"));

// --- the report builders of the cases --------------------------------------

function chairliftError(detail = {}) {
  const report = exampleReport("app_problem");
  report.detail = {
    app_id: "org.frostyard.ChairLift",
    app_version: "0.14.0",
    runtime: "go",
    component: "daemon",
    class: "error",
    code: "store.migrate_failed",
    ...detail,
  };
  return report;
}

function chairliftPanic(frames, detail = {}) {
  const report = exampleReport("app_problem");
  report.detail = {
    app_id: "org.frostyard.ChairLift",
    app_version: "0.14.0",
    runtime: "go",
    component: "gui",
    class: "panic",
    frames,
    ...detail,
  };
  return report;
}

function nslPanic(location) {
  const report = exampleReport("app_problem");
  report.detail = {
    app_id: "org.frostyard.nsl",
    app_version: "0.9.2",
    runtime: "rust",
    component: "daemon",
    class: "panic",
    location,
  };
  return report;
}

function unitFailed(detail = {}) {
  const report = exampleReport("unit_failed");
  report.detail = { unit: "snosi-health.service", result: "exit-code", shipped: true, ...detail };
  return report;
}

function sysextFailed(detail = {}) {
  const report = exampleReport("sysext_update_failed");
  report.detail = { feature: "docker", version: "28.5.1", outcome: "failed", error_class: "checksum", ...detail };
  return report;
}

async function oneProblem(report, options = {}) {
  return await read({
    ...options,
    issues: [issue(options.id ?? 41, [{ report, dateCreated: options.dateCreated ?? "2026-11-20T10:00:00Z" }])],
  });
}

// --- the configuration and the token ---------------------------------------

test("a TRIAGE_* override without TRIAGE_TEST=1 exits 2 and writes no file", async () => {
  mock.clearLog();
  const prepared = prepare();
  const result = await runReader({
    env: { TRIAGE_STATE_DIR: prepared.stateDir, TRIAGE_TOKEN_FILE: prepared.tokenFile },
    home: prepared.dir,
    now: NOW,
    triageDir: prepared.triageDir,
    pauseMs: 0,
    sleep: async () => {},
    stdout: prepared.out,
    stderr: prepared.err,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.facts, null);
  assert.equal(prepared.err.text, "triage-read: config override_without_test\n");
  assert.equal(existsSync(join(prepared.stateDir, "facts.json")), false);
  assert.deepEqual(mock.log, []);
});

test("a test GlitchTip URL that is not local exits 2 with no request and no file", async () => {
  mock.clearLog();
  const prepared = prepare();
  const result = await runReader({
    env: {
      TRIAGE_TEST: "1",
      TRIAGE_GLITCHTIP_URL: "https://glitchtip.example.invalid/api/0/",
      TRIAGE_STATE_DIR: prepared.stateDir,
      TRIAGE_TOKEN_FILE: prepared.tokenFile,
    },
    home: prepared.dir,
    now: NOW,
    triageDir: prepared.triageDir,
    pauseMs: 0,
    sleep: async () => {},
    stdout: prepared.out,
    stderr: prepared.err,
  });
  assert.equal(result.exitCode, 2);
  assert.equal(prepared.err.text, "triage-read: config test_url_not_local\n");
  assert.equal(existsSync(join(prepared.stateDir, "facts.json")), false);
  assert.deepEqual(mock.log, []);
});

test("a missing token is a config failure: exit 2, facts with status config, no request", async () => {
  const prepared = prepare({ token: null });
  const run = await read({ prepared });
  assert.equal(run.exitCode, 2);
  assert.equal(run.facts.run.status, "config");
  assert.deepEqual(run.log, []);
  assert.equal(prepared.err.text, "triage-read: config token\n");
  assert.equal(factsOf(prepared).run.status, "config");
});

test("a malformed token is a config failure too", async () => {
  const prepared = prepare({ token: "not-a-token" });
  const run = await read({ prepared });
  assert.equal(run.exitCode, 2);
  assert.equal(run.facts.run.status, "config");
  assert.deepEqual(run.log, []);
});

test("token_age_days counts whole days, and an unknown creation day is a note", async () => {
  const known = await read({ created: "2026-11-01" });
  assert.equal(known.facts.run.token_age_days, 20);
  assert.deepEqual(known.facts.run.notes, []);

  const missing = await read({ created: null });
  assert.equal(missing.facts.run.token_age_days, null);
  assert.deepEqual(missing.facts.run.notes, ["token_created_unknown"]);

  const future = await read({ created: "2027-01-01" });
  assert.equal(future.facts.run.token_age_days, null);
  assert.deepEqual(future.facts.run.notes, ["token_created_unknown"]);

  const malformed = await read({ created: "yesterday" });
  assert.equal(malformed.facts.run.token_age_days, null);
});

test("a checkout that is not at origin/main and has no FETCH_HEAD is checkout_failed", async () => {
  const dir = tempDir("checkout-");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "a checkout with no origin/main\n");
  git("add", "-A");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@test.invalid", "commit", "-q", "-m", "1");

  const withCheckout = await read({ codeDir: dir });
  assert.ok(withCheckout.facts.run.notes.includes("checkout_failed"), JSON.stringify(withCheckout.facts.run));

  const withoutCheckout = await read({ codeDir: null });
  assert.equal(withoutCheckout.facts.run.notes.includes("checkout_failed"), false);
});

// --- routing ---------------------------------------------------------------

test("each row of the route table routes to its repository", () => {
  const apps = {
    "org.frostyard.ChairLift": "frostyard/chairlift",
    "org.frostyard.nsl": "frostyard/nsl",
    "org.frostyard.intuneme": "frostyard/intuneme",
    "org.frostyard.pilothouse": "frostyard/pilothouse",
    "org.frostyard.Frostmail": "frostyard/frostmail",
    "org.frostyard.Frostnotes": "frostyard/frostnotes",
    "org.frostyard.Frostread": "frostyard/frostread",
  };
  for (const [appId, repo] of Object.entries(apps)) {
    assert.deepEqual(route(chairliftError({ app_id: appId }), ROUTES), { repo });
  }
  for (const kind of ["unit_failed", "update_stage_failed", "booted_older_image", "sysext_update_failed", "tpm_unlock", "integrity_error"]) {
    assert.deepEqual(route(exampleReport(kind), ROUTES), { repo: "frostyard/snosi" }, kind);
  }
  for (const kind of ["crash", "count"]) {
    assert.deepEqual(route(exampleReport(kind), ROUTES), { held: "kind_not_filed" }, kind);
  }
});

test("an app_id with no route is held unknown_route, and a not filed kind kind_not_filed", async () => {
  const routes = JSON.parse(JSON.stringify(ROUTES));
  delete routes.app_problem["org.frostyard.Frostread"];

  const unknown = await read({
    routes,
    issues: [issue(11, [{ report: chairliftError({ app_id: "org.frostyard.Frostread" }), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(unknown.facts.held.unknown_route, 1);
  assert.deepEqual(unknown.facts.problems, []);

  const notFiled = await read({ routes, issues: [issue(12, [{ report: exampleReport("crash"), dateCreated: "2026-11-20T10:00:00Z" }])] });
  assert.equal(notFiled.facts.held.kind_not_filed, 1);
  assert.deepEqual(notFiled.facts.problems, []);
});

test("the 7 apps reach their route in a whole run; a repository with no source is source_unavailable", async () => {
  const appIds = Object.keys(ROUTES.app_problem);
  // 1 issue for each app: a different app or code is a different fingerprint.
  const issues = appIds.map((appId, index) =>
    issue(200 + index, [
      {
        report: chairliftError({
          app_id: appId,
          code: appId === "org.frostyard.ChairLift" ? "store.migrate_failed" : `store.code_${index}`,
        }),
        dateCreated: `2026-11-1${index}T10:00:00Z`,
      },
    ]),
  );
  const run = await read({ issues });
  assert.deepEqual(run.facts.problems.map((problem) => problem.repo), ["frostyard/chairlift"]);
  // 5 apps have no fixture repository (source_unavailable); nsl has one whose
  // tags hold no v0.14.0 (unverified_version).
  assert.equal(run.facts.held.source_unavailable + run.facts.held.unverified_version, 6);
  assert.equal(run.facts.held.unverified_version, 1);
});

// --- noise -----------------------------------------------------------------

test("each row of the noise table is filed or held", () => {
  const rows = [
    [{ kind: "unit_failed" }, false],
    [{ kind: "update_stage_failed", detail: { error_class: "signature" } }, false],
    [{ kind: "update_stage_failed", detail: { error_class: "registry" } }, false],
    [{ kind: "update_stage_failed", detail: { error_class: "other" } }, false],
    [{ kind: "update_stage_failed", detail: { error_class: "network" } }, true],
    [{ kind: "update_stage_failed", detail: { error_class: "disk_space" } }, true],
    [{ kind: "update_stage_failed", detail: { error_class: "lock" } }, true],
    [{ kind: "booted_older_image", detail: { how: "unknown" } }, false],
    [{ kind: "booted_older_image", detail: { how: "other" } }, false],
    [{ kind: "booted_older_image", detail: { how: "manual_rollback" } }, true],
    [{ kind: "booted_older_image", detail: { how: "boot_menu" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "signature" } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "checksum" } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "http_status" } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "link" } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "config" } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "other" } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: undefined } }, false],
    [{ kind: "sysext_update_failed", detail: { outcome: "held_by_rollback" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "needs_image" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "skipped_unreachable" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "skipped_busy" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "other" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "network" } }, true],
    [{ kind: "sysext_update_failed", detail: { outcome: "failed", error_class: "disk_space" } }, true],
    [{ kind: "tpm_unlock" }, false],
    [{ kind: "integrity_error" }, false],
    [{ kind: "app_problem" }, false],
  ];
  for (const [{ kind, detail }, noise] of rows) {
    const report = exampleReport(kind);
    if (detail !== undefined) {
      const next = { ...report.detail, ...detail };
      for (const [name, value] of Object.entries(next)) if (value === undefined) delete next[name];
      report.detail = next;
    }
    assert.equal(isNoise(report), noise, `${kind} ${JSON.stringify(detail ?? {})}`);
  }
});

test("a problem whose every event is noise is held noise, and a filed one of the same kind is a problem", async () => {
  const noisy = exampleReport("update_stage_failed");
  noisy.detail.error_class = "network";
  const noisyRun = await oneProblem(noisy, { id: 31 });
  assert.equal(noisyRun.facts.held.noise, 1);
  assert.deepEqual(noisyRun.facts.problems, []);

  const filedRun = await oneProblem(unitFailed(), { id: 32 });
  assert.equal(filedRun.facts.held.noise, 0);
  assert.equal(filedRun.facts.problems.length, 1);

  const booted = exampleReport("booted_older_image");
  booted.detail.how = "boot_menu";
  const bootedRun = await oneProblem(booted, { id: 33 });
  assert.equal(bootedRun.facts.held.noise, 1);
});

// --- verification ----------------------------------------------------------

test("the app_version, image.version, target_version and newer_version checks", async () => {
  const appOk = await oneProblem(chairliftError());
  assert.equal(appOk.facts.problems.length, 1);
  assert.equal(appOk.facts.problems[0].observations[0].version, "0.14.0");

  const appBad = await oneProblem(chairliftError({ app_version: "0.16.0" }), { id: 42 });
  assert.equal(appBad.facts.held.unverified_version, 1);
  assert.deepEqual(appBad.facts.problems, []);

  const imageOk = await oneProblem(unitFailed(), { id: 43 });
  assert.equal(imageOk.facts.problems.length, 1);

  const otherImage = await oneProblem(
    { ...unitFailed(), image: { id: "sundog", version: "20261104081517" } },
    { id: 45 },
  );
  assert.equal(otherImage.facts.held.unverified_version, 1);

  const stage = exampleReport("update_stage_failed");
  stage.detail.error_class = "registry";
  const stageOk = await oneProblem(stage, { id: 46 });
  assert.equal(stageOk.facts.problems.length, 1);

  const stageBad = exampleReport("update_stage_failed");
  stageBad.detail.error_class = "registry";
  stageBad.detail.target_version = "20261231000000";
  const stageBadRun = await oneProblem(stageBad, { id: 47 });
  assert.equal(stageBadRun.facts.held.unverified_version, 1);

  const bootedOk = exampleReport("booted_older_image");
  bootedOk.detail.how = "unknown";
  const bootedOkRun = await oneProblem(bootedOk, { id: 48 });
  assert.equal(bootedOkRun.facts.problems.length, 1);

  const bootedBad = exampleReport("booted_older_image");
  bootedBad.detail.how = "unknown";
  bootedBad.detail.newer_version = "20261231000000";
  const bootedBadRun = await oneProblem(bootedBad, { id: 49 });
  assert.equal(bootedBadRun.facts.held.unverified_version, 1);
});

test("the sysext version check drops only feature_version", async () => {
  const listed = await oneProblem(sysextFailed(), { id: 51 });
  assert.equal(listed.facts.problems.length, 1);
  assert.equal(listed.facts.problems[0].fields.feature_version, "28.5.1");
  assert.equal(listed.facts.problems[0].observations[0].feature_version, "28.5.1");

  const unlisted = await oneProblem(sysextFailed({ version: "28.5.9" }), { id: 52 });
  assert.equal(unlisted.facts.problems.length, 1);
  assert.equal(Object.hasOwn(unlisted.facts.problems[0].fields, "feature_version"), false);
  assert.equal(unlisted.facts.problems[0].observations[0].feature_version, null);
});

test("the code literal with its quotes is looked for at the tag", async () => {
  const found = await oneProblem(chairliftError());
  assert.equal(found.facts.problems.length, 1);
  assert.equal(found.facts.problems[0].fields.code, "store.migrate_failed");

  const missing = await oneProblem(chairliftError({ code: "store.nowhere" }), { id: 53 });
  assert.equal(missing.facts.held.unverified_code, 1);
  assert.deepEqual(missing.facts.problems, []);
});

test("the unit and the feature allowlists", async () => {
  const allowed = await oneProblem(unitFailed());
  assert.equal(allowed.facts.problems.length, 1);

  const denied = await oneProblem(unitFailed({ unit: "user@.service" }), { id: 54 });
  assert.equal(denied.facts.held.not_allowlisted, 1);

  const featureAllowed = await oneProblem(sysextFailed());
  assert.equal(featureAllowed.facts.problems.length, 1);

  const featureDenied = await oneProblem(sysextFailed({ feature: "unknownfeat", version: "1.0.0" }), { id: 55 });
  assert.equal(featureDenied.facts.held.not_allowlisted, 1);
});

test("the location check: a file below a Cargo.toml folder, and a line too far", async () => {
  // v0.9.2 has a 3-line src/main.rs at the root and an 18-line
  // app/src-tauri/src/main.rs: the longer candidate verifies line 12.
  const ok = await oneProblem(nslPanic("src/main.rs:12"));
  assert.equal(ok.facts.problems.length, 1);
  assert.equal(ok.facts.problems[0].location, "src/main.rs:12");
  assert.deepEqual(ok.facts.problems[0].frames, []);

  const tooFar = await oneProblem(nslPanic("src/main.rs:99"), { id: 56 });
  assert.equal(tooFar.facts.held.unverified_code, 1);

  const noFile = await oneProblem(nslPanic("src/nowhere.rs:3"), { id: 57 });
  assert.equal(noFile.facts.held.unverified_code, 1);
});

// --- the frame rule --------------------------------------------------------

test("the module part table: /v2, /v10, /v20, /v1 and /vendor2", () => {
  const rows = [
    ["github.com/frostyard/app/internal/x.F", "github.com/frostyard/app", "internal/x"],
    ["github.com/frostyard/app/v2/pkg.F", "github.com/frostyard/app/v2", "pkg"],
    ["github.com/frostyard/app/v10.F", "github.com/frostyard/app/v10", ""],
    ["github.com/frostyard/app/v20/x.F", "github.com/frostyard/app/v20", "x"],
    ["github.com/frostyard/app/v1/x.F", "github.com/frostyard/app", "v1/x"],
    ["github.com/frostyard/app/vendor2/x.F", "github.com/frostyard/app", "vendor2/x"],
  ];
  for (const [frame, module, pkgpath] of rows) {
    const parsed = parseRoutedFrame(frame, "app");
    assert.equal(parsed.module, module, frame);
    assert.equal(parsed.pkgpath, pkgpath, frame);
  }
});

test("closure parsing: func1 and (*T).func1 are themselves, F.func1 and F.func1.2 are closures of F", () => {
  const at = (frame) => parseRoutedFrame(frame, "chairlift").parsed;
  assert.equal(at("github.com/frostyard/chairlift/internal/x.func1").depth, 0);
  assert.equal(at("github.com/frostyard/chairlift/internal/y.(*T).func1").depth, 0);
  assert.equal(at("github.com/frostyard/chairlift/internal/load.Run.func1").depth, 1);
  assert.equal(at("github.com/frostyard/chairlift/internal/load.Run.func1.2").depth, 2);
  assert.equal(
    at("github.com/frostyard/chairlift/internal/load.Run.func1.2").published,
    "github.com/frostyard/chairlift/internal/load.Run",
  );
});

test("each parent form verifies, and a closure publishes its parent", async () => {
  const rows = [
    ["github.com/frostyard/chairlift/internal/store.Migrate", "github.com/frostyard/chairlift/internal/store.Migrate"],
    ["github.com/frostyard/chairlift/internal/store.(*Store).Write", "github.com/frostyard/chairlift/internal/store.(*Store).Write"],
    ["github.com/frostyard/chairlift/internal/store.Store.Read", "github.com/frostyard/chairlift/internal/store.Store.Read"],
    ["github.com/frostyard/chairlift/internal/load.Load[...]", "github.com/frostyard/chairlift/internal/load.Load[...]"],
    ["github.com/frostyard/chairlift/internal/load.Run.func1", "github.com/frostyard/chairlift/internal/load.Run"],
    ["github.com/frostyard/chairlift/internal/load.Run.func1.2", "github.com/frostyard/chairlift/internal/load.Run"],
    ["github.com/frostyard/chairlift/internal/x.func1", "github.com/frostyard/chairlift/internal/x.func1"],
    ["github.com/frostyard/chairlift/internal/y.(*T).func1", "github.com/frostyard/chairlift/internal/y.(*T).func1"],
    ["github.com/frostyard/chairlift/internal/y.(T).func1", null],
    // The 2 generic receiver forms, matched and not.
    ["github.com/frostyard/chairlift/internal/store.(*Box[...]).Put", "github.com/frostyard/chairlift/internal/store.(*Box[...]).Put"],
    ["github.com/frostyard/chairlift/internal/store.(*Box[...]).Missing", null],
    ["github.com/frostyard/chairlift/internal/store.Box[...].Get", "github.com/frostyard/chairlift/internal/store.Box[...].Get"],
    ["github.com/frostyard/chairlift/internal/store.Box[...].Put", null],
    // Each plain form not matched: no such function, a value method looked up
    // as a pointer receiver's name, a pointer method as a value method.
    ["github.com/frostyard/chairlift/internal/store.Missing", null],
    ["github.com/frostyard/chairlift/internal/load.Missing[...]", null],
    ["github.com/frostyard/chairlift/internal/store.(*Store).Missing", null],
    ["github.com/frostyard/chairlift/internal/store.Store.Write", null],
  ];
  let id = 60;
  for (const [frame, published] of rows) {
    id += 1;
    const run = await oneProblem(
      chairliftPanic(["runtime.gopanic", frame, "github.com/frostyard/chairlift/cmd/chairlift.main"]),
      { id },
    );
    if (published === null) {
      assert.deepEqual(run.facts.problems, [], frame);
      assert.equal(run.facts.held.unverified_code, 1, frame);
      continue;
    }
    assert.equal(run.facts.problems.length, 1, frame);
    assert.equal(run.facts.problems[0].frames[1], published, frame);
  }
});

test("the negative frames never verify and are never published as themselves", async () => {
  const rows = [
    "github.com/frostyard/chairlift/internal/store.F[private_token]",
    "github.com/frostyard/chairlift/internal/store.(*T[x]).F",
    "github.com/frostyard/chairlift/internal/store.F.funcX",
    "github.com/frostyard/chairlift/internal/nowhere.Real",
    "github.com/frostyard/chairlift/internal/store.private_token.Real",
  ];
  let id = 70;
  for (const frame of rows) {
    id += 1;
    const run = await oneProblem(chairliftPanic([frame, "runtime.gopanic", "github.com/frostyard/chairlift/cmd/chairlift.main"]), { id });
    assert.deepEqual(run.facts.problems, [], frame);
    assert.equal(run.facts.held.unverified_code, 1, frame);
  }
});

test("a frame after the first 3 is shown as unverified when it does not verify", async () => {
  const run = await oneProblem(
    chairliftPanic([
      "runtime.gopanic",
      "github.com/frostyard/chairlift/internal/store.Migrate",
      "github.com/frostyard/chairlift/cmd/chairlift.main",
      "github.com/frostyard/chairlift/internal/nowhere.Real",
    ]),
    { id: 79 },
  );
  assert.equal(run.facts.problems.length, 1);
  assert.deepEqual(run.facts.problems[0].frames, [
    "runtime",
    "github.com/frostyard/chairlift/internal/store.Migrate",
    "github.com/frostyard/chairlift/cmd/chairlift.main",
    "unverified",
  ]);
});

test("a go panic with no verified routed frame among its frames is held unverified_code", async () => {
  const run = await oneProblem(chairliftPanic(["runtime.gopanic", "runtime.panicmem", "main.main"]), { id: 80 });
  assert.deepEqual(run.facts.problems, []);
  assert.equal(run.facts.held.unverified_code, 1);
});

test("a go panic with no frames at all is filed with app_id, runtime and component", async () => {
  const report = chairliftPanic([]);
  report.detail.frames = undefined;
  const run = await oneProblem(report, { id: 81 });
  assert.equal(run.facts.problems.length, 1);
  assert.deepEqual(run.facts.problems[0].fields, { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" });
  assert.deepEqual(run.facts.problems[0].frames, []);
});

// --- key stability ---------------------------------------------------------

const sha16 = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);

test("the key equals the Worker fingerprint for every example report", () => {
  const names = ["app_problem", "booted_older_image", "count", "crash", "integrity_error", "sysext_update_failed", "tpm_unlock", "unit_failed", "update_stage_failed"];
  for (const name of names) {
    const report = exampleReport(name);
    const rebuilt = rebuildReport(eventRow(report, "2026-11-20T10:00:00Z"));
    assert.notEqual(rebuilt, null, name);
    assert.deepEqual(rawFingerprint(rebuilt), buildEvent(report).fingerprint, name);
    if (!Array.isArray(report.detail.frames)) {
      assert.equal(problemKey(rebuilt, "x"), sha16(buildEvent(report).fingerprint), name);
    }
  }
});

test("a frame removed in the newer release keeps the key and drops the newer observation", async () => {
  const framesAt = (version) =>
    chairliftPanic(
      ["runtime.gopanic", "github.com/frostyard/chairlift/internal/store.(*Store).Drop", "github.com/frostyard/chairlift/cmd/chairlift.main"],
      { app_version: version },
    );
  const run = await read({
    issues: [
      issue(91, [
        { report: framesAt("0.15.0"), dateCreated: "2026-11-20T10:00:00Z" },
        { report: framesAt("0.14.0"), dateCreated: "2026-11-10T10:00:00Z" },
      ]),
    ],
  });
  assert.equal(run.facts.problems.length, 1);
  const problem = run.facts.problems[0];
  assert.deepEqual(problem.observations.map((one) => one.version), ["0.14.0"]);
  assert.equal(problem.key, problemKey(framesAt("0.14.0"), "chairlift"));
  assert.equal(problem.key, problemKey(framesAt("0.15.0"), "chairlift"));
});

test("a code that verifies at version 1 and not at version 2 drops the version 2 observation", async () => {
  const report = (version) => chairliftError({ app_version: version, code: "store.legacy_failed" });
  const run = await read({
    issues: [
      issue(92, [
        { report: report("0.15.0"), dateCreated: "2026-11-20T10:00:00Z" },
        { report: report("0.14.0"), dateCreated: "2026-11-10T10:00:00Z" },
      ]),
    ],
  });
  assert.equal(run.facts.problems.length, 1);
  assert.deepEqual(run.facts.problems[0].observations.map((one) => one.version), ["0.14.0"]);
  assert.equal(run.facts.problems[0].key, problemKey(report("0.14.0"), "chairlift"));

  const allDropped = await oneProblem(report("0.15.0"), { id: 93 });
  assert.equal(allDropped.facts.held.unverified_code, 1);
});

test("a module that moved to /v2 drops the old raw frame at the new tag and keeps the key", async () => {
  const frames = ["runtime.gopanic", "github.com/frostyard/chairlift/internal/store.Migrate", "github.com/frostyard/chairlift/cmd/chairlift.main"];
  const run = await oneProblem(chairliftPanic(frames, { app_version: "2.0.0" }), { id: 94 });
  assert.deepEqual(run.facts.problems, []);
  assert.equal(run.facts.held.unverified_code, 1);
  assert.equal(
    problemKey(chairliftPanic(frames, { app_version: "2.0.0" }), "chairlift"),
    problemKey(chairliftPanic(frames), "chairlift"),
  );
});

test("semver precedence and numeric image order", () => {
  assert.equal(compareSemver("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareSemver("1.0.0-alpha.1", "1.0.0-beta.1"), -1);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-rc.1"), -1);
  assert.equal(compareSemver("1.0.0-beta.2", "1.0.0-beta.10"), -1);
  assert.equal(compareSemver("1.2.0", "1.10.0"), -1);
  assert.equal(compareSemver("2.0.0", "1.99.99"), 1);
  assert.equal(compareSemver("1.0.0", "1.0.0"), 0);
  assert.equal(compareImageVersion("20261031093822", "20261104081517"), -1);
  assert.ok(compareImageVersion("20261110093000", "20261104081517") > 0);
});

// --- group building --------------------------------------------------------

test("a forged event in a valid group is dropped and the problem stays", async () => {
  const good = unitFailed();
  const forged = unitFailed({ result: "timeout" });
  const run = await read({
    issues: [
      issue(101, [
        { report: good, dateCreated: "2026-11-20T10:00:00Z" },
        { report: good, dateCreated: "2026-11-19T10:00:00Z" },
        { report: forged, dateCreated: "2026-11-18T10:00:00Z" },
      ]),
    ],
  });
  assert.equal(run.facts.problems.length, 1);
  assert.equal(run.facts.problems[0].class, "exit-code");
  assert.match(run.out.text, /dropped_events=1/);
});

test("2 images in 1 key give 1 problem with 2 observations, sorted", async () => {
  const snow = unitFailed();
  snow.image = { id: "snow", version: "20261031093822" };
  const run = await read({
    issues: [
      issue(102, [
        { report: snow, dateCreated: "2026-11-20T10:00:00Z" },
        { report: unitFailed(), dateCreated: "2026-11-19T10:00:00Z" },
      ]),
    ],
  });
  assert.equal(run.facts.problems.length, 1);
  assert.deepEqual(
    run.facts.problems[0].observations.map((one) => [one.image, one.last_seen_day]),
    [
      ["floe", "2026-11-19"],
      ["snow", "2026-11-20"],
    ],
  );
});

test("2 GlitchTip issues with 1 key give 1 problem with both ids", async () => {
  const run = await read({
    issues: [
      issue(103, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }], "2026-11-20T10:00:00Z"),
      issue(104, [{ report: unitFailed(), dateCreated: "2026-11-18T10:00:00Z" }], "2026-11-18T10:00:00Z"),
    ],
  });
  assert.equal(run.facts.problems.length, 1);
  assert.deepEqual(run.facts.problems[0].glitchtip_issue_ids, [103, 104]);
  assert.equal(run.facts.problems[0].first_seen_day, "2026-11-18");
});

// --- the cutoff, the cap, the deadline, the fair order ---------------------

test("a null cutoff holds every issue before_cutoff and reads no event", async () => {
  const run = await read({ cutoff: null, issues: [issue(111, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])] });
  assert.equal(run.facts.held.before_cutoff, 1);
  assert.deepEqual(run.facts.problems, []);
  assert.deepEqual(run.log.map((one) => one.path), ["/api/0/organizations/frostyard/issues/"]);
});

test("an issue before the cutoff is held before_cutoff, and 1 on the cutoff is read", async () => {
  const before = await read({
    cutoff: "2026-11-01T00:00:00Z",
    issues: [issue(112, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }], "2026-10-31T23:59:59Z")],
  });
  assert.equal(before.facts.held.before_cutoff, 1);

  const on = await read({
    cutoff: "2026-11-01T00:00:00Z",
    issues: [issue(113, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }], "2026-11-01T00:00:00Z")],
  });
  assert.equal(on.facts.held.before_cutoff, 0);
  assert.equal(on.facts.problems.length, 1);
});

test("the load cap stops the run and leaves the rest held request_cap", async () => {
  const run = await read({
    cap: 2,
    issues: [
      issue(114, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }]),
      issue(115, [{ report: unitFailed({ unit: "snosi-health-report.service" }), dateCreated: "2026-11-20T10:00:00Z" }]),
    ],
  });
  assert.equal(run.facts.run.status, "partial");
  assert.equal(run.facts.held.request_cap, 1);
  assert.equal(run.facts.problems.length, 1);
  assert.equal(run.log.length, 2);
});

test("an issue whose event read the cap cuts has coverage partial", async () => {
  mock.setPageSize(1);
  try {
    const run = await read({
      cap: 2,
      issues: [
        issue(116, [
          { report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" },
          { report: unitFailed(), dateCreated: "2026-11-19T10:00:00Z" },
        ]),
      ],
    });
    assert.equal(run.facts.run.status, "partial");
    assert.equal(run.facts.problems.length, 1);
    assert.equal(run.facts.problems[0].coverage, "partial");
  } finally {
    mock.setPageSize(50);
  }
});

test("the deadline stops the run with status partial", async () => {
  const run = await read({ deadlineMs: 0, issues: [issue(117, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])] });
  assert.equal(run.facts.run.status, "partial");
  assert.deepEqual(run.log, []);
});

test("the fair order: an issue the cap skipped comes first in the next run", async () => {
  const issues = [
    issue(118, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }]),
    issue(119, [{ report: unitFailed({ unit: "snosi-health-report.service" }), dateCreated: "2026-11-20T10:00:00Z" }]),
  ];
  const prepared = prepare();
  const first = await read({ prepared, cap: 2, issues });
  assert.equal(first.facts.held.request_cap, 1);
  const health = healthOf(prepared);
  assert.deepEqual(Object.keys(health.last_read), ["118"]);
  assert.deepEqual(Object.keys(health.issue_keys), ["118"]);

  const second = await read({ prepared, issues });
  const eventReads = second.log.filter((one) => one.path.includes("/events/")).map((one) => one.path.split("/")[4]);
  assert.deepEqual(eventReads, ["119", "118"]);
  assert.equal(second.facts.problems.length, 2);
});

// --- watched ---------------------------------------------------------------

const watchedPublished = (ids) => ({
  schema: "frostyard.problem-triage-published/1",
  keys: { deadbeefdeadbeef: { repo: "frostyard/snosi", number: 5, cycle: 1, state: "released", glitchtip_issue_ids: ids } },
});
const watchedHealth = (ids) => ({
  last_read: Object.fromEntries(ids.map((id) => [String(id), "2026-11-19"])),
  issue_keys: Object.fromEntries(ids.map((id) => [String(id), "deadbeefdeadbeef"])),
});

test("watched: a released key with no GlitchTip issue any more is complete", async () => {
  const run = await read({ published: watchedPublished([199]), health: watchedHealth([199]) });
  assert.deepEqual(run.facts.watched, [{ key: "deadbeefdeadbeef", coverage: "complete" }]);
});

test("watched: an issue held source_unavailable makes the entry partial", async () => {
  const failing = makeFetch((url) => (url.startsWith(mock.baseUrl) ? null : { status: 500, body: {} }));
  const run = await read({
    published: watchedPublished([195]),
    health: watchedHealth([195]),
    sources: null,
    fetch: failing,
    issues: [issue(195, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.source_unavailable, 1);
  assert.deepEqual(run.facts.watched, [{ key: "deadbeefdeadbeef", coverage: "partial" }]);
});

test("watched: an issue held request_cap makes the entry partial", async () => {
  const run = await read({
    cap: 1,
    published: watchedPublished([196]),
    health: watchedHealth([196]),
    issues: [issue(196, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.request_cap, 1);
  assert.deepEqual(run.facts.watched, [{ key: "deadbeefdeadbeef", coverage: "partial" }]);
});

test("watched: a released key held unverified_version is complete with no observation", async () => {
  const run = await read({
    published: watchedPublished([197]),
    health: watchedHealth([197]),
    issues: [issue(197, [{ report: chairliftError({ app_version: "0.99.0" }), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.unverified_version, 1);
  assert.deepEqual(run.facts.problems, []);
  assert.deepEqual(run.facts.watched, [{ key: "deadbeefdeadbeef", coverage: "complete" }]);
});

test("watched: an issue whose key is unknown and which the cap skipped makes every entry partial", async () => {
  const run = await read({
    cap: 2,
    published: watchedPublished([198]),
    health: watchedHealth([198]),
    issues: [
      issue(198, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }]),
      issue(190, [{ report: unitFailed({ unit: "snosi-health-report.service" }), dateCreated: "2026-11-20T10:00:00Z" }]),
    ],
  });
  assert.equal(run.facts.held.request_cap, 1);
  assert.deepEqual(run.facts.watched, [{ key: "deadbeefdeadbeef", coverage: "partial" }]);
});

test("watched: an issue held before_cutoff takes no part", async () => {
  const run = await read({
    cutoff: "2026-11-01T00:00:00Z",
    published: watchedPublished([194]),
    health: watchedHealth([194]),
    issues: [issue(194, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }], "2026-10-01T00:00:00Z")],
  });
  assert.equal(run.facts.held.before_cutoff, 1);
  assert.deepEqual(run.facts.watched, [{ key: "deadbeefdeadbeef", coverage: "complete" }]);
});

// --- failures --------------------------------------------------------------

// A fetch that answers some URLs itself and passes the rest to the real 1.
function makeFetch(route) {
  return async (url, options) => {
    const answer = route(String(url), options);
    if (answer === null) return await fetch(url, options);
    return {
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: new Headers(answer.headers ?? {}),
      text: async () => (typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body ?? "")),
    };
  };
}

test("a git read that fails holds the problem source_unavailable", async () => {
  const run = await read({
    runGit: async () => {
      throw Object.assign(new Error("git is not readable in this test"), { code: "failed" });
    },
    issues: [issue(201, [{ report: chairliftError(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.source_unavailable, 1);
  assert.equal(run.facts.run.status, "ok");
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.facts.problems, []);
});

// Required test: the tag is listed by ls-remote, but its fetch fails. The
// classification and the key are still known, and no value goes out.
test("a tag that cannot be read holds the problem source_unavailable with the same key", async () => {
  const good = await oneProblem(chairliftError(), { id: 202 });
  assert.equal(good.facts.problems.length, 1);
  const key = good.facts.problems[0].key;

  const real = (args, options) => new Promise((resolve, reject) => {
    execFile("git", args, options, (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve({ stdout })));
  });
  const run = await read({
    runGit: async (args, options) => {
      if (args.includes("fetch")) throw Object.assign(new Error("the fetch fails in this test"), { code: 128 });
      return await real(args, options);
    },
    issues: [issue(202, [{ report: chairliftError(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.source_unavailable, 1);
  assert.deepEqual(run.facts.problems, []);
  assert.equal(healthOf(run).issue_keys["202"], key);
});

test("a registry read that fails holds the problem source_unavailable", async () => {
  const failing = makeFetch((url) => (url.startsWith(mock.baseUrl) ? null : { status: 500, body: {} }));
  const run = await read({
    sources: null,
    fetch: failing,
    issues: [issue(202, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.source_unavailable, 1);
});

test("an index read that fails holds the problem source_unavailable, and the production registry path works", async () => {
  const seen = [];
  const failingIndex = makeFetch((url) => {
    if (url.startsWith(mock.baseUrl)) return null;
    seen.push(url);
    if (url.includes("/token?")) return { status: 200, body: { token: "registry-token-not-a-secret" } };
    if (url.includes("/tags/list")) return { status: 200, body: { tags: ["20261031093822"] } };
    return { status: 500, body: {} };
  });
  const run = await read({
    sources: null,
    fetch: failingIndex,
    issues: [issue(203, [{ report: sysextFailed(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.held.source_unavailable, 1);
  assert.ok(seen.some((url) => url.startsWith("https://ghcr.io/token?scope=repository:frostyard/floe:pull")));
  assert.ok(seen.some((url) => url.includes("/v2/frostyard/floe/tags/list")));
});

// The exit codes of the Failures table, from a child process: the reader's own
// entry point, with TRIAGE_TEST=1 and the override variables.
function childRun(env) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [READ],
      { encoding: "utf8", env: { PATH: process.env.PATH, TRIAGE_TEST: "1", ...env } },
      (error, stdout, stderr) => resolve({ status: error === null ? 0 : (error.code ?? 1), stdout, stderr }),
    );
  });
}

test("the exit codes of the Failures table", async () => {
  const prepared = prepare();
  const base = { TRIAGE_TOKEN_FILE: prepared.tokenFile, TRIAGE_STATE_DIR: prepared.stateDir, TRIAGE_SOURCES: SOURCES };
  // Each child run starts from an empty mock with 1 planned answer.
  const childWith = async (directives) => {
    mock.setIssues([]);
    mock.clearLog();
    mock.state.plan.length = 0;
    mock.state.handler = null;
    mock.state.delayMs = 0;
    mock.planStatus(...directives);
    return await childRun({ ...base, TRIAGE_GLITCHTIP_URL: mock.baseUrl });
  };

  // config: no token file.
  const noToken = prepare({ token: null });
  const config = await childRun({ ...base, TRIAGE_TOKEN_FILE: noToken.tokenFile });
  assert.equal(config.status, 2, config.stderr);
  assert.match(config.stderr, /^triage-read: config token$/m);

  // auth: 401 and 403.
  for (const status of [401, 403]) {
    const run = await childWith([{ status }]);
    assert.equal(run.status, 3, `${status}: ${run.stderr}`);
    assert.match(run.stderr, /^triage-read: auth auth$/m);
  }

  // unreachable: a 500 and 2 times 429.
  const serverError = await childWith([{ status: 500 }]);
  assert.equal(serverError.status, 4, serverError.stderr);
  const twice = await childWith([{ status: 429, headers: { "retry-after": "0" } }, { status: 429, headers: { "retry-after": "0" } }]);
  assert.equal(twice.status, 4, twice.stderr);

  // unreachable: a network error.
  const network = await childRun({ ...base, TRIAGE_GLITCHTIP_URL: "http://127.0.0.1:1/api/0/" });
  assert.equal(network.status, 4, network.stderr);

  // error: a 3xx, bad JSON, a wrong shape and a cursor of an unexpected shape.
  for (const directive of [
    { status: 302, headers: { location: "http://127.0.0.1:1/" } },
    { status: 200, body: "not json" },
    { status: 200, body: {} },
    { status: 200, body: [], headers: { link: '<http://127.0.0.1/x/>; rel="next"; results="true"; cursor="a b"' } },
  ]) {
    const run = await childWith([directive]);
    assert.equal(run.status, 5, `${JSON.stringify(directive)}: ${run.stderr}`);
    assert.match(run.stderr, /^triage-read: error error$/m);
  }

  // Every failed run wrote facts.json with its status and no problems.
  const facts = factsOf(prepared);
  assertFacts(facts);
  assert.equal(facts.run.status, "error");
  assert.deepEqual(facts.problems, []);
});

test("a timeout is unreachable", async () => {
  const run = await read({ timeoutMs: 50, delayMs: 300 });
  assert.equal(run.exitCode, 4);
  assert.equal(run.facts.run.status, "unreachable");
});

test("the client pauses between requests and not before the first 1", async () => {
  mock.setPageSize(1);
  const waits = [];
  try {
    const run = await read({
      pauseMs: 25,
      sleep: async (ms) => {
        waits.push(ms);
      },
      issues: [
        issue(271, [
          { report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" },
          { report: unitFailed(), dateCreated: "2026-11-19T10:00:00Z" },
        ]),
      ],
    });
    // 1 list page, 2 event pages, and 3 requests in all: 2 pauses.
    assert.equal(run.log.length, 3);
    assert.deepEqual(waits, [25, 25]);
  } finally {
    mock.setPageSize(50);
  }
});

test("a 429 waits Retry-After once and then reads the page", async () => {
  const waits = [];
  const run = await read({
    sleep: async (ms) => {
      waits.push(ms);
    },
    plan: [{ status: 429, headers: { "retry-after": "3" } }, { status: 200, body: [] }],
  });
  assert.equal(run.exitCode, 0, run.err.text);
  assert.equal(run.facts.run.status, "ok");
  assert.deepEqual(waits, [3000]);
});

test("a fatal reading error stops the run and leaves health.json as it was", async () => {
  const prepared = prepare({ health: { last_read: { 7: "2026-11-01" }, issue_keys: {} } });
  const run = await read({ prepared, plan: [{ status: 401 }] });
  assert.equal(run.exitCode, 3);
  assert.equal(run.facts.run.status, "auth");
  assert.deepEqual(healthOf(prepared), { last_read: { 7: "2026-11-01" }, issue_keys: {} });
});

// --- the state folder ------------------------------------------------------

test("the state folder is 0700, both files are 0600, and health.json keeps what it does not own", async () => {
  const prepared = prepare({ health: { runs: [{ day: "2026-11-20", status: "ok" }], last_read: {}, issue_keys: {} } });
  const run = await read({ prepared, issues: [issue(211, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])] });
  assert.equal(run.exitCode, 0);
  assert.equal(statSync(prepared.stateDir).mode & 0o777, 0o700);
  for (const name of ["facts.json", "health.json"]) {
    assert.equal(statSync(join(prepared.stateDir, name)).mode & 0o777, 0o600, name);
  }
  const health = healthOf(prepared);
  assert.deepEqual(health.runs, [{ day: "2026-11-20", status: "ok" }]);
  assert.deepEqual(health.last_read, { 211: DAY });
  assert.deepEqual(Object.keys(health.issue_keys), ["211"]);
});

test("health.json drops an id that left the issue list", async () => {
  const prepared = prepare({ health: { last_read: { 5: "2026-11-01" }, issue_keys: { 5: "aaaaaaaaaaaaaaaa" } } });
  await read({ prepared, issues: [issue(212, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])] });
  const health = healthOf(prepared);
  assert.equal(Object.hasOwn(health.last_read, "5"), false);
  assert.equal(Object.hasOwn(health.issue_keys, "5"), false);
});

// --- diagnostics, the summary, a deleted issue, a broken report -------------

test("no token, event id or report id is in a state file or in a diagnostic line", async () => {
  const report = unitFailed();
  const run = await read({ issues: [issue(221, [{ report, dateCreated: "2026-11-20T10:00:00Z" }])] });
  assert.equal(run.exitCode, 0);
  const event = buildEvent(report);
  const forms = [event.event_id, report.report_id, report.report_id.replaceAll("-", "")];
  for (const name of ["facts.json", "health.json"]) {
    const text = readFileSync(join(run.stateDir, name), "utf8");
    for (const form of forms) assert.equal(text.includes(form), false, `${name} holds ${form}`);
  }
  for (const line of [run.out.text, run.err.text]) {
    for (const form of [...forms, FAKE_TOKEN]) assert.equal(line.includes(form), false, `a diagnostic line holds ${form}`);
  }
});

test("--summary prints the facts and sends no request", async () => {
  const prepared = prepare();
  const run = await read({ prepared, issues: [issue(231, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])] });
  const key = run.facts.problems[0].key;
  mock.clearLog();
  const out = sink();
  const err = sink();
  const code = printSummary({
    env: { TRIAGE_TEST: "1", TRIAGE_STATE_DIR: prepared.stateDir },
    home: prepared.dir,
    stdout: out,
    stderr: err,
  });
  assert.equal(code, 0);
  assert.deepEqual(mock.log, []);
  assert.match(out.text, new RegExp(`problem key=${key} repo=frostyard/snosi kind=unit_failed class=exit-code`));
  assert.match(out.text, /fields=unit=snosi-health\.service,result=exit-code/);
  assert.match(out.text, /held before_cutoff=0 /);
  assert.equal(err.text, "");
});

test("--summary without facts, and with invalid facts", () => {
  const empty = prepare();
  const out = sink();
  const err = sink();
  assert.equal(printSummary({ env: { TRIAGE_TEST: "1", TRIAGE_STATE_DIR: empty.stateDir }, home: empty.dir, stdout: out, stderr: err }), 1);
  assert.equal(err.text, "triage-read: no facts\n");

  const bad = prepare();
  writeFileSync(join(bad.stateDir, "facts.json"), `${JSON.stringify({ schema: "wrong" })}\n`, { mode: 0o600 });
  const badOut = sink();
  const badErr = sink();
  assert.equal(printSummary({ env: { TRIAGE_TEST: "1", TRIAGE_STATE_DIR: bad.stateDir }, home: bad.dir, stdout: badOut, stderr: badErr }), 5);
  assert.match(badErr.text, /^triage-read: facts invalid /);
});

test("the reader's own entry point with --summary exits 0 on the facts it wrote", async () => {
  const prepared = prepare();
  await read({ prepared, issues: [issue(241, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])] });
  const run = spawnSync(process.execPath, [READ, "--summary"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, TRIAGE_TEST: "1", TRIAGE_STATE_DIR: prepared.stateDir },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /triage-read: problem key=/);
});

test("a report whose tags are not a valid report is dropped and counted", async () => {
  const broken = eventRow(unitFailed(), "2026-11-20T10:00:00Z");
  broken.context = { detail: { unit: "not a unit" } };
  const run = await read({ issues: [{ id: 251, firstSeen: "2026-11-20T10:00:00Z", events: [broken] }] });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.facts.problems, []);
  assert.equal(run.facts.held.request_cap, 0);
  assert.match(run.out.text, /dropped_events=1/);
});

test("an issue deleted during the run is skipped", async () => {
  const run = await read({
    handler: (req, url) => (url.pathname.startsWith("/api/0/issues/") ? { status: 404 } : null),
    issues: [issue(252, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.facts.problems, []);
  assert.equal(run.facts.held.request_cap, 0);
});

test("the state folder is created when it is missing", async () => {
  const prepared = prepare();
  rmSync(prepared.stateDir, { recursive: true, force: true });
  const run = await read({ prepared });
  assert.equal(run.exitCode, 0);
  assert.equal(statSync(prepared.stateDir).mode & 0o777, 0o700);
  assert.ok(existsSync(join(prepared.stateDir, "facts.json")));
});

test("a missing routes.json is an error with no request", async () => {
  const prepared = prepare();
  rmSync(join(prepared.triageDir, "routes.json"));
  const run = await read({ prepared });
  assert.equal(run.exitCode, 5);
  assert.equal(run.facts.run.status, "error");
  assert.deepEqual(run.log, []);
  assert.equal(prepared.err.text, "triage-read: error triage_data\n");
});

test("a key and a verified closure frame are stable across 2 runs", async () => {
  const frames = ["runtime.gopanic", "github.com/frostyard/chairlift/internal/load.Run.func1", "github.com/frostyard/chairlift/cmd/chairlift.main"];
  const first = await oneProblem(chairliftPanic(frames), { id: 261 });
  const second = await oneProblem(chairliftPanic(frames), { id: 262 });
  assert.equal(first.facts.problems[0].key, second.facts.problems[0].key);
  assert.equal(keyForm(frames[1], "chairlift"), "github.com/frostyard/chairlift/internal/load.Run");
  assert.equal(first.facts.problems[0].frames[1], "github.com/frostyard/chairlift/internal/load.Run");
});

test("a frame of another frostyard module and a standard library frame are fixed forms", async () => {
  const run = await oneProblem(
    chairliftPanic([
      "runtime.gopanic",
      "github.com/frostyard/updex/v2/internal/index.Write",
      "github.com/frostyard/chairlift/internal/store.Migrate",
    ]),
    { id: 263 },
  );
  assert.equal(run.facts.problems.length, 1);
  assert.deepEqual(run.facts.problems[0].frames, [
    "runtime",
    "frostyard",
    "github.com/frostyard/chairlift/internal/store.Migrate",
  ]);
});


// --- review guards ----------------------------------------------------------

// A forged event that is newer than a real 1 of the same version must not
// hold the real 1 back: the minimum of 1 verified routed frame is a check of
// each observation, before the representative event is chosen.
test("a newer event with no verified routed frame does not hide an older real 1", async () => {
  const head = ["runtime.gopanic", "runtime.panicmem", "main.main"];
  const real = chairliftPanic([...head, "github.com/frostyard/chairlift/internal/store.Migrate"]);
  const forged = chairliftPanic([...head, "github.com/frostyard/chairlift/internal/store.Forged"]);
  const run = await read({
    issues: [
      issue(301, [
        { report: forged, dateCreated: "2026-11-20T10:00:00Z" },
        { report: real, dateCreated: "2026-11-19T10:00:00Z" },
      ]),
    ],
  });
  assert.equal(run.facts.problems.length, 1);
  assert.equal(run.facts.held.unverified_code, 0);
  assert.deepEqual(run.facts.problems[0].frames, [
    "runtime",
    "runtime",
    "main",
    "github.com/frostyard/chairlift/internal/store.Migrate",
  ]);
  assert.equal(run.facts.problems[0].observations[0].last_seen_day, "2026-11-19");
});

// A new issue of a released key, with no earlier mapping, that fails its
// source check keeps the watched entry partial.
test("watched: a newly learned issue of a released key held source_unavailable is partial", async () => {
  const report = chairliftError();
  const key = problemKey(report, "chairlift");
  const run = await read({
    published: {
      schema: "frostyard.problem-triage-published/1",
      keys: { [key]: { state: "released", glitchtip_issue_ids: [] } },
    },
    runGit: async () => {
      throw Object.assign(new Error("git is not readable in this test"), { code: "failed" });
    },
    issues: [issue(302, [{ report, dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.run.status, "ok");
  assert.equal(run.facts.held.source_unavailable, 1);
  assert.deepEqual(run.facts.watched, [{ key, coverage: "partial" }]);
  assert.equal(healthOf(run).issue_keys["302"], key);
});

// An issue with no valid report in its 30 days learns its key from an older
// event; read in full, it cannot hold a qualifying observation.
test("watched: an issue with only old events still gives its key, and the entry stays complete", async () => {
  const report = unitFailed();
  const key = problemKey(report, "snosi");
  const run = await read({
    published: {
      schema: "frostyard.problem-triage-published/1",
      keys: { [key]: { state: "released", glitchtip_issue_ids: [] } },
    },
    issues: [issue(303, [{ report, dateCreated: "2026-09-01T10:00:00Z" }], "2026-09-01T10:00:00Z")],
  });
  assert.equal(healthOf(run).issue_keys["303"], key);
  assert.deepEqual(run.facts.problems, []);
  assert.deepEqual(run.facts.watched, [{ key, coverage: "complete" }]);
});

// The deadline covers the source checks too: past it, the key is held
// request_cap and the run is partial.
test("the deadline stops the source checks: request_cap and partial", async () => {
  let expired = false;
  const real = (args, options) => new Promise((resolve, reject) => {
    execFile("git", args, options, (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve({ stdout })));
  });
  const run = await read({
    clock: () => (expired ? NOW + 16 * 60 * 1000 : NOW),
    runGit: async (args, options) => {
      expired = true;
      return await real(args, options);
    },
    issues: [
      issue(304, [{ report: chairliftError(), dateCreated: "2026-11-20T10:00:00Z" }]),
      issue(305, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }]),
    ],
  });
  assert.equal(run.facts.run.status, "partial");
  assert.equal(run.exitCode, 0);
  assert.ok(run.facts.held.request_cap >= 1, `request_cap ${run.facts.held.request_cap}`);
  assert.equal(run.facts.problems.length + run.facts.held.request_cap, 2);
});

// GlitchTip 6.2.6 serves `date_created` on the event list; the Sentry form
// `dateCreated` is read too.
test("an event row in the Sentry camel case form is read too", async () => {
  mock.state.camelEvents = true;
  try {
    const run = await oneProblem(unitFailed(), { id: 306 });
    assert.equal(run.facts.problems.length, 1);
  } finally {
    mock.state.camelEvents = false;
  }
});

// The deadline inside the last key: a source read that ends after the
// deadline, and a read that the deadline makes fail, both hold the key
// request_cap with a partial run, and no further source read starts.
for (const outcome of ["returns", "fails"]) {
  test(`the deadline inside the last key's checks (the read ${outcome}): request_cap, partial, no more reads`, async () => {
    let expired = false;
    let afterExpiry = 0;
    const real = (args, options) => new Promise((resolve, reject) => {
      execFile("git", args, options, (error, stdout) => (error ? reject(Object.assign(error, { stdout })) : resolve({ stdout })));
    });
    const run = await read({
      clock: () => (expired ? NOW + 16 * 60 * 1000 : NOW),
      runGit: async (args, options) => {
        if (expired) afterExpiry += 1;
        expired = true;
        if (outcome === "fails") throw Object.assign(new Error("the read timed out in this test"), { code: null, killed: true });
        return await real(args, options);
      },
      issues: [issue(307, [{ report: chairliftError(), dateCreated: "2026-11-20T10:00:00Z" }])],
    });
    assert.equal(run.facts.run.status, "partial");
    assert.equal(run.exitCode, 0);
    assert.equal(run.facts.held.request_cap, 1);
    assert.equal(run.facts.held.source_unavailable, 0);
    assert.deepEqual(run.facts.problems, []);
    assert.equal(afterExpiry, 0);
  });
}

// The deadline inside an HTTP source read: the registry answers its headers
// before the deadline, and its body read fails after it. The key is held
// request_cap, not source_unavailable, and the run is partial.
test("the deadline inside a registry body read: request_cap and partial", async () => {
  let expired = false;
  const run = await read({
    sources: null,
    clock: () => (expired ? NOW + 16 * 60 * 1000 : NOW),
    fetch: async (url, options) => {
      const text = String(url);
      if (text.startsWith(mock.baseUrl)) return await fetch(url, options);
      if (text.includes("/token?")) {
        return { status: 200, ok: true, headers: new Headers(), text: async () => JSON.stringify({ token: "registry-token-not-a-secret" }) };
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        text: async () => {
          expired = true;
          throw new Error("the body read was aborted in this test");
        },
      };
    },
    issues: [issue(308, [{ report: unitFailed(), dateCreated: "2026-11-20T10:00:00Z" }])],
  });
  assert.equal(run.facts.run.status, "partial");
  assert.equal(run.exitCode, 0);
  assert.equal(run.facts.held.request_cap, 1);
  assert.equal(run.facts.held.source_unavailable, 0);
  assert.deepEqual(run.facts.problems, []);
});
