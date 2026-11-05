// Pins the privacy and safety settings of wrangler.jsonc (ADR-0003).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse, printParseErrorCode } from "jsonc-parser";

const text = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const errors = [];
const config = parse(text, errors, { allowTrailingComma: false, disallowComments: false });

test("wrangler.jsonc parses", () => {
  assert.deepEqual(errors.map((e) => printParseErrorCode(e.error)), []);
  assert.equal(config.name, "problem-intake");
  assert.equal(config.main, "src/index.ts");
  assert.match(config.compatibility_date, /^20[2-9][0-9]-[01][0-9]-[0-3][0-9]$/);
});

test("observability, logs, traces and Logpush are off; no tail consumer", () => {
  assert.deepEqual(config.observability, {
    enabled: false,
    logs: { enabled: false, invocation_logs: false },
    traces: { enabled: false },
  });
  assert.equal(config.logpush, false);
  assert.equal(config.tail_consumers, undefined);
  assert.equal(config.streaming_tail_consumers, undefined);
  assert.equal(config.send_metrics, false);
  assert.equal(config.env, undefined, "no named environment can turn a setting back on");
});

test("only the custom domain serves the Worker", () => {
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, [{ pattern: "report.frostyard.org", custom_domain: true }]);
  assert.equal(config.route, undefined);
});

test("the bindings are exactly the documented set", () => {
  const names = [
    ...(config.ratelimits ?? []).map((b) => b.name),
    ...(config.analytics_engine_datasets ?? []).map((b) => b.binding),
    ...(config.kv_namespaces ?? []).map((b) => b.binding),
    ...Object.keys(config.vars ?? {}),
  ].sort();
  assert.deepEqual(names, ["HEALTH", "KILL_SWITCH", "REPORTS", "REPORT_LIMIT", "STATS"]);
  const binders = [
    "r2_buckets", "d1_databases", "durable_objects", "queues", "services", "hyperdrive", "vectorize",
    "ai", "browser", "send_email", "dispatch_namespaces", "mtls_certificates", "workflows", "secrets_store_secrets",
    "unsafe", "logfwdr", "pipelines", "assets", "containers", "version_metadata",
  ];
  for (const key of binders) assert.equal(config[key], undefined, `unexpected ${key}`);
  assert.deepEqual(config.ratelimits, [{ name: "REPORT_LIMIT", namespace_id: "8571", simple: { limit: 10, period: 60 } }]);
  assert.deepEqual(config.analytics_engine_datasets, [
    { binding: "REPORTS", dataset: "problem_reports" },
    { binding: "HEALTH", dataset: "problem_intake_health" },
  ]);
});

test("the kill switch defaults to off", () => {
  assert.deepEqual(config.vars, { KILL_SWITCH: "off" });
});

test("the crons are the hourly health job and the Monday aggregation", () => {
  assert.deepEqual(config.triggers, { crons: ["17 * * * *", "23 3 * * 1"] });
});

test("secrets are names only", () => {
  assert.deepEqual(config.secrets, { required: ["INTAKE_BEARER", "GLITCHTIP_DSNS", "AE_READ_TOKEN", "CF_ACCOUNT_ID"] });
  assert.equal(config.account_id, undefined, "the account id comes from the deploy environment");
});

test("no key or value looks like a secret value", () => {
  const SECRET_KEY = /(token|password|passwd|secret|bearer|api[_-]?key|private|dsn|credential)/i;
  const SECRET_VALUE = /(https?:\/\/[^@/\s]+@)|(^[0-9a-f]{32,}$)|(^[A-Za-z0-9_-]{40,}$)/;
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, i) => walk(item, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        // "secrets" holds the list of required names; it is checked above.
        if (path === "" && key === "secrets") continue;
        assert.doesNotMatch(key, SECRET_KEY, `key ${path}.${key}`);
        walk(item, `${path}.${key}`);
      }
    } else if (typeof value === "string") {
      assert.doesNotMatch(value, SECRET_VALUE, `value at ${path}`);
    }
  };
  walk(config, "");
});

test("the KV id is the placeholder until Brian's PR replaces it", () => {
  // The deploy workflow refuses this placeholder (.github/workflows/deploy.yml).
  const [kv] = config.kv_namespaces;
  assert.equal(kv.binding, "STATS");
  assert.ok(kv.id === "REPLACE_WITH_STATS_KV_NAMESPACE_ID" || /^[0-9a-f]{32}$/.test(kv.id), kv.id);
  const deploy = readFileSync(new URL("../../.github/workflows/deploy.yml", import.meta.url), "utf8");
  assert.ok(deploy.includes("REPLACE_WITH_STATS_KV_NAMESPACE_ID"), "the deploy workflow must check for the placeholder");
});
