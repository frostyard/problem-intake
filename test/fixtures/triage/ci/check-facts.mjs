#!/usr/bin/env node
// CI only (.github/workflows/glitchtip.yml): check the facts.json that the
// reader wrote against the test GlitchTip. The 2 expected problem keys come
// from the 2 report fixtures of this folder through the reader's own key
// function, so a changed fixture cannot leave a stale key here.
//
// Usage: CI_REPORT_IDS="<id> ..." node test/fixtures/triage/ci/check-facts.mjs <facts.json>
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FACTS_SCHEMA, HELD_REASONS, assertFacts } from "../../../../scripts/triage/lib/facts.mjs";
import { problemKey } from "../../../../scripts/triage/lib/report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const path = process.argv[2];
if (path === undefined || path === "") {
  process.stderr.write("Usage: CI_REPORT_IDS=\"<id> ...\" node check-facts.mjs <facts.json>\n");
  process.exit(2);
}

function fail(message) {
  process.stderr.write(`check-facts: ${message}\n`);
  process.exit(1);
}

const facts = JSON.parse(readFileSync(path, "utf8"));
try {
  assertFacts(facts);
} catch (error) {
  fail(`facts.json is not valid: ${error.code ?? error.name}`);
}

if (facts.run.status !== "ok") fail(`run.status is ${facts.run.status}, want ok`);

const unit = JSON.parse(readFileSync(join(HERE, "unit_failed.json"), "utf8"));
const app = JSON.parse(readFileSync(join(HERE, "app_problem.json"), "utf8"));
const expected = [problemKey(unit, "snosi"), problemKey(app, "chairlift")].sort();
const keys = facts.problems.map((problem) => problem.key).sort();
if (JSON.stringify(keys) !== JSON.stringify(expected)) fail(`problems are ${keys.join(",")}, want ${expected.join(",")}`);

const want = { not_allowlisted: 1, noise: 1, unverified_version: 1 };
for (const reason of HELD_REASONS) {
  const value = facts.held[reason];
  const target = want[reason] ?? 0;
  if (value !== target) fail(`held.${reason} is ${value}, want ${target}`);
}

if ((statSync(path).mode & 0o777) !== 0o600) fail("facts.json is not mode 0600");
const healthPath = join(dirname(path), "health.json");
if ((statSync(healthPath).mode & 0o777) !== 0o600) fail("health.json is not mode 0600");

// No report id of a sent report may reach a state file, in either form.
const ids = (process.env.CI_REPORT_IDS ?? "").split(/\s+/).filter((id) => id !== "");
if (ids.length === 0) fail("CI_REPORT_IDS is empty: the check cannot fail");
for (const file of [path, healthPath]) {
  const text = readFileSync(file, "utf8");
  for (const id of ids) {
    for (const form of [id, id.replaceAll("-", "")]) {
      if (text.includes(form)) fail(`${file} holds a sent report id`);
    }
  }
}

if (facts.schema !== FACTS_SCHEMA) fail("unreachable");
process.stdout.write("check-facts: ok\n");
