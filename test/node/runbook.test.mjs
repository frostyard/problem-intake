// Guards the operator steps of docs/runbook/glitchtip.md that were wrong at
// the first GlitchTip install (2026-11-05, T857):
// - a health check to the published port without an allowed Host header
//   answers 400 (ALLOWED_HOSTS), not ok;
// - GlitchTip 6.2.6 has no "Scrub IP addresses" setting in its UI; the
//   project field scrub_ip_addresses (default True) is checked in the shell.
// And the host steps of docs/runbook/deploy.md that were missing at the
// Worker go-live (2026-11-05, T885, deploy run 42097263781):
// - the first deploy failed with code 10089 until Workers Analytics Engine
//   was enabled on the account (bindings REPORTS and HEALTH), and the
//   enablement took a few minutes to apply (20:01Z failed, 20:04Z passed);
// - "No access to the specified service" means the deploy token's Account
//   Resources lack the account of CLOUDFLARE_ACCOUNT_ID.
// And the update step of docs/runbook/glitchtip.md that broke the snapshot
// bound (2026-11-13): a Run Now of the snapshot task makes a snapshot that
// retention never prunes, so an update uses the scheduled 00:00 snapshot.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const runbook = readFileSync(join(root, "docs/runbook/glitchtip.md"), "utf8");
// Markdown wraps long lines; join them so a command split over 2 lines counts.
const flat = runbook.replace(/\s*\n\s*/g, " ");
const deploy = readFileSync(join(root, "docs/runbook/deploy.md"), "utf8").replace(/\s*\n\s*/g, " ");

// The text of 1 "## " section of the flattened GlitchTip runbook.
function glitchtipSection(heading) {
  const start = flat.indexOf(`## ${heading} `);
  assert.ok(start >= 0, `no section "## ${heading}" in docs/runbook/glitchtip.md`);
  const end = flat.indexOf("## ", start + 3);
  return end < 0 ? flat.slice(start) : flat.slice(start, end);
}

// The text of 1 "## " section of the flattened deploy runbook.
function deploySection(heading) {
  const start = deploy.indexOf(`## ${heading} `);
  assert.ok(start >= 0, `no section "## ${heading}" in docs/runbook/deploy.md`);
  const end = deploy.indexOf("## ", start + 3);
  return end < 0 ? deploy.slice(start) : deploy.slice(start, end);
}

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

test("the deploy runbook enables Analytics Engine in the Cloudflare step, before the first deploy", () => {
  const cloudflare = deploySection("2. Cloudflare");
  assert.match(cloudflare, /Enable Workers Analytics Engine on the account/);
  assert.match(cloudflare, /Storage & Databases → Analytics Engine/);
  assert.match(cloudflare, /`REPORTS` and `HEALTH`/);
  assert.ok(deploy.indexOf("Enable Workers Analytics Engine") < deploy.indexOf("## 5. First deploy"));
});

test("the deploy runbook explains the deploy errors of the go-live", () => {
  const trouble = deploySection("Troubleshooting the deploy");
  assert.match(trouble, /No access to the specified service/);
  assert.match(trouble, /Account Resources must include the account of `CLOUDFLARE_ACCOUNT_ID`, with Workers Scripts Edit/);
  assert.match(trouble, /10089/);
  assert.match(trouble, /wait about 5 minutes, then re-run the failed job/);
});

test("the GlitchTip runbook never tells the operator to Run Now the snapshot task", () => {
  // Every sentence that names Run Now forbids it or says why it is forbidden.
  const mentions = [...flat.matchAll(/[^.]*\bRun Now\b[^.]*/g)].map((m) => m[0]);
  assert.ok(mentions.length >= 3, `the install, retention and update text must forbid Run Now, found ${mentions.length}`);
  for (const mention of mentions) {
    assert.match(mention, /\bNever use \*\*Run Now\*\*|\bnever prunes a Run Now\b|\bor Run Now snapshot is never pruned\b/, `not a prohibition: ${mention}`);
  }
});

test("a GlitchTip update uses the scheduled 00:00 snapshot as its pre-update snapshot", () => {
  assert.match(glitchtipSection("Install"), /daily at 00:00, keep 7 days/);
  const updates = glitchtipSection("Updates (plan ask T857g)");
  assert.match(updates, /Wait for the daily 00:00 run of the snapshot task, and apply the update soon after it/);
  assert.match(updates, /That 00:00 snapshot is the pre-update snapshot/);
  assert.doesNotMatch(updates, /Run the snapshot task by hand/);
});
