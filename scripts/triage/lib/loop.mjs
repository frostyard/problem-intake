// The close-the-loop rules of the triage job (docs/specs/triage.md, "Close the
// loop"): markers, the step order, version precedence, fix boundaries, the
// qualifiying observation of a regression, the covered day and the `Fixed in`
// comment. Pure functions, no I/O: the publisher and the tests both use them.
//
// node: builtins only: the team VM runs the job with no `npm`.

// The step of a cycle. A regression starts a new cycle, so `regressed` is the
// start of its cycle, like `filed`.
export const STEP_RANK = Object.freeze({ filed: 0, regressed: 0, released: 1, verified: 2 });

export const STEPS = Object.freeze(["filed", "released", "verified", "regressed"]);

// The exact marker line of a step comment.
const MARKER = /^<!-- problem-triage:1 key=([0-9a-f]{16}) cycle=([1-9][0-9]*) step=(filed|released|verified|regressed) boundary=(\S+) -->$/;

const SEMVER = /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(?:-(alpha|beta|rc)\.(0|[1-9][0-9]{0,3}))?$/;
// The image.id enum of schema/v1.json: a `Fixed in:` line names 1 of these.
const IMAGE_IDS = Object.freeze(["snow", "snowfield", "sundog", "floe"]);
const IMAGE_ID = /^[a-z][a-z0-9-]*$/;
const IMAGE_VERSION = /^[0-9]{14}$/;
const FEATURE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SYSEXT_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+~_-]{0,63}$/;
const IMAGE_PART = /^image:([a-z][a-z0-9-]*):([0-9]{14})$/;
const FIXED_IMAGE = /^Fixed in: image ([a-z][a-z0-9-]*) ([0-9]{14})$/;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const PRERELEASE_ORDER = ["alpha", "beta", "rc"];

// The first line of a step comment: `boundary=none` while the problem has no
// fix boundary yet.
export function formatMarker({ key, cycle, step, boundary = null }) {
  return `<!-- problem-triage:1 key=${key} cycle=${cycle} step=${step} boundary=${boundary === null ? "none" : boundary} -->`;
}

// Parses 1 marker line. Returns { key, cycle, step, boundary, marker } or
// null; `boundary` is null for `boundary=none`.
export function parseMarker(line) {
  if (typeof line !== "string") return null;
  const match = MARKER.exec(line);
  if (match === null) return null;
  const boundary = match[4] === "none" ? null : match[4];
  if (boundary !== null && parseBoundary(boundary) === null) return null;
  return { key: match[1], cycle: Number(match[2]), step: match[3], boundary, marker: line };
}

// The highest marker of a list by (cycle, rank), or null.
export function highestMarker(markers) {
  let best = null;
  for (const marker of markers ?? []) {
    if (marker === null) continue;
    if (best === null || marker.cycle > best.cycle || (marker.cycle === best.cycle && STEP_RANK[marker.step] > STEP_RANK[best.step])) {
      best = marker;
    }
  }
  return best;
}

// True when `a` is a later step than `b` (a marker of `b` may be null).
export function isHigherStep(a, b) {
  if (a === null || a === undefined) return false;
  if (b === null || b === undefined) return true;
  if (a.cycle !== b.cycle) return a.cycle > b.cycle;
  return STEP_RANK[a.step] > STEP_RANK[b.step];
}

function parseSemver(value) {
  const match = SEMVER.exec(String(value));
  if (match === null) return null;
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])];
  const prerelease = match[4] === undefined ? null : { tag: match[4], number: Number(match[5]) };
  return { numbers, prerelease };
}

export function isSemver(value) {
  return typeof value === "string" && SEMVER.test(value);
}

// semver 2.0 precedence for the schema semver pattern: -1, 0 or 1.
export function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) throw new Error("semver");
  for (let i = 0; i < 3; i += 1) {
    if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] < right.numbers[i] ? -1 : 1;
  }
  if (left.prerelease === null && right.prerelease === null) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  const leftTag = PRERELEASE_ORDER.indexOf(left.prerelease.tag);
  const rightTag = PRERELEASE_ORDER.indexOf(right.prerelease.tag);
  if (leftTag !== rightTag) return leftTag < rightTag ? -1 : 1;
  if (left.prerelease.number !== right.prerelease.number) return left.prerelease.number < right.prerelease.number ? -1 : 1;
  return 0;
}

