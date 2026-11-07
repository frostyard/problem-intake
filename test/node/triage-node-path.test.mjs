// Guards the rule of docs/runbook/triage.md, "Node in the triage clone": the
// triage clone on the team VM runs the job scripts with /usr/local/bin/node,
// as the fleet units do. A bare `node` there is the mise shim, which stops on
// the untrusted mise.toml. A cross-review of frostyard/problem-intake#15 found
// a bare `node scripts/triage/read.mjs --summary` left in docs/specs/triage.md.
// ADRs are records of a decision and keep their text, so they are not scanned.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

// The docs that give commands for the clone: AGENTS.md and every Markdown file
// of the design, runbook and specs folders, except the templates.
function scannedDocs(base = root) {
  const files = ["AGENTS.md"];
  for (const dir of ["docs/design", "docs/runbook", "docs/specs"]) {
    for (const name of readdirSync(join(base, dir)).sort()) {
      if (name.endsWith(".md") && name !== "TEMPLATE.md") files.push(`${dir}/${name}`);
    }
  }
  return files;
}

// The job scripts that run in the clone. seed-allow.mjs runs in a working
// checkout with a snosi checkout beside it, not in the clone.
const jobScript = /(\S*)node\s+scripts\/triage\/(read|publish|watchdog)\.mjs/g;

// Each call of a job script whose Node is not /usr/local/bin/node.
function bareCalls(text) {
  return [...text.matchAll(jobScript)]
    .filter((m) => !m[1].endsWith("/usr/local/bin/"))
    .map((m) => m[0]);
}

test("bareCalls finds a bare node and accepts the full path", () => {
  assert.deepEqual(bareCalls("run `node scripts/triage/read.mjs --summary`"), ["`node scripts/triage/read.mjs"]);
  assert.deepEqual(bareCalls("node\n  scripts/triage/watchdog.mjs"), ["node\n  scripts/triage/watchdog.mjs"]);
  assert.deepEqual(bareCalls("ExecStart=-/usr/local/bin/node scripts/triage/read.mjs"), []);
  assert.deepEqual(bareCalls("node scripts/triage/seed-allow.mjs --snosi x"), []);
});

test("every job script command in the docs calls /usr/local/bin/node", () => {
  const files = scannedDocs();
  assert.ok(files.length >= 6, `expected AGENTS.md and the docs, found ${files.length} files`);
  let calls = 0;
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    calls += [...text.matchAll(jobScript)].length;
    assert.deepEqual(bareCalls(text), [], `${file} calls a job script with a bare node`);
  }
  // The runbook, the design doc, the spec and AGENTS.md name the full path.
  assert.ok(calls >= 6, `expected at least 6 job script commands, found ${calls}`);
});
