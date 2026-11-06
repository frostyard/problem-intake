// The facts guard and the static rules of the triage scripts
// (docs/specs/triage.md, "The facts schema", "Rules"). assertFacts() is the
// gate between the reader and every later step: it refuses a forbidden key at
// any depth, an unknown key, a value outside its pattern, a field that is not
// public for its kind, and a problem on a failed run.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { FACTS_SCHEMA, HELD_REASONS, assertFacts, failedFacts } from "../../scripts/triage/lib/facts.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HELD = Object.fromEntries(HELD_REASONS.map((reason) => [reason, 0]));

const clone = (value) => JSON.parse(JSON.stringify(value));

function problem(overrides = {}) {
  return {
    key: "3f2a1b4c5d6e4f70",
    repo: "frostyard/chairlift",
    kind: "app_problem",
    class: "error",
    fields: {
      app_id: "org.frostyard.ChairLift",
      runtime: "go",
      component: "gui",
      code: "store.migrate_failed",
    },
    frames: [],
    location: null,
    observations: [
      { image: "snow", variant: "standard", version: "0.15.0", feature_version: null, last_seen_day: "2026-11-20" },
    ],
    coverage: "complete",
    first_seen_day: "2026-11-20",
    glitchtip_issue_ids: [7],
    ...overrides,
  };
}

function unitProblem(overrides = {}) {
  return problem({
    repo: "frostyard/snosi",
    kind: "unit_failed",
    class: "exit-code",
    fields: { unit: "snosi-health.service", result: "exit-code" },
    observations: [
      { image: "floe", variant: "standard", version: "20261031093822", feature_version: null, last_seen_day: "2026-11-20" },
    ],
    ...overrides,
  });
}

function sysextProblem(overrides = {}) {
  return problem({
    repo: "frostyard/snosi",
    kind: "sysext_update_failed",
    class: "failed",
    fields: { feature: "docker", outcome: "failed", error_class: "checksum", feature_version: "28.5.1" },
    observations: [
      { image: "floe", variant: "standard", version: "20261031093822", feature_version: "28.5.1", last_seen_day: "2026-11-20" },
    ],
    ...overrides,
  });
}

function facts(overrides = {}) {
  return {
    schema: FACTS_SCHEMA,
    run: { day: "2026-11-21", status: "ok", token_age_days: 15, notes: [] },
    problems: [problem()],
    watched: [{ key: "9c1d2e3f4a5b6c7d", coverage: "complete" }],
    held: { ...HELD },
    ...overrides,
  };
}

// The document of the spec, unchanged.
const SPEC_EXAMPLE = {
  schema: "frostyard.problem-triage-facts/1",
  run: { day: "2026-11-21", status: "ok", token_age_days: 15, notes: [] },
  problems: [
    {
      key: "3f2a1b4c5d6e4f70",
      repo: "frostyard/chairlift",
      kind: "app_problem",
      class: "error",
      fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui", code: "store.migrate_failed" },
      frames: [],
      location: null,
      observations: [
        { image: "snow", variant: "standard", version: "0.15.0", feature_version: null, last_seen_day: "2026-11-20" },
      ],
      coverage: "complete",
      first_seen_day: "2026-11-20",
      glitchtip_issue_ids: [7],
    },
  ],
  watched: [{ key: "9c1d2e3f4a5b6c7d", coverage: "complete" }],
  held: {
    before_cutoff: 0,
    unknown_route: 0,
    kind_not_filed: 0,
    noise: 0,
    unverified_version: 0,
    unverified_code: 0,
    not_allowlisted: 0,
    source_unavailable: 0,
    request_cap: 0,
  },
};

