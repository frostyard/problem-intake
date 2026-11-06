// The triage watchdog (docs/specs/triage.md, "The publisher": watchdog). It
// reads `heartbeat` and comments on the health issue when no run completed for
// more than 2 days. No network: the fake `gh` of test/fixtures/triage/gh
// answers from a JSON state file, and each test passes `now`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../../scripts/triage/watchdog.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const FAKE_GH_DIR = join(root, "test/fixtures/triage/gh");
const TODAY = "2026-11-21";
const NOW = "2026-11-21T12:00:00Z";
const WATCHDOG_TEXT = "The triage job has not completed a run in the last 2 days.";

const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function makeWorld({ heartbeat = null, healthIssue = true, comments = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "triage-watchdog-"));
  temps.push(dir);
  const stateDir = join(dir, "state");
  mkdirSync(stateDir, { recursive: true });
  const ghStatePath = join(dir, "gh.json");
  const repos = {};
  if (healthIssue) {
    repos["frostyard/problem-intake"] = {
      issues: [
        {
          number: 1,
          title: "Problem triage health",
          body: "Operational status of the problem-intake triage job.",
          author: "frostyard-machines",
          labels: ["problem-report"],
          state: "open",
          comments,
        },
      ],
    };
  }
  writeFileSync(ghStatePath, `${JSON.stringify({ calls: [], repos, labels: {}, now: "2026-11-21T00:00:00Z" }, null, 2)}\n`);
  if (heartbeat !== null) writeFileSync(join(stateDir, "heartbeat"), `${heartbeat}\n`);
  const env = {
    ...process.env,
    TRIAGE_TEST: "1",
    TRIAGE_STATE_DIR: stateDir,
    FAKE_GH_STATE: ghStatePath,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
  };
  return { dir, stateDir, ghStatePath, env };
}

function ghState(world) {
  return JSON.parse(readFileSync(world.ghStatePath, "utf8"));
}

// The time of a comment the fake `gh` writes.
function setNow(world, iso) {
  const state = ghState(world);
  state.now = iso;
  writeFileSync(world.ghStatePath, `${JSON.stringify(state, null, 2)}\n`);
}

function setHeartbeat(world, day) {
  writeFileSync(join(world.stateDir, "heartbeat"), `${day}\n`);
}

function comments(world) {
  return ghState(world).repos["frostyard/problem-intake"]?.issues?.[0]?.comments ?? [];
}

async function run(world, now = NOW) {
  return main({ now: new Date(now), env: world.env });
}

test("a missing heartbeat adds 1 comment to the health issue", async () => {
  const world = makeWorld();
  assert.equal(await run(world), 0);
  assert.equal(comments(world).length, 1);
  assert.equal(comments(world)[0].body, WATCHDOG_TEXT);
  assert.equal(comments(world)[0].author, "frostyard-machines");
});

test("a heartbeat of 3 days adds 1 comment", async () => {
  const world = makeWorld({ heartbeat: "2026-11-18" });
  assert.equal(await run(world), 0);
  assert.equal(comments(world).length, 1);
  assert.equal(comments(world)[0].body, WATCHDOG_TEXT);
});

test("a heartbeat of 2 days adds no comment", async () => {
  const world = makeWorld({ heartbeat: "2026-11-19" });
  assert.equal(await run(world), 0);
  assert.deepEqual(ghState(world).calls, []);
  assert.equal(comments(world).length, 0);
});

test("a heartbeat of today makes no gh call at all", async () => {
  const world = makeWorld({ heartbeat: TODAY });
  assert.equal(await run(world), 0);
  assert.deepEqual(ghState(world).calls, []);
  assert.equal(comments(world).length, 0);
});

test("a second run during the same outage adds no second comment", async () => {
  const world = makeWorld({ heartbeat: "2026-11-10" });
  assert.equal(await run(world), 0);
  assert.equal(comments(world).length, 1);
  assert.equal(await run(world), 0);
  assert.equal(comments(world).length, 1);
});

test("without a health issue the watchdog comments nowhere and exits 0", async () => {
  const world = makeWorld({ healthIssue: false, heartbeat: null });
  assert.equal(await run(world), 0);
  assert.equal(ghState(world).repos["frostyard/problem-intake"], undefined);
});

test("each outage gets 1 warning, and no warning is repeated", async () => {
  const world = makeWorld({ heartbeat: "2026-11-18" });

  // Outage 1: the last completed run was 3 days ago.
  assert.equal(await run(world, "2026-11-21T12:00:00Z"), 0);
  assert.equal(comments(world).length, 1);
  assert.equal(comments(world)[0].body, WATCHDOG_TEXT);

  // A second watchdog run in the same outage writes no second warning.
  setNow(world, "2026-11-21T18:00:00Z");
  assert.equal(await run(world, "2026-11-21T12:00:00Z"), 0);
  assert.equal(comments(world).length, 1);

  // The job runs again: a new heartbeat.
  setHeartbeat(world, "2026-11-22");
  setNow(world, "2026-11-26T12:00:00Z");

  // Outage 2 is a new outage, 4 days after that run.
  assert.equal(await run(world, "2026-11-26T12:00:00Z"), 0);
  assert.equal(comments(world).length, 2);
  assert.equal(comments(world)[1].body, WATCHDOG_TEXT);

  // And it is not repeated either.
  setNow(world, "2026-11-26T18:00:00Z");
  assert.equal(await run(world, "2026-11-26T12:00:00Z"), 0);
  assert.equal(comments(world).length, 2);
});