// Numeric precedence for an image version (`^[0-9]{14}$`).
export function compareImage(a, b) {
  if (!IMAGE_VERSION.test(String(a)) || !IMAGE_VERSION.test(String(b))) throw new Error("image version");
  const left = Number(a);
  const right = Number(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// `app:<semver>`, `image:<id>:<14 digits>[,image:...]` or
// `feature:<name>:<version>`; returns { type, ... } or null.
export function parseBoundary(text) {
  if (typeof text !== "string" || text === "") return null;
  if (text.startsWith("app:")) {
    const version = text.slice(4);
    return SEMVER.test(version) ? { type: "app", version } : null;
  }
  if (text.startsWith("feature:")) {
    const rest = text.slice(8);
    const at = rest.indexOf(":");
    if (at <= 0) return null;
    const name = rest.slice(0, at);
    const version = rest.slice(at + 1);
    if (!FEATURE.test(name) || !SYSEXT_VERSION.test(version)) return null;
    return { type: "feature", name, version };
  }
  if (text.startsWith("image:")) {
    const images = [];
    for (const part of text.split(",")) {
      const match = IMAGE_PART.exec(part);
      if (match === null) return null;
      if (!IMAGE_ID.test(match[1])) return null;
      if (images.some((image) => image.id === match[1])) return null;
      images.push({ id: match[1], version: match[2] });
    }
    return images.length === 0 ? null : { type: "image", images };
  }
  return null;
}

export function formatBoundary(boundary) {
  if (boundary === null || boundary === undefined) return null;
  if (boundary.type === "app") return `app:${boundary.version}`;
  if (boundary.type === "feature") return `feature:${boundary.name}:${boundary.version}`;
  if (boundary.type === "image") return boundary.images.map((image) => `image:${image.id}:${image.version}`).join(",");
  throw new Error("boundary");
}

// The boundary token form of 1 observation: `app:1.4.1`,
// `image:snow:20261120093000` or `feature:<name>:<version>`.
export function versionToken(boundary, observation) {
  if (boundary.type === "app") return `app:${observation.version}`;
  if (boundary.type === "image") return `image:${observation.image}:${observation.version}`;
  return `feature:${boundary.name}:${observation.feature_version}`;
}

function highest(list, compare) {
  let best = null;
  for (const item of list) if (best === null || compare(item, best) > 0) best = item;
  return best;
}

// The highest observation that qualifies as a regression of `boundary`, or
// null. Only an observation seen on or after `released_day` counts
// (docs/specs/triage.md, step 5).
export function qualifying(boundary, observations, releasedDay, featureIndex = null) {
  if (!boundary || typeof releasedDay !== "string") return null;
  const fresh = (observations ?? []).filter(
    (observation) => typeof observation?.last_seen_day === "string" && observation.last_seen_day >= releasedDay,
  );
  if (boundary.type === "app") {
    const hits = fresh.filter((o) => isSemver(o.version) && compareSemver(o.version, boundary.version) >= 0);
    return highest(hits, (a, b) => compareSemver(a.version, b.version));
  }
  if (boundary.type === "image") {
    const hits = [];
    for (const observation of fresh) {
      const image = boundary.images.find((entry) => entry.id === observation.image);
      if (image === undefined) continue;
      if (!IMAGE_VERSION.test(String(observation.version))) continue;
      if (compareImage(observation.version, image.version) >= 0) hits.push(observation);
    }
    return highest(hits, (a, b) => compareImage(a.version, b.version));
  }
  // A feature boundary: equal to the boundary, or a version that was not in
  // the index of the release day (newer). No order of feature versions.
  const index = Array.isArray(featureIndex) ? featureIndex : [];
  for (const observation of fresh) {
    const version = observation.feature_version;
    if (typeof version !== "string") continue;
    if (version === boundary.version || !index.includes(version)) return observation;
  }
  return null;
}

// True when this run counts a covered day for the entry (step 4): the run
// status is ok, the watched entry of the key is complete, and the day was not
// counted yet.
export function countCoveredDay(entry, { runStatus, watched, today } = {}) {
  if (runStatus !== "ok") return false;
  if (watched === null || watched === undefined || watched.coverage !== "complete") return false;
  if (typeof today !== "string") return false;
  return entry?.last_counted_day !== today;
}

// A comment body may use CRLF line endings.
function commentLines(comment) {
  return String(comment?.body ?? "").split(/\r?\n/);
}

// The newest `Fixed in:` comment of a trusted association on the repository
// that holds the issue. Returns null, { type: "image", images, comment } or
// { type: "feature", name, version, comment }.
export function parseFixedIn(comments) {
  const trusted = (comments ?? [])
    .filter((comment) => TRUSTED_ASSOCIATIONS.has(comment?.authorAssociation))
    .slice()
    .sort((a, b) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")));
  for (const comment of trusted) {
    const images = [];
    let feature = null;
    for (const line of commentLines(comment)) {
      const image = FIXED_IMAGE.exec(line);
      if (image !== null) {
        // An id that is not an image of the schema is not a `Fixed in` line.
        if (!IMAGE_IDS.includes(image[1])) continue;
        if (images.some((entry) => entry.id === image[1])) continue;
        images.push({ id: image[1], version: image[2] });
        continue;
      }
      const sysext = /^Fixed in: feature ([a-z0-9][a-z0-9._-]{0,63}) ([0-9A-Za-z][0-9A-Za-z.+~_-]{0,63})$/.exec(line);
      if (sysext !== null) feature = { name: sysext[1], version: sysext[2] };
    }
    if (images.length > 0) {
      return { type: "image", images, comment: comment.body, createdAt: comment.createdAt ?? null };
    }
    if (feature !== null) {
      return { type: "feature", ...feature, comment: comment.body, createdAt: comment.createdAt ?? null };
    }
  }
  return null;
}
