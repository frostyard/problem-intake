// Pins the GlitchTip Compose file (glitchtip/compose.yaml, docs/runbook/glitchtip.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";

const text = readFileSync(new URL("../../glitchtip/compose.yaml", import.meta.url), "utf8");
const doc = parseDocument(text, { merge: true, uniqueKeys: true });
const compose = doc.toJS({ maxAliasCount: 100 });
const services = compose.services;

// The env file on the NAS (runbook "Install") and the names it holds.
const ENV_FILE = "/mnt/fast/glitchtip/secrets/glitchtip.env";
const ENV_FILE_NAMES = [
  "SECRET_KEY",
  "POSTGRES_PASSWORD",
  "DATABASE_PASSWORD",
  "GLITCHTIP_DOMAIN",
  "ALLOWED_HOSTS",
  "DEFAULT_FROM_EMAIL",
];
const ENV_FILE_SERVICES = ["postgres", "migrate", "web", "worker"];
const SECRET_NAME = /(^|_)(SECRET|PASSWORD|TOKEN|KEY|DSN)(_|$)/;

test("compose.yaml parses with no YAML error", () => {
  assert.deepEqual(doc.errors.map(String), []);
  assert.deepEqual(Object.keys(services).sort(), ["migrate", "postgres", "valkey", "web", "worker"]);
});

test("every retention value is 72 days in every GlitchTip service", () => {
  for (const name of ["web", "worker", "migrate"]) {
    const env = services[name].environment;
    for (const key of [
      "GLITCHTIP_MAX_EVENT_LIFE_DAYS",
      "GLITCHTIP_MAX_TRANSACTION_EVENT_LIFE_DAYS",
      "GLITCHTIP_MAX_FILE_LIFE_DAYS",
      "GLITCHTIP_RETENTION_DAYS",
      "GLITCHTIP_EVENT_RETENTION_DAYS",
      "GLITCHTIP_TRANSACTION_RETENTION_DAYS",
      "GLITCHTIP_FILE_RETENTION_DAYS",
      "GLITCHTIP_LOG_RETENTION_DAYS",
      "GLITCHTIP_UPTIME_RETENTION_DAYS",
    ]) {
      assert.equal(env[key], "72", `${name} ${key}`);
    }
    // No other retention or life setting, at any value.
    for (const key of Object.keys(env)) {
      if (/RETENTION|LIFE_DAYS/.test(key)) assert.equal(env[key], "72", `${name} ${key}`);
    }
  }
});

test("open sign-up and organization creation are off", () => {
  for (const name of ["web", "worker", "migrate"]) {
    const env = services[name].environment;
    assert.equal(env.ENABLE_USER_REGISTRATION, "false");
    assert.equal(env.ENABLE_SOCIAL_APPS_USER_REGISTRATION, "false");
    assert.equal(env.ENABLE_OPEN_USER_REGISTRATION, "false");
    assert.equal(env.ENABLE_ORGANIZATION_CREATION, "false");
  }
});

test("only web publishes a port, on 10.0.1.100", () => {
  for (const [name, service] of Object.entries(services)) {
    if (name === "web") continue;
    assert.equal(service.ports, undefined, `${name} publishes a port`);
    assert.equal(service.network_mode, undefined, `${name} sets network_mode`);
  }
  assert.deepEqual(services.web.ports, ["10.0.1.100:30053:8000"]);
  assert.doesNotMatch(text, /0\.0\.0\.0/);
});

test("data lives under /mnt/fast/glitchtip, and valkey has no volume", () => {
  assert.deepEqual(services.postgres.volumes, ["/mnt/fast/glitchtip/postgres:/var/lib/postgresql"]);
  assert.deepEqual(services.web.volumes, ["/mnt/fast/glitchtip/uploads:/code/uploads"]);
  assert.deepEqual(services.worker.volumes, ["/mnt/fast/glitchtip/uploads:/code/uploads"]);
  assert.equal(services.valkey.volumes, undefined);
  assert.equal(compose.volumes, undefined, "no named volumes");
});

