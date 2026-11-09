// Repository gates: the risk-path list, the governance policy, the vendored
// copies from frostyard/core, the workflow pins, and the docs index.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRequiredPaths, matchGlob, parseStrictJson, validateRiskPaths } from "../../scripts/lib/risk-paths.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const sha256 = (path) => createHash("sha256").update(readFileSync(join(root, path))).digest("hex");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(join(root, dir))) {
    if (["node_modules", ".git", ".wrangler", "coverage"].includes(name)) continue;
    const path = dir === "" ? name : `${dir}/${name}`;
    const stat = lstatSync(join(root, path));
    if (stat.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}
const files = walk("");

test("the vendored files are byte copies of frostyard/core", () => {
  // Source: frostyard/core at c996ea3 (core#225).
  assert.equal(sha256("scripts/lib/risk-paths.mjs"), "6df0af009ff385467214f8df56aa5c5c92ac19ad26689b3344bb4d2654cdfa43");
  assert.equal(sha256("scripts/check-corrections.mjs"), "1894791a1945289c681a9f109d147e50dc342840bf9774b8349a5d63597725d6");
});

const list = parseStrictJson(read(".github/risk-paths.json"));
const policy = parseStrictJson(read("policies/agent-governance.json"));

test("the risk-path list is valid and has the required entries", () => {
  assert.deepEqual(validateRiskPaths(list), { ok: true, errors: [] });
  // The list is version 2, so the level check of rule C applies to it.
  assert.equal(list.schema_version, 2);
  const required = [".github/risk-paths.json", ".github/workflows/risk-paths-caller.yml"];
  // Rule C (core docs/specs/risk-paths.md): each required path matches a glob,
  // and in a version 2 list each such glob is L1 or L2.
  assert.deepEqual(checkRequiredPaths(list, required), []);
  // The same check rejects a list that grades the list itself at L3.
  const loosened = {
    ...list,
    paths: list.paths.map((entry) => (entry.glob === ".github/risk-paths.json" ? { ...entry, level: "L3" } : entry)),
  };
  assert.match(checkRequiredPaths(loosened, required).join("\n"), /must be L1 or L2/);
});

test("each risk path names 1 protected boundary of the policy, which lists the same glob", () => {
  const boundaries = new Map(policy.protected_boundaries.map((b) => [b.id, b]));
  for (const { glob, why } of list.paths) {
    const id = why.split(":")[0];
    assert.ok(boundaries.has(id), `${glob}: "${why}" names no boundary id`);
    assert.ok(boundaries.get(id).paths.includes(glob), `${glob} is not in boundary ${id}`);
  }
  for (const boundary of policy.protected_boundaries) {
    for (const glob of boundary.paths) {
      assert.ok(list.paths.some((p) => p.glob === glob), `${boundary.id} lists ${glob}, the risk list does not`);
    }
  }
});

test("every risk glob matches a file that exists", () => {
  for (const { glob } of list.paths) {
    assert.ok(files.some((f) => matchGlob(glob, f)), `${glob} matches no file`);
  }
});

test("the key files are risk paths", () => {
  for (const path of [
    "wrangler.jsonc",
    "glitchtip/compose.yaml",
    "src/forward.ts",
    ".github/workflows/deploy.yml",
    ".github/workflows/ci.yml",
    "Makefile",
    "scripts/check-corrections.mjs",
    "scripts/glitchtip-delete-report.sh",
    "scripts/glitchtip-cleanup-proof.sh",
  ]) {
    assert.ok(list.paths.some((p) => matchGlob(p.glob, path)), `${path} is not a risk path`);
  }
});

test("workflows: SHA pins, no top-level permissions, no persisted credentials", () => {
  const workflows = files.filter((f) => f.startsWith(".github/workflows/"));
  assert.ok(workflows.length >= 4);
  for (const path of workflows) {
    const text = read(path);
    assert.match(text, /^permissions: \{\}$/m, `${path}: top-level permissions must be {}`);
    for (const match of text.matchAll(/uses:\s*([^\s#]+)(.*)$/gm)) {
      const [, ref, rest] = match;
      if (ref.startsWith("./")) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${path}: ${ref} is not pinned by full SHA`);
      if (ref.includes("/.github/workflows/")) {
        // A reusable workflow of core: core has no release tags, so the comment names the branch and the commit date.
        assert.match(rest, /# frostyard\/core main, \d{4}-\d{2}-\d{2}\b/, `${path}: ${ref} has no # frostyard/core main, YYYY-MM-DD`);
      } else {
        assert.match(rest, /# v\d+\.\d+\.\d+/, `${path}: ${ref} has no # vX.Y.Z`);
      }
    }
    if (text.includes("actions/checkout@")) assert.match(text, /persist-credentials: false/, `${path}: checkout persists credentials`);
    if (text.includes("runs-on:")) assert.match(text, /timeout-minutes: \d+/, `${path}: no timeout`);
  }
  assert.doesNotMatch(read(".github/workflows/risk-paths-caller.yml"), /^\s+merge_group:/m);
  assert.match(read(".github/workflows/ci.yml"), /^ {2}ci:$/m, "the required job is named ci");
});

test("the canonical instruction file has its aliases", () => {
  assert.ok(lstatSync(join(root, "AGENTS.md")).isFile(), "AGENTS.md is not a regular file");
  assert.ok(!lstatSync(join(root, "AGENTS.md")).isSymbolicLink(), "AGENTS.md is a symlink");
  for (const alias of [".cursorrules", "CLAUDE.md", "GEMINI.md"]) {
    assert.ok(lstatSync(join(root, alias)).isSymbolicLink(), `${alias} is not a symlink`);
    assert.equal(readlinkSync(join(root, alias)), "AGENTS.md");
  }
  const copilot = join(root, ".github/copilot-instructions.md");
  assert.ok(lstatSync(copilot).isSymbolicLink(), ".github/copilot-instructions.md is not a symlink");
  assert.equal(readlinkSync(copilot), "../AGENTS.md");
});

test("every doc is in the docs index, and every index link exists", () => {
  const index = read("docs/README.md");
  const docs = files.filter((f) => f.startsWith("docs/") && f.endsWith(".md") && f !== "docs/README.md" && !f.endsWith("TEMPLATE.md"));
  assert.ok(docs.length >= 8);
  for (const doc of docs) {
    const link = relative("docs", doc);
    assert.ok(index.includes(`](${link})`), `${doc} is not in docs/README.md`);
  }
  for (const [, target] of index.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) {
    if (/^[a-z]+:/.test(target)) continue;
    assert.ok(existsSync(join(root, "docs", target)), `docs/README.md links to a missing ${target}`);
  }
});

test("relative links in docs and the README resolve", () => {
  // Symlinked aliases of AGENTS.md resolve links from the root file.
  const docs = files.filter(
    (f) => f.endsWith(".md") && !f.endsWith("TEMPLATE.md") && !lstatSync(join(root, f)).isSymbolicLink(),
  );
  for (const doc of docs) {
    const dir = doc.includes("/") ? doc.slice(0, doc.lastIndexOf("/")) : "";
    for (const [, target] of read(doc).matchAll(/\]\(([^)#\s]+)(#[^)]*)?\)/g)) {
      if (/^[a-z]+:/.test(target)) continue;
      assert.ok(existsSync(join(root, dir, target)), `${doc} links to a missing ${target}`);
    }
  }
});
