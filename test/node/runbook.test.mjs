// Guards the operator steps of docs/runbook/glitchtip.md that were wrong at
// the first GlitchTip install (2026-11-05, T857):
// - a health check to the published port without an allowed Host header
//   answers 400 (ALLOWED_HOSTS), not ok;
// - GlitchTip 6.2.6 has no "Scrub IP addresses" setting in its UI; the
//   project field scrub_ip_addresses (default True) is checked in the shell.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runbook = readFileSync(join(root, "docs/runbook/glitchtip.md"), "utf8");
// Markdown wraps long lines; join them so a command split over 2 lines counts.
const flat = runbook.replace(/\s*\n\s*/g, " ");

test("every health check to the published port sends an allowed Host header", () => {
  const checks = [...flat.matchAll(/curl [^`]*http:\/\/10\.0\.1\.100:30053\/_health\/[^`]*/g)].map((m) => m[0]);
  assert.ok(checks.length >= 3, `expected the install, secret and health-check steps, found ${checks.length}`);
  for (const check of checks) {
    assert.match(check, /-H 'Host: localhost'/, `no Host header: ${check}`);
  }
});

test("the runbook names no UI setting for IP scrubbing that GlitchTip 6.2.6 lacks", () => {
  assert.doesNotMatch(runbook, /turn on \*\*Scrub IP addresses\*\*/i);
});

test("the runbook checks scrub_ip_addresses of every project in the shell", () => {
  assert.match(flat, /values_list\('slug', 'scrub_ip_addresses'\)/);
  assert.match(flat, /filter\(scrub_ip_addresses=False\)\.update\(scrub_ip_addresses=True\)/);
});