test("every image is pinned by tag and digest", () => {
  for (const [name, service] of Object.entries(services)) {
    assert.match(service.image, /^[a-z0-9./-]+:[0-9][0-9A-Za-z.-]*@sha256:[0-9a-f]{64}$/, `${name}: ${service.image}`);
  }
  const glitchtip = new Set(["web", "worker", "migrate"].map((n) => services[n].image));
  assert.equal(glitchtip.size, 1, "web, worker and migrate run the same image");
});

test("web, postgres and valkey have healthchecks; web checks /_health/", () => {
  for (const name of ["web", "postgres", "valkey"]) {
    assert.ok(Array.isArray(services[name].healthcheck?.test), `${name} has no healthcheck`);
  }
  assert.ok(services.web.healthcheck.test.join(" ").includes("http://localhost:8000/_health/"));
});

test("every service has a mem_limit", () => {
  for (const [name, service] of Object.entries(services)) {
    assert.match(String(service.mem_limit ?? ""), /^[0-9]+[mg]$/, `${name} has no mem_limit`);
  }
});

test("migrate is a one-shot that web and worker wait for", () => {
  assert.equal(services.migrate.restart, "no");
  for (const name of ["web", "worker"]) {
    assert.deepEqual(services[name].depends_on.migrate, { condition: "service_completed_successfully" });
  }
  assert.deepEqual(services.worker.command, ["./bin/run-worker.sh"]);
});

test("the file has no variable reference: it deploys as it is", () => {
  assert.doesNotMatch(text, /\$\{/);
  assert.doesNotMatch(text, /change_me|POSTGRES_HOST_AUTH_METHOD|trust/);
});

test("postgres, migrate, web and worker read the env file on the NAS; valkey reads none", () => {
  for (const name of ENV_FILE_SERVICES) {
    assert.deepEqual(services[name].env_file, [ENV_FILE], `${name} env_file`);
  }
  assert.equal(services.valkey.env_file, undefined, "valkey reads an env file");
});

test("no environment key holds a secret or hides an env-file value", () => {
  // A key in environment wins over env_file: it would hide the env file's value.
  for (const [name, service] of Object.entries(services)) {
    const env = service.environment ?? {};
    assert.ok(!Array.isArray(env), `${name}: environment is a list`);
    for (const key of Object.keys(env)) {
      assert.doesNotMatch(key, SECRET_NAME, `${name} sets the secret ${key}`);
      assert.ok(!ENV_FILE_NAMES.includes(key), `${name} sets ${key}, which hides the env file`);
    }
    assert.equal(env.DATABASE_URL, undefined, "no URL that could carry a password");
  }
});

test("no setting makes GlitchTip trust a forwarding header or turns debug on", () => {
  assert.doesNotMatch(text, /USE_X_FORWARDED|SECURE_PROXY_SSL_HEADER|DEBUG|ENABLE_TEST_API|BOOTSTRAP_DEV/);
});

test(".env.example lists exactly the 6 env-file names, with no value", () => {
  const example = readFileSync(new URL("../../glitchtip/.env.example", import.meta.url), "utf8");
  const names = [];
  for (const line of example.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    assert.match(line, /^[A-Z_]+=$/, `a value in .env.example: ${line.split("=")[0]}`);
    names.push(line.slice(0, -1));
  }
  assert.deepEqual(names.sort(), [...ENV_FILE_NAMES].sort());
});

test("compose.ci.yaml overrides the env file of the same 4 services", () => {
  const ci = parseDocument(readFileSync(new URL("../../glitchtip/compose.ci.yaml", import.meta.url), "utf8"), {
    uniqueKeys: true,
    customTags: [{ tag: "!override", resolve: (value) => value, collection: "seq" }],
  });
  assert.deepEqual(ci.errors.map(String), []);
  const ciServices = ci.toJS().services;
  for (const name of ENV_FILE_SERVICES) {
    const node = ci.getIn(["services", name, "env_file"], true);
    assert.equal(node?.tag, "!override", `${name}: env_file is not !override`);
    assert.deepEqual(ciServices[name].env_file, ["${CI_DATA:?}/glitchtip.env"], `${name} env_file`);
  }
  assert.equal(ciServices.valkey, undefined, "compose.ci.yaml changes valkey");
});
