// The facts guard of the triage job (docs/specs/triage.md, "The facts schema
// frostyard.problem-triage-facts/1"). assertFacts() checks the whole document
// before the reader writes it and before the publisher uses it: only the keys
// of the spec, each value against its pattern, the public fields of each kind,
// and no forbidden key at any depth. A failure throws FactsError with a fixed
// reason code; the message never holds a value of the document.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { isPublishedFrame, repoName } from "./frames.mjs";

export const FACTS_SCHEMA = "frostyard.problem-triage-facts/1";

export const RUN_STATUSES = Object.freeze(["ok", "partial", "config", "auth", "unreachable", "error"]);
export const RUN_NOTES = Object.freeze(["checkout_failed", "token_created_unknown"]);

// The 9 held reasons, in the order of the spec.
export const HELD_REASONS = Object.freeze([
  "before_cutoff",
  "unknown_route",
  "kind_not_filed",
  "noise",
  "unverified_version",
  "unverified_code",
  "not_allowlisted",
  "source_unavailable",
  "request_cap",
]);

// Key names that never appear in facts.json, at any depth.
export const FORBIDDEN_KEYS = Object.freeze(["report_id", "event_id", "eventID", "week", "client", "count", "retries"]);

export class FactsError extends Error {
  constructor(code) {
    super(`facts: ${code}`);
    this.name = "FactsError";
    this.code = code;
  }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[0-9a-f]{16}$/;
const REPO = /^frostyard\/[a-z0-9-]+$/;
const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-(alpha|beta|rc)\.(0|[1-9][0-9]{0,3}))?$/;
const IMAGE_VERSION = /^[0-9]{14}$/;
const SYSEXT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+~_-]{0,63}$/;
const UNIT = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,95}@?\.(service|socket|timer|mount|automount|swap|path|target|slice|scope)$/;
const FEATURE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const LOCATION = /^src\/([a-z0-9_]+\/){0,8}[a-z0-9_]+\.rs:[1-9][0-9]{0,5}$/;

const IMAGES = ["snow", "snowfield", "sundog", "floe"];
const VARIANTS = ["standard", "secure"];
const APP_IDS = [
  "org.frostyard.ChairLift",
  "org.frostyard.nsl",
  "org.frostyard.intuneme",
  "org.frostyard.pilothouse",
  "org.frostyard.Frostmail",
  "org.frostyard.Frostnotes",
  "org.frostyard.Frostread",
];

const oneOf = (values) => (v) => typeof v === "string" && values.includes(v);
const matches = (re) => (v) => typeof v === "string" && v.length <= 200 && re.test(v);

// The public fields of each kind in `fields` (docs/specs/triage.md, "Public
// fields"), without frames, location, the app version and the image versions.
// `class` names the field whose value is the problem class (src/dimensions.ts
// CLASS_FIELD); app_problem keeps its class in `class` only.
const KINDS = {
  app_problem: {
    classes: ["panic", "error"],
    classField: null,
    required: {
      app_id: oneOf(APP_IDS),
      runtime: oneOf(["go", "rust"]),
      component: oneOf(["daemon", "cli", "gui", "shell", "other"]),
    },
    optional: { code: matches(CODE) },
  },
  unit_failed: {
    classes: ["exit-code", "signal", "timeout", "core-dump", "start-limit-hit", "other"],
    classField: "result",
    required: { unit: matches(UNIT), result: oneOf(["exit-code", "signal", "timeout", "core-dump", "start-limit-hit", "other"]) },
    optional: {},
  },
  update_stage_failed: {
    classes: ["network", "registry", "signature", "disk_space", "lock", "other"],
    classField: "error_class",
    required: {
      error_class: oneOf(["network", "registry", "signature", "disk_space", "lock", "other"]),
      target_version: matches(IMAGE_VERSION),
    },
    optional: {},
  },
  booted_older_image: {
    classes: ["manual_rollback", "boot_menu", "unknown", "other"],
    classField: "how",
    required: { how: oneOf(["manual_rollback", "boot_menu", "unknown", "other"]), newer_version: matches(IMAGE_VERSION) },
    optional: {},
  },
  sysext_update_failed: {
    classes: ["failed", "held_by_rollback", "needs_image", "skipped_unreachable", "skipped_busy", "other"],
    classField: "outcome",
    required: {
      feature: matches(FEATURE),
      outcome: oneOf(["failed", "held_by_rollback", "needs_image", "skipped_unreachable", "skipped_busy", "other"]),
    },
    optional: {
      error_class: oneOf(["network", "http_status", "signature", "checksum", "disk_space", "link", "config", "other"]),
      feature_version: matches(SYSEXT_VERSION),
    },
  },
  tpm_unlock: {
    classes: ["ok_after_retry", "recovery_key", "passphrase", "other"],
    classField: "outcome",
    required: {
      outcome: oneOf(["ok_after_retry", "recovery_key", "passphrase", "other"]),
      tpm_rc: oneOf(["PCR_CHANGED", "POLICY_FAIL", "LOCKOUT", "other"]),
      variant: oneOf(VARIANTS),
    },
    optional: {},
  },
  integrity_error: {
    classes: ["composefs", "fs-verity", "dm-verity", "other"],
    classField: "subsystem",
    required: { subsystem: oneOf(["composefs", "fs-verity", "dm-verity", "other"]), variant: oneOf(VARIANTS) },
    optional: {},
  },
};

