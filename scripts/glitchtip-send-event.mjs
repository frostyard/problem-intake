#!/usr/bin/env node
// CI only (.github/workflows/glitchtip.yml): send 1 event to a test GlitchTip
// in the Worker's own envelope format. It imports the Worker's envelope
// builder (src/envelope.ts; Node 24 strips the types), so the job tests the
// format that production sends.
//
// Usage: node scripts/glitchtip-send-event.mjs <report_id>
// Environment: CI_DSN, the test project's DSN. The Worker accepts only https
// DSNs; this test sender also accepts http on 127.0.0.1 or localhost.
import { readFileSync } from "node:fs";
import { buildEnvelope, SENTRY_CLIENT } from "../src/envelope.ts";

const reportId = process.argv[2] ?? "";
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(reportId)) {
  process.stderr.write("Usage: node scripts/glitchtip-send-event.mjs <report_id (lowercase UUIDv4)>\n");
  process.exit(2);
}

const dsn = new URL(process.env.CI_DSN ?? "");
const local = dsn.protocol === "http:" && ["127.0.0.1", "localhost"].includes(dsn.hostname);
if (dsn.protocol !== "https:" && !local) {
  process.stderr.write("CI_DSN must be https, or http on 127.0.0.1 or localhost\n");
  process.exit(2);
}
const project = /^\/([0-9]+)$/.exec(dsn.pathname)?.[1];
if (!project || !dsn.username) {
  process.stderr.write("CI_DSN is not a DSN\n");
  process.exit(2);
}

const report = JSON.parse(readFileSync(new URL("../test/fixtures/examples/unit_failed.json", import.meta.url), "utf8"));
report.report_id = reportId;

// The test GlitchTip listens on 127.0.0.1:8000, whatever host the DSN names.
const url = `http://127.0.0.1:8000/api/${project}/envelope/`;
const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/x-sentry-envelope",
    "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.username}, sentry_client=${SENTRY_CLIENT}`,
  },
  body: buildEnvelope(report),
});
process.stdout.write(`envelope answer: ${response.status}\n`);
if (!response.ok) process.exit(1);
