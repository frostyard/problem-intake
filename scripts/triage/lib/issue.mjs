// The issue guard of the triage job (docs/specs/triage.md, "Public fields" and
// "The GitHub issue"): the public fields of each kind in their printed order,
// the check of every value against the schema, the title and the body, and the
// parser the publisher uses to read the key of a body it wrote.
//
// assertIssueBody() builds a body only from the public table: it refuses a
// field that is not public for its kind, a day, a number that is not a version,
// a frame that is not a published form, and a bad key or issue id.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isPublishedFrame, repoName } from "./frames.mjs";

const SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../../../schema/v1.json", import.meta.url)), "utf8"));
const ROUTES = JSON.parse(readFileSync(fileURLToPath(new URL("../../../triage/routes.json", import.meta.url)), "utf8"));
const DEFS = SCHEMA.$defs;

export const FOOTER =
  "Opened by the problem-intake triage job from opt-in problem reports. Every value was checked against this repository's public source and release tags. Name this issue in the fix PR (`Fixes #N`). What this issue holds and never holds: https://frostyard.org/privacy/problem-reports/#public-bug-reports";

// The public fields of each kind, in the order of the spec table. The app
// problem shows `code` (class error), or `frames` or `location` (class panic),
// after its 3 fixed fields.
export const PUBLIC_FIELDS = Object.freeze({
  app_problem: Object.freeze(["app_id", "runtime", "component", "code", "frames", "location"]),
  unit_failed: Object.freeze(["unit", "result"]),
  update_stage_failed: Object.freeze(["error_class", "target_version"]),
  booted_older_image: Object.freeze(["how", "newer_version"]),
  sysext_update_failed: Object.freeze(["feature", "outcome", "error_class", "feature_version"]),
  tpm_unlock: Object.freeze(["outcome", "tpm_rc", "variant"]),
  integrity_error: Object.freeze(["subsystem", "variant"]),
});

export class IssueError extends Error {
  constructor(code) {
    super(`issue: ${code}`);
    this.name = "IssueError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new IssueError(code);
};

const KEY = /^[0-9a-f]{16}$/;
const DAY = /\d{4}-\d{2}-\d{2}/;
const BARE_NUMBER = /^[0-9]+$/;
const IMAGE_ID = SCHEMA.properties.image.properties.id.enum;
const VARIANTS = Object.freeze(["standard", "secure"]);

// The value check of each public field, from the schema. `version` marks the
// fields that hold a version: a digit run is allowed there.
const VALUE = Object.freeze({
  app_id: { enum: DEFS.app_problem.properties.app_id.enum },
  runtime: { enum: DEFS.app_problem.properties.runtime.enum },
  component: { enum: DEFS.app_problem.properties.component.enum },
  code: { pattern: DEFS.app_problem.properties.code.pattern },
  location: { pattern: DEFS.app_problem.properties.location.pattern },
  unit: { pattern: DEFS.unit_failed.properties.unit.pattern },
  result: { enum: DEFS.unit_failed.properties.result.enum },
  how: { enum: DEFS.booted_older_image.properties.how.enum },
  newer_version: { pattern: DEFS.image_version.pattern, version: true },
  feature: { pattern: DEFS.sysext_update_failed.properties.feature.pattern },
  feature_version: { pattern: DEFS.sysext_update_failed.properties.version.pattern, version: true },
  tpm_rc: { enum: DEFS.tpm_unlock.properties.tpm_rc.enum },
  subsystem: { enum: DEFS.integrity_error.properties.subsystem.enum },
  variant: { enum: VARIANTS },
});

// `error_class`, `target_version` and `outcome` differ between kinds, so they
// are resolved per kind below.
export const KIND_SPECS = Object.freeze({
  app_problem: {
    required: ["app_id", "runtime", "component"],
    optional: ["code"],
    classes: DEFS.app_problem.properties.class.enum,
    classField: null,
    values: { app_id: VALUE.app_id, runtime: VALUE.runtime, component: VALUE.component, code: VALUE.code },
  },
  unit_failed: {
    required: ["unit", "result"],
    optional: [],
    classes: DEFS.unit_failed.properties.result.enum,
    classField: "result",
    values: { unit: VALUE.unit, result: VALUE.result },
  },
  update_stage_failed: {
    required: ["error_class", "target_version"],
    optional: [],
    classes: DEFS.update_stage_failed.properties.error_class.enum,
    classField: "error_class",
    values: {
      error_class: { enum: DEFS.update_stage_failed.properties.error_class.enum },
      target_version: { pattern: DEFS.image_version.pattern, version: true },
    },
  },
  booted_older_image: {
    required: ["how", "newer_version"],
    optional: [],
    classes: DEFS.booted_older_image.properties.how.enum,
    classField: "how",
    values: { how: VALUE.how, newer_version: VALUE.newer_version },
  },
  sysext_update_failed: {
    required: ["feature", "outcome"],
    optional: ["error_class", "feature_version"],
    classes: DEFS.sysext_update_failed.properties.outcome.enum,
    classField: "outcome",
    values: {
      feature: VALUE.feature,
      outcome: { enum: DEFS.sysext_update_failed.properties.outcome.enum },
      error_class: { enum: DEFS.sysext_update_failed.properties.error_class.enum },
      feature_version: VALUE.feature_version,
    },
  },
  tpm_unlock: {
    required: ["outcome", "tpm_rc", "variant"],
    optional: [],
    classes: DEFS.tpm_unlock.properties.outcome.enum,
    classField: "outcome",
    values: {
      outcome: { enum: DEFS.tpm_unlock.properties.outcome.enum },
      tpm_rc: VALUE.tpm_rc,
      variant: VALUE.variant,
    },
  },
  integrity_error: {
    required: ["subsystem", "variant"],
    optional: [],
    classes: DEFS.integrity_error.properties.subsystem.enum,
    classField: "subsystem",
    values: { subsystem: VALUE.subsystem, variant: VALUE.variant },
  },
});

function checkValue(name, value, spec) {
  if (typeof value !== "string" || value.length === 0) fail(`value:${name}`);
  if (DAY.test(value)) fail(`day:${name}`);
  if (spec.version !== true && BARE_NUMBER.test(value)) fail(`number:${name}`);
  if (spec.enum !== undefined) {
    if (!spec.enum.includes(value)) fail(`enum:${name}`);
    return;
  }
  if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) fail(`pattern:${name}`);
}