test("the spec example and failedFacts() are accepted", () => {
  assertFacts(SPEC_EXAMPLE);
  assertFacts(failedFacts({ day: "2026-11-21", status: "auth" }));
  assertFacts(failedFacts({ day: "2026-11-21", status: "config", tokenAgeDays: null, notes: ["token_created_unknown"], watchedKeys: ["3f2a1b4c5d6e4f70"] }));
  assertFacts(facts({ problems: [unitProblem()] }));
  assertFacts(facts({ problems: [sysextProblem()] }));
  assertFacts(
    facts({
      problems: [
        problem({
          kind: "tpm_unlock",
          class: "recovery_key",
          repo: "frostyard/snosi",
          fields: { outcome: "recovery_key", tpm_rc: "PCR_CHANGED", variant: "secure" },
          observations: [
            { image: "snow", variant: "secure", version: "20261031093822", feature_version: null, last_seen_day: "2026-11-20" },
          ],
        }),
        problem({
          kind: "integrity_error",
          class: "composefs",
          repo: "frostyard/snosi",
          fields: { subsystem: "composefs", variant: "standard" },
          key: "1111111111111111",
          observations: [
            { image: "floe", variant: "standard", version: "20261031093822", feature_version: null, last_seen_day: "2026-11-20" },
          ],
        }),
        problem({
          kind: "update_stage_failed",
          class: "registry",
          repo: "frostyard/snosi",
          fields: { error_class: "registry", target_version: "20261104081517" },
          key: "2222222222222222",
          observations: [
            { image: "snow", variant: "standard", version: "20261031093822", feature_version: null, last_seen_day: "2026-11-20" },
          ],
        }),
        problem({
          kind: "booted_older_image",
          class: "boot_menu",
          repo: "frostyard/snosi",
          fields: { how: "boot_menu", newer_version: "20261104081517" },
          key: "3333333333333333",
          observations: [
            { image: "snowfield", variant: "standard", version: "20261031093822", feature_version: null, last_seen_day: "2026-11-20" },
          ],
        }),
      ],
    }),
  );
});

test("a forbidden key is refused at every depth", () => {
  const places = {
    document: (doc, key) => {
      doc[key] = 1;
    },
    run: (doc, key) => {
      doc.run[key] = 1;
    },
    problem: (doc, key) => {
      doc.problems[0][key] = 1;
    },
    fields: (doc, key) => {
      doc.problems[0].fields[key] = "x";
    },
    observation: (doc, key) => {
      doc.problems[0].observations[0][key] = 1;
    },
    watched: (doc, key) => {
      doc.watched[0][key] = 1;
    },
    held: (doc, key) => {
      doc.held[key] = 1;
    },
  };
  for (const key of ["report_id", "event_id", "eventID", "week", "client", "count", "retries"]) {
    for (const [where, put] of Object.entries(places)) {
      const doc = clone(SPEC_EXAMPLE);
      put(doc, key);
      assert.throws(() => assertFacts(doc), /forbidden_key|unknown_key/, `${key} at ${where}`);
    }
  }
});

test("an unknown key is refused at every level", () => {
  const places = {
    document: (doc) => {
      doc.extra = 1;
    },
    run: (doc) => {
      doc.run.extra = 1;
    },
    problem: (doc) => {
      doc.problems[0].extra = 1;
    },
    fields: (doc) => {
      doc.problems[0].fields.extra = "x";
    },
    observation: (doc) => {
      doc.problems[0].observations[0].extra = 1;
    },
    watched: (doc) => {
      doc.watched[0].extra = 1;
    },
  };
  for (const [where, put] of Object.entries(places)) {
    const doc = clone(SPEC_EXAMPLE);
    put(doc);
    assert.throws(() => assertFacts(doc), /unknown_key|not_public/, where);
  }
});

test("a held value that is not a count is refused", () => {
  for (const value of [-1, 1.5, "1", null, true]) {
    const doc = facts();
    doc.held.noise = value;
    assert.throws(() => assertFacts(doc), /held_value/, String(value));
  }
  const unknown = facts();
  unknown.held.some_other_reason = 1;
  assert.throws(() => assertFacts(unknown), /unknown_key/);
  const missing = facts();
  delete missing.held.noise;
  assert.throws(() => assertFacts(missing), /missing_key/);
});