export const FILED_KINDS = Object.freeze(Object.keys(KINDS));

function fail(code) {
  throw new FactsError(code);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function exactKeys(obj, keys, where) {
  if (!isObject(obj)) fail(`${where}_not_object`);
  const have = Object.keys(obj);
  for (const k of have) if (!keys.includes(k)) fail(`${where}_unknown_key`);
  for (const k of keys) if (!Object.hasOwn(obj, k)) fail(`${where}_missing_key`);
}

function scanForbidden(value) {
  if (Array.isArray(value)) {
    for (const item of value) scanForbidden(item);
  } else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.includes(k)) fail("forbidden_key");
      scanForbidden(v);
    }
  }
}

function checkDay(v, code) {
  if (typeof v !== "string" || !DAY.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) fail(code);
  if (new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) fail(code);
}

function checkRun(run) {
  exactKeys(run, ["day", "status", "token_age_days", "notes"], "run");
  checkDay(run.day, "run_day");
  if (!RUN_STATUSES.includes(run.status)) fail("run_status");
  const age = run.token_age_days;
  if (age !== null && !(Number.isSafeInteger(age) && age >= 0)) fail("run_token_age_days");
  if (!Array.isArray(run.notes)) fail("run_notes");
  for (const note of run.notes) if (!RUN_NOTES.includes(note)) fail("run_notes");
  if (new Set(run.notes).size !== run.notes.length) fail("run_notes");
}

function checkFields(problem, spec) {
  const fields = problem.fields;
  if (!isObject(fields)) fail("fields_not_object");
  for (const k of Object.keys(fields)) {
    if (!Object.hasOwn(spec.required, k) && !Object.hasOwn(spec.optional, k)) fail("fields_not_public");
  }
  for (const [k, check] of Object.entries(spec.required)) {
    if (!Object.hasOwn(fields, k)) fail("fields_missing");
    if (!check(fields[k])) fail("fields_value");
  }
  for (const [k, check] of Object.entries(spec.optional)) {
    if (Object.hasOwn(fields, k) && !check(fields[k])) fail("fields_value");
  }
  if (spec.classField !== null && fields[spec.classField] !== problem.class) fail("class_mismatch");
  if (problem.kind === "app_problem") {
    // `code` only for class error, and always there.
    if ((problem.class === "error") !== Object.hasOwn(fields, "code")) fail("fields_code");
  }
}

function checkObservation(obs, kind) {
  exactKeys(obs, ["image", "variant", "version", "feature_version", "last_seen_day"], "observation");
  if (!IMAGES.includes(obs.image)) fail("observation_image");
  if (!VARIANTS.includes(obs.variant)) fail("observation_variant");
  const version = kind === "app_problem" ? SEMVER : IMAGE_VERSION;
  if (typeof obs.version !== "string" || !version.test(obs.version)) fail("observation_version");
  if (obs.feature_version !== null) {
    if (kind !== "sysext_update_failed") fail("observation_feature_version");
    if (!matches(SYSEXT_VERSION)(obs.feature_version)) fail("observation_feature_version");
  }
  checkDay(obs.last_seen_day, "observation_day");
}