// The short key of the title, from the public fields.
export function shortKey(kind, fields) {
  if (kind === "app_problem") return fields.code === undefined ? fields.app_id : `${fields.app_id} ${fields.code}`;
  if (kind === "unit_failed") return fields.unit;
  if (kind === "sysext_update_failed") return fields.feature;
  if (kind === "tpm_unlock") return fields.tpm_rc;
  return null;
}

// The routed repository of an app problem, from triage/routes.json.
export function routeOf(kind, fields) {
  if (kind === "app_problem") return ROUTES.app_problem[fields.app_id] ?? null;
  return ROUTES.kinds[kind] ?? null;
}

// Checks 1 problem against the public table and returns { title, body }.
// `issue` is { kind, class, fields, frames, location, version, images, key,
// glitchtipIds }; `version` is the app version of an app problem, `images` the
// [{ id, version }] list of every other kind.
export function assertIssueBody(issue) {
  const { kind, key, glitchtipIds } = issue ?? {};
  const spec = KIND_SPECS[kind];
  if (spec === undefined || !Object.hasOwn(KIND_SPECS, kind)) fail("kind");
  const cls = issue.class;
  if (typeof cls !== "string" || !spec.classes.includes(cls)) fail("class");
  const fields = issue.fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) fail("fields");

  // Only the public fields of the kind, and every required 1.
  const allowed = [...spec.required, ...spec.optional];
  for (const name of Object.keys(fields)) if (!allowed.includes(name)) fail(`field_not_public:${name}`);
  for (const name of spec.required) if (!Object.hasOwn(fields, name)) fail(`field_missing:${name}`);
  for (const [name, value] of Object.entries(fields)) checkValue(name, value, spec.values[name]);
  if (spec.classField !== null && fields[spec.classField] !== cls) fail("class_field");

  const frames = issue.frames ?? [];
  const location = issue.location ?? null;
  if (!Array.isArray(frames)) fail("frames");
  if (kind !== "app_problem") {
    if (frames.length > 0) fail("frames_not_public");
    if (location !== null) fail("location_not_public");
  } else {
    const name = repoName(routeOf(kind, fields) ?? "");
    if (cls === "error") {
      if (fields.code === undefined) fail("code_missing");
      if (frames.length > 0 || location !== null) fail("frames_not_public");
    } else {
      if (fields.code !== undefined) fail("field_not_public:code");
      const go = fields.runtime === "go";
      if (go && location !== null) fail("location_not_public");
      if (!go && frames.length > 0) fail("frames_not_public");
      if (go && frames.length === 0) fail("frames_missing");
      if (!go && location === null) fail("location_missing");
    }
    if (frames.length > 32) fail("frames_too_many");
    for (const frame of frames) if (!isPublishedFrame(frame, name)) fail("frame_not_published");
    if (location !== null) checkValue("location", location, VALUE.location);
  }

  // The version: the app version, or 1 image line for each image.
  const version = issue.version ?? null;
  const images = issue.images ?? [];
  if (!Array.isArray(images)) fail("images");
  if (kind === "app_problem") {
    if (version === null) fail("version_missing");
    checkValue("version", version, { pattern: DEFS.semver.pattern, version: true });
    if (images.length > 0) fail("images_not_public");
  } else {
    if (version !== null) fail("version_not_public");
    if (images.length === 0) fail("images_missing");
    for (const image of images) {
      if (image === null || typeof image !== "object") fail("image");
      if (!IMAGE_ID.includes(image.id)) fail("image_id");
      checkValue("image_version", image.version, { pattern: DEFS.image_version.pattern, version: true });
    }
  }

  if (typeof key !== "string" || !KEY.test(key)) fail("key");
  if (!Array.isArray(glitchtipIds) || glitchtipIds.length === 0) fail("glitchtip_ids");
  for (const id of glitchtipIds) {
    if (!Number.isSafeInteger(id) || id <= 0) fail("glitchtip_ids");
  }
  if (new Set(glitchtipIds).size !== glitchtipIds.length) fail("glitchtip_ids");

  const suffix = shortKey(kind, fields);
  const title = `Problem report: ${kind} ${cls}${suffix === null ? "" : ` ${suffix}`}`;
  return { title, body: buildBody({ kind, class: cls, fields, frames, location, version, images, key, glitchtipIds }) };
}

