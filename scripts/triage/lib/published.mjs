// `published.json` of the triage publisher (docs/specs/triage.md, "Close the
// loop"): 1 entry for each tracked problem key, what the job already did on
// GitHub. Written after each GitHub action, so an action whose state write was
// lost is not repeated.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJson, StateError, writeJsonAtomic } from "./state.mjs";

export const PUBLISHED_SCHEMA = "frostyard.problem-triage-published/1";
export const PUBLISHED_FILE = "published.json";

export const STATES = Object.freeze(["filed", "merged", "released", "verified", "muted"]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[0-9a-f]{16}$/;

// The empty document.
export function emptyPublished() {
  return { schema: PUBLISHED_SCHEMA, keys: {} };
}

// The 1 entry of a key that was just filed.
export function newEntry({ repo, number, cycle = 1, state = "filed", boundary = null, releasedDay = null, featureIndex = null, ids = [], marker = null }) {
  return {
    repo,
    number,
    cycle,
    state,
    boundary,
    released_day: releasedDay,
    covered_days: 0,
    last_counted_day: null,
    feature_index: featureIndex,
    glitchtip_issue_ids: [...ids],
    last_comment_marker: marker,
  };
}

// The document of the state folder, or null when it is lost and must be
// rebuilt from the markers.
export function readPublished(dir) {
  const path = join(dir, PUBLISHED_FILE);
  if (!existsSync(path)) return null;
  const doc = readJson(path, null);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new StateError("published_not_object");
  if (doc.schema !== PUBLISHED_SCHEMA) throw new StateError("published_schema");
  if (doc.keys === null || typeof doc.keys !== "object" || Array.isArray(doc.keys)) {
    throw new StateError("published_keys");
  }
  for (const [key, entry] of Object.entries(doc.keys)) {
    if (!KEY.test(key)) throw new StateError("published_key");
    if (entry === null || typeof entry !== "object") throw new StateError("published_entry");
    if (!STATES.includes(entry.state)) throw new StateError("published_state");
    if (!Number.isSafeInteger(entry.number) || entry.number < 1) throw new StateError("published_number");
    if (typeof entry.repo !== "string") throw new StateError("published_repo");
    if (!Number.isSafeInteger(entry.cycle) || entry.cycle < 1) throw new StateError("published_cycle");
    if (!Number.isSafeInteger(entry.covered_days) || entry.covered_days < 0) throw new StateError("published_covered_days");
    if (entry.released_day !== null && !DAY.test(String(entry.released_day))) throw new StateError("published_released_day");
    if (entry.last_counted_day !== null && !DAY.test(String(entry.last_counted_day))) {
      throw new StateError("published_last_counted_day");
    }
  }
  return { schema: PUBLISHED_SCHEMA, keys: doc.keys };
}

// Writes the document atomically, mode 0600.
export function writePublished(dir, doc) {
  writeJsonAtomic(join(dir, PUBLISHED_FILE), { schema: PUBLISHED_SCHEMA, keys: doc.keys });
}

// The tracked keys in the order of a deferral: (repo, number).
export function trackedKeys(doc) {
  return Object.keys(doc.keys).sort((a, b) => {
    const left = doc.keys[a];
    const right = doc.keys[b];
    if (left.repo !== right.repo) return left.repo < right.repo ? -1 : 1;
    if (left.number !== right.number) return left.number - right.number;
    return a < b ? -1 : 1;
  });
}