function checkProblem(problem) {
  exactKeys(
    problem,
    ["key", "repo", "kind", "class", "fields", "frames", "location", "observations", "coverage", "first_seen_day", "glitchtip_issue_ids"],
    "problem",
  );
  if (typeof problem.key !== "string" || !KEY.test(problem.key)) fail("problem_key");
  if (typeof problem.repo !== "string" || !REPO.test(problem.repo)) fail("problem_repo");
  const spec = KINDS[problem.kind];
  if (spec === undefined || !Object.hasOwn(KINDS, problem.kind)) fail("problem_kind");
  if (!spec.classes.includes(problem.class)) fail("problem_class");
  checkFields(problem, spec);

  // Frames: only a Go panic of an app has them, at most 32, each a published form.
  if (!Array.isArray(problem.frames)) fail("frames_not_array");
  if (problem.frames.length > 32) fail("frames_too_many");
  if (problem.frames.length > 0) {
    if (problem.kind !== "app_problem" || problem.class !== "panic" || problem.fields.runtime !== "go") fail("frames_not_allowed");
    const name = repoName(problem.repo);
    for (const frame of problem.frames) if (!isPublishedFrame(frame, name)) fail("frames_value");
  }

  // Location: only a Rust panic of an app has it.
  if (problem.location !== null) {
    if (problem.kind !== "app_problem" || problem.class !== "panic" || problem.fields.runtime !== "rust") fail("location_not_allowed");
    if (!matches(LOCATION)(problem.location)) fail("location_value");
  }

  if (!Array.isArray(problem.observations) || problem.observations.length === 0) fail("observations");
  const seen = new Set();
  for (const obs of problem.observations) {
    checkObservation(obs, problem.kind);
    const id = JSON.stringify([obs.image, obs.variant, obs.version, obs.feature_version]);
    if (seen.has(id)) fail("observation_duplicate");
    seen.add(id);
  }
  if (problem.coverage !== "complete" && problem.coverage !== "partial") fail("problem_coverage");
  checkDay(problem.first_seen_day, "problem_first_seen_day");
  const ids = problem.glitchtip_issue_ids;
  if (!Array.isArray(ids) || ids.length === 0) fail("problem_issue_ids");
  for (let i = 0; i < ids.length; i += 1) {
    if (!Number.isSafeInteger(ids[i]) || ids[i] < 1) fail("problem_issue_ids");
    if (i > 0 && ids[i] <= ids[i - 1]) fail("problem_issue_ids");
  }
}

// Checks a whole facts document. Returns nothing; throws FactsError.
export function assertFacts(doc) {
  if (!isObject(doc)) fail("document_not_object");
  scanForbidden(doc);
  exactKeys(doc, ["schema", "run", "problems", "watched", "held"], "document");
  if (doc.schema !== FACTS_SCHEMA) fail("schema");
  checkRun(doc.run);

  if (!Array.isArray(doc.problems)) fail("problems_not_array");
  if (doc.run.status !== "ok" && doc.run.status !== "partial" && doc.problems.length > 0) fail("problems_on_failed_run");
  const keys = new Set();
  for (const problem of doc.problems) {
    checkProblem(problem);
    if (keys.has(problem.key)) fail("problem_duplicate");
    keys.add(problem.key);
  }

  if (!Array.isArray(doc.watched)) fail("watched_not_array");
  const watched = new Set();
  for (const entry of doc.watched) {
    exactKeys(entry, ["key", "coverage"], "watched");
    if (typeof entry.key !== "string" || !KEY.test(entry.key)) fail("watched_key");
    if (entry.coverage !== "complete" && entry.coverage !== "partial") fail("watched_coverage");
    if (watched.has(entry.key)) fail("watched_duplicate");
    watched.add(entry.key);
  }

  exactKeys(doc.held, HELD_REASONS, "held");
  for (const reason of HELD_REASONS) {
    const n = doc.held[reason];
    if (!Number.isSafeInteger(n) || n < 0) fail("held_value");
  }
}

// A valid document for a run that failed: its status, no problems, every
// held count 0, and 1 `partial` watched entry for each watched key given.
export function failedFacts({ day, status, tokenAgeDays = null, notes = [], watchedKeys = [] }) {
  return {
    schema: FACTS_SCHEMA,
    run: { day, status, token_age_days: tokenAgeDays, notes: [...new Set(notes)] },
    problems: [],
    watched: [...new Set(watchedKeys)].sort().map((key) => ({ key, coverage: "partial" })),
    held: Object.fromEntries(HELD_REASONS.map((reason) => [reason, 0])),
  };
}