function buildBody({ kind, class: cls, fields, frames, location, version, images, key, glitchtipIds }) {
  const lines = ["```", `kind: ${kind}`, `class: ${cls}`];
  for (const name of PUBLIC_FIELDS[kind]) {
    if (name === "frames") {
      if (frames.length > 0) lines.push(`frames: ${frames.join(", ")}`);
      continue;
    }
    if (name === "location") {
      if (location !== null) lines.push(`location: ${location}`);
      continue;
    }
    if (Object.hasOwn(fields, name)) lines.push(`${name}: ${fields[name]}`);
  }
  if (kind === "app_problem") {
    lines.push(`version: ${version}`);
  } else {
    for (const image of images) lines.push(`image: ${image.id} ${image.version}`);
  }
  lines.push("```", "", `Problem key: ${key}`, `GlitchTip issue: ${glitchtipIds.join(", ")}`, "", FOOTER);
  return lines.join("\n");
}

function parseBlock(lines) {
  const out = { fields: {}, frames: [], images: [], version: null, kind: null, class: null };
  for (const line of lines) {
    const match = /^(kind|class|[a-z_]+): (.*)$/.exec(line);
    if (match === null) return null;
    const [, name, value] = match;
    if (name === "kind") out.kind = value;
    else if (name === "class") out.class = value;
    else if (name === "frames") {
      out.frames = value === "" ? [] : value.split(", ");
    } else if (name === "location") {
      out.location = value;
    } else if (name === "version") {
      out.version = value;
    } else if (name === "image") {
      const image = /^([a-z][a-z0-9-]*) ([0-9]{14})$/.exec(value);
      if (image === null) return null;
      out.images.push({ id: image[1], version: image[2] });
    } else {
      out.fields[name] = value;
    }
  }
  return out;
}

// Parses a body that this job wrote. Returns { key, kind, class, fields,
// frames, location, images, version } or null.
export function parseIssueBody(body) {
  if (typeof body !== "string") return null;
  const lines = body.split("\n");
  const start = lines.indexOf("```");
  if (start < 0) return null;
  const end = lines.indexOf("```", start + 1);
  if (end < 0) return null;
  const block = parseBlock(lines.slice(start + 1, end));
  if (block === null || block.kind === null || block.class === null) return null;
  const rest = lines.slice(end + 1);
  const keyLine = rest.find((line) => line.startsWith("Problem key: "));
  if (keyLine === undefined) return null;
  const key = keyLine.slice("Problem key: ".length).trim();
  if (!KEY.test(key)) return null;
  return {
    key,
    kind: block.kind,
    class: block.class,
    fields: block.fields,
    frames: block.frames,
    location: block.location ?? null,
    images: block.images,
    version: block.version,
  };
}

// The issue-body body of the health issue and the step comments hold no day
// and no count: this refuses a day, and a digit run that is not inside a
// version or a fix boundary. With `noDigits`, it refuses any digit at all.
export function assertPublicText(text, { noDigits = false } = {}) {
  if (typeof text !== "string") fail("text");
  if (DAY.test(text)) fail("text_day");
  if (noDigits) {
    if (/[0-9]/.test(text)) fail("text_digit");
    return text;
  }
  const stripped = text
    .replace(/\bapp:(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-(?:alpha|beta|rc)\.[0-9]{1,4})?/g, " ")
    .replace(/\bimage:[a-z][a-z0-9-]*:[0-9]{14}\b/g, " ")
    .replace(/\bfeature:[a-z0-9][a-z0-9._-]*:[0-9A-Za-z][0-9A-Za-z.+~_-]*/g, " ")
    .replace(/\b(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-(?:alpha|beta|rc)\.[0-9]{1,4})?\b/g, " ")
    .replace(/\b[0-9]{14}\b/g, " ");
  if (/[0-9]/.test(stripped)) fail("text_number");
  return text;
}
