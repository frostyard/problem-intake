#!/usr/bin/env node
// Builds a TRIAGE_SOURCES folder for the reader tests (docs/specs/triage.md,
// "Configuration"): a bare git repository for each fixture repository under
// repos/<owner>__<repo>/, 1 tag for each tree in it, and a copy of the
// registry/ and index/ fixtures. The trees stay in this repository as plain
// files; the bare repositories are never committed.
//
// Usage: node test/fixtures/triage/build-sources.mjs <out-dir>
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOS = join(HERE, "repos");

// The 2 identities and the fixed dates of the fixture commits: a test must not
// depend on the wall clock, and git refuses a commit with no author.
const GIT_IDENTITY = ["-c", "user.name=fixture", "-c", "user.email=fixture@test.invalid"];
const COMMIT_DATES = [
  "2026-11-01T00:00:00+0000",
  "2026-11-02T00:00:00+0000",
  "2026-11-03T00:00:00+0000",
  "2026-11-04T00:00:00+0000",
];

function git(dir, args, env = {}) {
  return execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
  });
}

// Removes everything in `dir` except its `.git` folder, so the next tag starts
// from its own tree only.
function clearTree(dir) {
  for (const name of readdirSync(dir)) {
    if (name === ".git") continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
}

function buildRepo(name, bareDir) {
  const source = join(REPOS, name);
  const tags = readdirSync(source)
    .filter((entry) => statSync(join(source, entry)).isDirectory())
    .sort();
  const work = mkdtempSync(join(tmpdir(), "triage-fixture-"));
  try {
    git(work, ["init", "-q", "-b", "main"]);
    let step = 0;
    for (const tag of tags) {
      clearTree(work);
      cpSync(join(source, tag), work, { recursive: true });
      const date = COMMIT_DATES[step % COMMIT_DATES.length];
      git(work, ["add", "-A"]);
      git(work, [...GIT_IDENTITY, "commit", "-q", "-m", tag], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
      git(work, ["tag", tag]);
      step += 1;
    }
    rmSync(bareDir, { recursive: true, force: true });
    git(tmpdir(), ["clone", "-q", "--bare", work, bareDir]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// Builds the whole fixture folder. An existing `outDir` is filled, not
// emptied: a caller that needs a clean folder makes a new one.
export function buildSources(outDir) {
  mkdirSync(join(outDir, "git"), { recursive: true, mode: 0o700 });
  for (const name of readdirSync(REPOS).sort()) {
    if (!statSync(join(REPOS, name)).isDirectory()) continue;
    buildRepo(name, join(outDir, "git", name));
  }
  for (const folder of ["registry", "index"]) {
    mkdirSync(join(outDir, folder), { recursive: true, mode: 0o700 });
    cpSync(join(HERE, folder), join(outDir, folder), { recursive: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = process.argv[2];
  if (out === undefined || out === "") {
    process.stderr.write("Usage: node test/fixtures/triage/build-sources.mjs <out-dir>\n");
    process.exit(2);
  }
  buildSources(out);
}
