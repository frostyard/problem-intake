// The schema copy, the generated validator and the version stay what they
// claim to be.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { buildEnvelope, buildEvent } from "../../src/envelope.ts";

const file = (path) => new URL(`../../${path}`, import.meta.url);
const sha256 = (path) => createHash("sha256").update(readFileSync(file(path))).digest("hex");

// schema/v1.json is a byte copy of frostyard/core
// docs/specs/schemas/problem-report/v1.json at core commit f1b62e0 (core#196).
// This pin is the same value that core's test/problem-report-schema.test.mjs
// pins (V1_SHA256). Never edit the copy: a new schema version is a new file.
const V1_SHA256 = "6c053ee3a9b4fd399d1d011b2be833dc6b17f25e727161fc576b0ce64cc14c3a";

test("schema/v1.json is the byte copy of core's v1.json", () => {
  assert.equal(sha256("schema/v1.json"), V1_SHA256);
});

test("the fixtures are core's examples, 1 for each kind, and valid", () => {
  const schema = JSON.parse(readFileSync(file("schema/v1.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const names = readdirSync(file("test/fixtures/examples")).sort();
  assert.deepEqual(
    names.map((n) => n.replace(/\.json$/, "")),
    [...schema.properties.kind.enum].sort(),
  );
  for (const name of names) {
    const doc = JSON.parse(readFileSync(file(`test/fixtures/examples/${name}`), "utf8"));
    assert.equal(validate(doc), true, name);
    assert.equal(doc.kind, name.replace(/\.json$/, ""));
  }
});

test("src/version.ts matches package.json", () => {
  const pkg = JSON.parse(readFileSync(file("package.json"), "utf8"));
  const source = readFileSync(file("src/version.ts"), "utf8");
  assert.match(source, new RegExp(`export const VERSION = "${pkg.version.replaceAll(".", "\\.")}";`));
});

test("Node can run the envelope builder that the GlitchTip CI job uses", () => {
  const doc = JSON.parse(readFileSync(file("test/fixtures/examples/crash.json"), "utf8"));
  const lines = buildEnvelope(doc).split("\n");
  assert.equal(lines.length, 4);
  const event = JSON.parse(lines[2]);
  assert.deepEqual(event, buildEvent(doc));
  assert.equal(event.tags.report_id, doc.report_id);
  assert.equal(event.event_id, doc.report_id.replaceAll("-", ""));
  assert.deepEqual(event.user, { ip_address: null });
});
