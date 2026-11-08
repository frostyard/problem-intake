#!/usr/bin/env node
// Seeds the triage allowlists from a snosi git checkout
// (docs/specs/triage.md, "Allowlists"). The reader refuses a unit or a
// feature that is not in these lists, so the lists hold the names that snosi
// ships at 1 commit, and nothing that came from a report.
//
// Usage:
//   node scripts/triage/seed-allow.mjs --snosi <path> --commit <40-hex> [--out <dir>]
//
// It reads the tree with `git ls-tree -r` and writes `units.txt` and
// `features.txt` into <dir> (default: triage/allow of this repository). Each
// file starts with 1 seed line that names the commit.
//
// node: builtins only: the team VM runs this with no `npm` and no packages.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The systemd unit name pattern of schema/v1.json ($defs.unit_failed.unit).
const UNIT = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}@?\.(service|socket|timer|mount|automount|swap|path|target|slice|scope)$/;
// The sysext feature name pattern of schema/v1.json ($defs.sysext_update_failed.feature).
const FEATURE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMIT = /^[0-9a-f]{40}$/;

// The unit roots. Only the entries directly under the last folder count, so a
// `*.wants/` alias and a `*.d/` drop-in are never a unit of their own.
const UNIT_ROOTS = [
  { pattern: /^mkosi\.images\/[^/]+\/mkosi\.extra\/usr\/lib\/systemd\/(?:system|user)\/([^/]+)$/, shared: false },
  { pattern: /^shared\/([^/]+)\/tree\/usr\/lib\/systemd\/(?:system|user)\/([^/]+)$/, shared: true },
];
// The installer ISO sends no report.
const UNIT_ROOT_SKIP = new Set(["firn-installer"]);
const FEATURE_ROOT = /^mkosi\.images\/[^/]+\/mkosi\.extra\/usr\/lib\/sysupdate\.[^/]+\.d\/([^/]+)\.feature$/;

const DEFAULT_OUT = fileURLToPath(new URL("../../triage/allow", import.meta.url));

function fail(message) {
  process.stderr.write(`seed-allow: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { snosi: null, commit: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (name !== "--snosi" && name !== "--commit" && name !== "--out") fail(`unknown argument ${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(`${name} needs a value`);
    args[name.slice(2)] = value;
    i += 1;
  }
  if (args.snosi === null) fail("--snosi <path to a snosi git checkout> is required");
  if (args.commit === null) fail("--commit <40-hex commit> is required");
  if (!COMMIT.test(args.commit)) fail("--commit is not 40 lowercase hex characters");
  return args;
}

// 1 entry for each line of `git ls-tree -r <commit>`: mode, blob and path.
function readTree(args) {
  let out;
  try {
    out = execFileSync("git", ["-C", args.snosi, "ls-tree", "-r", args.commit], { encoding: "utf8" });
  } catch {
    process.stderr.write("seed-allow: git ls-tree failed for that checkout and commit\n");
    process.exit(3);
  }
  const entries = [];
  for (const line of out.split("\n")) {
    if (line === "") continue;
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , blob] = line.slice(0, tab).split(" ");
    entries.push({ mode, blob, path: line.slice(tab + 1) });
  }
  return entries;
}

// The target of a symlink entry (mode 120000).
function linkTarget(args, blob) {
  try {
    return execFileSync("git", ["-C", args.snosi, "cat-file", "-p", blob], { encoding: "utf8" }).trim();
  } catch {
    process.stderr.write("seed-allow: git cat-file failed for 1 symlink entry\n");
    process.exit(3);
  }
}

function unitName(args, entry) {
  for (const root of UNIT_ROOTS) {
    const match = root.pattern.exec(entry.path);
    if (match === null) continue;
    if (root.shared && UNIT_ROOT_SKIP.has(match[1])) return null;
    const name = match[match.length - 1];
    // A symlink to /dev/null masks the unit of that name; it is no unit of ours.
    if (entry.mode === "120000" && linkTarget(args, entry.blob) === "/dev/null") return null;
    return UNIT.test(name) ? name : null;
  }
  return null;
}

function featureName(entry) {
  const match = FEATURE_ROOT.exec(entry.path);
  if (match === null) return null;
  return FEATURE.test(match[1]) ? match[1] : null;
}

function names(entries, pick) {
  const set = new Set();
  for (const entry of entries) {
    const name = pick(entry);
    if (name !== null) set.add(name);
  }
  // The default sort of strings, so a rerun gives the same bytes.
  return [...set].sort();
}

function writeList(path, commit, list) {
  const header = `# Seed: frostyard/snosi ${commit}, scripts/triage/seed-allow.mjs. A new entry is a PR, never a value from a report.`;
  writeFileSync(path, `${header}\n${list.map((name) => `${name}\n`).join("")}`, { mode: 0o644 });
}

const args = parseArgs(process.argv.slice(2));
const entries = readTree(args);
const units = names(entries, (entry) => unitName(args, entry));
const features = names(entries, featureName);

mkdirSync(args.out, { recursive: true });
writeList(join(args.out, "units.txt"), args.commit, units);
writeList(join(args.out, "features.txt"), args.commit, features);

process.stdout.write(`seed-allow: frostyard/snosi ${args.commit}\n`);
process.stdout.write(`seed-allow: units ${units.length}\n`);
process.stdout.write(`seed-allow: features ${features.length}\n`);
process.stdout.write(`seed-allow: wrote ${join(args.out, "units.txt")} and ${join(args.out, "features.txt")}\n`);