test("a field that is not public for its kind is refused", () => {
  const rows = [
    ["app_problem with bootc_version", facts({ problems: [problem({ fields: { ...problem().fields, bootc_version: "1.1.6" } })] })],
    ["app_problem with shipped", facts({ problems: [problem({ fields: { ...problem().fields, shipped: true } })] })],
    ["app_problem with app_version", facts({ problems: [problem({ fields: { ...problem().fields, app_version: "0.15.0" } })] })],
    ["app_problem with variant", facts({ problems: [problem({ fields: { ...problem().fields, variant: "secure" } })] })],
    ["unit_failed with variant", facts({ problems: [unitProblem({ fields: { unit: "snosi-health.service", result: "exit-code", variant: "secure" } })] })],
    ["unit_failed with code", facts({ problems: [unitProblem({ fields: { unit: "snosi-health.service", result: "exit-code", code: "x.y" } })] })],
    ["app_problem panic with code", facts({ problems: [problem({ class: "panic", fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui", code: "store.migrate_failed" } })] })],
    ["unit_failed with frames", facts({ problems: [unitProblem({ frames: ["other"] })] })],
    ["a go panic with a location", facts({ problems: [problem({ class: "panic", fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" }, location: "src/main.rs:3" })] })],
    [
      "a feature version on a unit_failed observation",
      facts({
        problems: [
          unitProblem({
            observations: [
              { image: "floe", variant: "standard", version: "20261031093822", feature_version: "28.5.1", last_seen_day: "2026-11-20" },
            ],
          }),
        ],
      }),
    ],
    ["a sysext field on an app", facts({ problems: [problem({ fields: { ...problem().fields, feature: "docker" } })] })],
    ["a missing required field", facts({ problems: [problem({ fields: { app_id: "org.frostyard.ChairLift", runtime: "go" } })] })],
  ];
  for (const [what, doc] of rows) {
    assert.throws(() => assertFacts(doc), /fields_|class_mismatch|frames_not_allowed|location_not_allowed|observation_feature_version/, what);
  }
});

test("a value outside its pattern is refused", () => {
  const rows = [
    ["key", () => facts({ problems: [problem({ key: "ABCDEF0123456789" })] }), /problem_key/],
    ["key length", () => facts({ problems: [problem({ key: "abcdef" })] }), /problem_key/],
    ["repo", () => facts({ problems: [problem({ repo: "bketelsen/x" })] }), /problem_repo/],
    ["kind", () => facts({ problems: [problem({ kind: "crash" })] }), /problem_kind/],
    ["class", () => facts({ problems: [problem({ class: "timeout" })] }), /problem_class/],
    ["day", () => facts({ run: { day: "2026-13-01", status: "ok", token_age_days: 1, notes: [] } }), /run_day/],
    ["status", () => facts({ run: { day: "2026-11-21", status: "good", token_age_days: 1, notes: [] } }), /run_status/],
    ["token age", () => facts({ run: { day: "2026-11-21", status: "ok", token_age_days: -1, notes: [] } }), /run_token_age_days/],
    ["note", () => facts({ run: { day: "2026-11-21", status: "ok", token_age_days: 1, notes: ["other"] } }), /run_notes/],
    ["duplicate note", () => facts({ run: { day: "2026-11-21", status: "ok", token_age_days: 1, notes: ["checkout_failed", "checkout_failed"] } }), /run_notes/],
    ["observation image", () => facts({ problems: [problem({ observations: [{ image: "moon", variant: "standard", version: "0.15.0", feature_version: null, last_seen_day: "2026-11-20" }] })] }), /observation_image/],
    ["observation variant", () => facts({ problems: [problem({ observations: [{ image: "snow", variant: "blue", version: "0.15.0", feature_version: null, last_seen_day: "2026-11-20" }] })] }), /observation_variant/],
    ["observation version", () => facts({ problems: [problem({ observations: [{ image: "snow", variant: "standard", version: "1.0", feature_version: null, last_seen_day: "2026-11-20" }] })] }), /observation_version/],
    ["image version of a system kind", () => facts({ problems: [unitProblem({ observations: [{ image: "floe", variant: "standard", version: "0.15.0", feature_version: null, last_seen_day: "2026-11-20" }] })] }), /observation_version/],
    ["observation day", () => facts({ problems: [problem({ observations: [{ image: "snow", variant: "standard", version: "0.15.0", feature_version: null, last_seen_day: "yesterday" }] })] }), /observation_day/],
    ["coverage", () => facts({ problems: [problem({ coverage: "unknown" })] }), /problem_coverage/],
    ["first seen day", () => facts({ problems: [problem({ first_seen_day: "2026-11-31" })] }), /problem_first_seen_day/],
    ["issue ids", () => facts({ problems: [problem({ glitchtip_issue_ids: [2, 1] })] }), /problem_issue_ids/],
    ["issue ids empty", () => facts({ problems: [problem({ glitchtip_issue_ids: [] })] }), /problem_issue_ids/],
    ["issue id 0", () => facts({ problems: [problem({ glitchtip_issue_ids: [0] })] }), /problem_issue_ids/],
    ["frames value", () => facts({ problems: [problem({ class: "panic", fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" }, frames: ["github.com/frostyard/chairlift/internal/load.Run.func1"] })] }), /frames_value/],
    ["frames of another module", () => facts({ problems: [problem({ class: "panic", fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" }, frames: ["github.com/frostyard/updex/v2/internal/index.Write"] })] }), /frames_value/],
    ["too many frames", () => facts({ problems: [problem({ class: "panic", fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" }, frames: Array.from({ length: 33 }, () => "runtime") })] }), /frames_too_many/],
    ["location", () => facts({ problems: [problem({ class: "panic", fields: { app_id: "org.frostyard.nsl", runtime: "rust", component: "daemon" }, location: "/etc/main.rs:3" })] }), /location_value/],
    ["watched key", () => facts({ watched: [{ key: "nope", coverage: "complete" }] }), /watched_key/],
    ["watched coverage", () => facts({ watched: [{ key: "9c1d2e3f4a5b6c7d", coverage: "unknown" }] }), /watched_coverage/],
    ["watched duplicate", () => facts({ watched: [{ key: "9c1d2e3f4a5b6c7d", coverage: "complete" }, { key: "9c1d2e3f4a5b6c7d", coverage: "complete" }] }), /watched_duplicate/],
    ["schema", () => facts({ schema: "frostyard.problem-triage-facts/2" }), /schema/],
    ["fields of a code that is empty", () => facts({ problems: [problem({ fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" } })] }), /fields_code/],
    ["code on a panic class", () => facts({ problems: [problem({ class: "error", fields: { app_id: "org.frostyard.ChairLift", runtime: "go", component: "gui" } })] }), /fields_code/],
    ["unit name", () => facts({ problems: [unitProblem({ fields: { unit: "not a unit", result: "exit-code" } })] }), /fields_value/],
    ["class of the kind field", () => facts({ problems: [unitProblem({ class: "timeout" })] }), /class_mismatch/],
    ["app id", () => facts({ problems: [problem({ fields: { ...problem().fields, app_id: "org.example.Other" } })] }), /fields_value/],
    ["no observations", () => facts({ problems: [problem({ observations: [] })] }), /observations/],
    ["duplicate observation", () => facts({ problems: [problem({ observations: [problem().observations[0], problem().observations[0]] })] }), /observation_duplicate/],
  ];
  for (const [what, make, pattern] of rows) {
    assert.throws(() => assertFacts(make()), pattern, what);
  }
});

test("a problem on a failed run is refused, and so is a duplicate key", () => {
  for (const status of ["config", "auth", "unreachable", "error"]) {
    const doc = facts({ run: { day: "2026-11-21", status, token_age_days: null, notes: [] } });
    assert.throws(() => assertFacts(doc), /problems_on_failed_run/, status);
  }
  const doc = facts({ problems: [problem(), problem()] });
  assert.throws(() => assertFacts(doc), /problem_duplicate/);
});

test("a document that is not an object is refused", () => {
  for (const value of [null, [], "facts", 1]) {
    assert.throws(() => assertFacts(value), /document_not_object/);
  }
});

// --- the static rules of the scripts ---------------------------------------

function scriptFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...scriptFiles(path));
    else if (name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

const TRIAGE = join(ROOT, "scripts", "triage");
const scripts = scriptFiles(TRIAGE).map((path) => ({ name: relative(ROOT, path), text: readFileSync(path, "utf8") }));

test("the triage scripts are found", () => {
  assert.ok(scripts.length >= 4, `found ${scripts.length} files`);
  assert.ok(scripts.some((one) => one.name === "scripts/triage/read.mjs"));
  assert.ok(scripts.some((one) => one.name === "scripts/triage/lib/glitchtip.mjs"));
});

test("every triage script imports only node: builtins and relative paths", () => {
  const specifiers = [];
  for (const { name, text } of scripts) {
    for (const match of text.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      specifiers.push({ name, specifier: match[1] });
    }
  }
  assert.ok(specifiers.length >= 10, `found ${specifiers.length} imports`);
  for (const { name, specifier } of specifiers) {
    assert.ok(
      specifier.startsWith("node:") || specifier.startsWith("./") || specifier.startsWith("../"),
      `${name} imports ${specifier}`,
    );
  }
});

test("the GlitchTip client names GET and no other HTTP method", () => {
  const client = scripts.find((one) => one.name === "scripts/triage/lib/glitchtip.mjs");
  assert.ok(client !== undefined);
  assert.match(client.text, /method: "GET"/);
  for (const verb of ["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"]) {
    assert.equal(new RegExp(`["'\`]${verb}["'\`]`).test(client.text), false, `${verb} appears in the client`);
  }
});
