// Pins the GlitchTip Compose file (glitchtip/compose.yaml, docs/runbook/glitchtip.md).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseDocument } from "yaml";

const text = readFileSync(new URL("../../glitchtip/compose.yaml", import.meta.url), "utf8");
const doc = parseDocument(text, { merge: true, uniqueKeys: true });
const compose = doc.toJS({ maxAliasCount: 100 });
const services = compose.services;

test("compose.yaml parses with no YAML error", () => {
  assert.deepEqual(doc.errors.map(String), []);
  assert.deepEqual(Object.keys(services).sort(), ["migrate", "postgres", "valkey", "web", "worker"]);
});

test("event, transaction and file life are 80 days in every GlitchTip service", () => {
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
    ]) {
      assert.equal(env[key], "80", `${name} ${key}`);
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

test("secrets come only from the environment, with no default", () => {
  const env = services.web.environment;
  assert.equal(env.SECRET_KEY, "${SECRET_KEY:?set SECRET_KEY in the TrueNAS UI}");
  assert.equal(env.DATABASE_PASSWORD, "${POSTGRES_PASSWORD:?set the database password in the TrueNAS UI}");
  assert.equal(services.postgres.environment.POSTGRES_PASSWORD, env.DATABASE_PASSWORD);
  assert.equal(env.DATABASE_URL, undefined, "no URL that could carry a password");
  // Every value that names a secret is a ${NAME:?...} reference.
  const SECRET_NAME = /(^|_)(SECRET|PASSWORD|TOKEN|KEY|DSN)(_|$)/;
  for (const [name, service] of Object.entries(services)) {
    for (const [key, value] of Object.entries(service.environment ?? {})) {
      if (SECRET_NAME.test(key)) assert.match(String(value), /^\$\{[A-Z_]+:\?[^}]*\}$/, `${name} ${key}`);
    }
  }
  assert.doesNotMatch(text, /change_me|POSTGRES_HOST_AUTH_METHOD|trust/);
});

test("no setting makes GlitchTip trust a forwarding header or turns debug on", () => {
  assert.doesNotMatch(text, /USE_X_FORWARDED|SECURE_PROXY_SSL_HEADER|DEBUG|ENABLE_TEST_API|BOOTSTRAP_DEV/);
});

test(".env.example lists names only", () => {
  const example = readFileSync(new URL("../../glitchtip/.env.example", import.meta.url), "utf8");
  for (const line of example.split("\n")) {
    if (line.startsWith("#") || line.trim() === "") continue;
    assert.match(line, /^[A-Z_]+=$/, `a value in .env.example: ${line.split("=")[0]}`);
  }
});
