// The report of 1 GlitchTip event, the problem key and the checks that need no
// source (docs/specs/triage.md, "Problem key and published forms", "Routing",
// "Noise"). The Worker's own modules are imported, so the fingerprint of the
// Worker and the key of the job cannot differ.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { createHash } from "node:crypto";
import { classOf } from "../../../src/dimensions.ts";
import { groupKey } from "../../../src/envelope.ts";
import { validate } from "../../../src/generated/validate-v1.js";
import { keyForm } from "./frames.mjs";

// The only report_id the reader ever builds: a fixed value for the schema
// validator, because an event's event id is the report_id of the report and
// no event id may be written anywhere (rules 3 and 6).
export const PLACEHOLDER_REPORT_ID = "00000000-0000-4000-8000-000000000000";

function tagMap(event) {
  const map = new Map();
  if (event === null || typeof event !== "object" || !Array.isArray(event.tags)) return map;
  for (const tag of event.tags) {
    if (tag === null || typeof tag !== "object") continue;
    if (typeof tag.key !== "string") continue;
    map.set(tag.key, typeof tag.value === "string" ? tag.value : null);
  }
  return map;
}

// The report of 1 event, rebuilt from its tags and its `context.detail` (the
// event's `extra`), or null when the values do not make a valid report.
export function rebuildReport(event) {
  if (event === null || typeof event !== "object") return null;
  const context = event.context;
  const detail = context !== null && typeof context === "object" ? context.detail : null;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return null;
  const tags = tagMap(event);
  const secure = tags.get("secure");
  const report = {
    schema: "frostyard.problem/1",
    report_id: PLACEHOLDER_REPORT_ID,
    week: tags.get("week"),
    image: { id: tags.get("image"), version: tags.get("image_version") },
    secure: secure === "true" ? true : secure === "false" ? false : null,
    client: tags.get("client"),
    kind: tags.get("kind"),
    detail: { ...detail },
  };
  try {
    if (validate(report) !== true) return null;
  } catch {
    return null;
  }
  return report;
}

// The raw GlitchTip fingerprint of a report: [kind, class, ...groupKey]. It
// stays internal; only its published forms go out.
export function rawFingerprint(report) {
  return [report.kind, classOf(report), ...groupKey(report)];
}

// The published group key: every value of the group key in its published form
// (docs/specs/triage.md, "Published forms of a frame"). A frame of the routed
// module becomes its parent frame, so a closure suffix never enters the key.
export function publishedGroupKey(report, routedName) {
  const group = groupKey(report);
  const frames = report.detail === undefined ? undefined : report.detail.frames;
  const isFrames = report.kind === "app_problem" && typeof report.detail?.code !== "string" && Array.isArray(frames);
  return group.map((value, index) => {
    if (index === 0 || !isFrames) return value;
    // A frame that fits no rule is `unverified`: the observation that holds it
    // is dropped, and the issue still has a stable key.
    return keyForm(value, routedName ?? "") ?? "unverified";
  });
}

// The problem key: the first 16 lowercase hex characters of the SHA-256 of
// [kind, class, ...publishedGroupKey] as JSON, with no spaces.
export function problemKey(report, routedName) {
  const parts = [report.kind, classOf(report), ...publishedGroupKey(report, routedName)];
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex").slice(0, 16);
}

// The route of 1 report (docs/specs/triage.md, "Routing"): { repo }, or
// { held } with `kind_not_filed` or `unknown_route`.
export function route(report, routes) {
  const notFiled = Array.isArray(routes.not_filed) ? routes.not_filed : [];
  if (notFiled.includes(report.kind)) return { held: "kind_not_filed" };
  if (report.kind === "app_problem") {
    const appId = report.detail.app_id;
    const repo = Object.hasOwn(routes.app_problem ?? {}, appId) ? routes.app_problem[appId] : undefined;
    return repo === undefined ? { held: "unknown_route" } : { repo };
  }
  const repo = Object.hasOwn(routes.kinds ?? {}, report.kind) ? routes.kinds[report.kind] : undefined;
  return repo === undefined ? { held: "unknown_route" } : { repo };
}

const NOISE_ERROR_CLASSES = ["network", "disk_space"];
const NOISE_HOWS = ["manual_rollback", "boot_menu"];

// True when the class of the report is a fault of the host's environment, not
// of our code (docs/specs/triage.md, "Noise"). It is 1 answer for 1 event: a
// sysext outcome other than `failed` is noise, and so is a network or disk
// space error of that kind.
export function isNoise(report) {
  const detail = report.detail ?? {};
  switch (report.kind) {
    case "update_stage_failed":
      // Filed: signature, registry and other. Held: network, disk_space and
      // lock, which are faults of the host or of the network.
      return detail.error_class === "lock" || NOISE_ERROR_CLASSES.includes(detail.error_class);
    case "booted_older_image":
      return NOISE_HOWS.includes(detail.how);
    case "sysext_update_failed":
      if (detail.outcome !== "failed") return true;
      return detail.error_class !== undefined && NOISE_ERROR_CLASSES.includes(detail.error_class);
    default:
      return false;
  }
}

const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-(alpha|beta|rc)\.(0|[1-9][0-9]{0,3}))?$/;
const PRERELEASE_RANK = { alpha: 1, beta: 2, rc: 3 };

function parseSemver(version) {
  const match = SEMVER.exec(version);
  if (match === null) throw new Error("not a semver");
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? null : { rank: PRERELEASE_RANK[match[4]], number: Number(match[5]) },
  };
}

// Semver 2.0 precedence: a prerelease is lower than its release, alpha < beta
// < rc, and the prerelease number decides last.
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] < right.parts[i] ? -1 : 1;
  }
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  if (left.pre.rank !== right.pre.rank) return left.pre.rank < right.pre.rank ? -1 : 1;
  if (left.pre.number !== right.pre.number) return left.pre.number < right.pre.number ? -1 : 1;
  return 0;
}

// An image version is 14 digits, so the numeric order is the order of the
// numbers.
export function compareImageVersion(a, b) {
  const left = Number(a);
  const right = Number(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
