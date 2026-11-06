// The public sources of the release step (docs/specs/triage.md, "The
// publisher" step 3): the tags and OCI labels of an image in ghcr, and the
// versions of a sysext feature in its SHA256SUMS index. Every check is an
// anonymous read, and 1 failed read is `source_unavailable`.
//
// A test gives TRIAGE_SOURCES, a fixture folder: `registry/<image>.json` holds
// { tags, labels } and `index/<feature>/SHA256SUMS` the real index format. No
// request leaves the machine then. Tests of the production path inject `fetch`
// and answer from memory.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export class SourceError extends Error {
  constructor(code = "source_unavailable") {
    super(`source: ${code}`);
    this.name = "SourceError";
    this.code = "source_unavailable";
  }
}

const TIMEOUT_MS = 20_000;
const ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");
const IMAGE = /^[a-z][a-z0-9-]*$/;
const IMAGE_VERSION = /^[0-9]{14}$/;
const SOURCE_BLOB = /\/blob\/([0-9a-f]{40})\//;

async function jsonOf(answer, code = "json") {
  try {
    return await answer.json();
  } catch {
    throw new SourceError(code);
  }
}

// The `name; rel="next"` link of a registry answer, or null.
function nextLink(answer) {
  const header = answer.headers.get("link");
  if (header === null) return null;
  const match = /<([^>]+)>\s*;\s*rel="next"/.exec(header);
  return match === null ? null : match[1];
}

// Returns the source reader of 1 run: listTags(image), imageLabels(image, tag)
// -> { sourceSha, created }, and featureVersions(feature) -> [version]. Each
// answer is cached in memory for the run. `fetch` is globalThis.fetch in
// production and a stub in the tests.
export function createSources({ config, fetch: fetchImpl = globalThis.fetch } = {}) {
  const cache = new Map();
  const fixture = config?.sources ?? null;
  const registryUrl = config?.registryUrl ?? "https://ghcr.io/";
  const indexUrl = config?.indexUrl ?? "https://repository.frostyard.org/ext/";

  function cached(key, read) {
    if (!cache.has(key)) {
      const value = Promise.resolve().then(read);
      // A failed read is not cached: a later key may read it again.
      cache.set(key, value);
      value.catch(() => cache.delete(key));
    }
    return cache.get(key);
  }

  function readFixture(name) {
    try {
      return JSON.parse(readFileSync(join(fixture, name), "utf8"));
    } catch {
      throw new SourceError("fixture");
    }
  }

  async function request(url, { accept, token } = {}) {
    const headers = {};
    if (accept !== undefined) headers.accept = accept;
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    let answer;
    try {
      answer = await fetchImpl(url, { headers, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new SourceError("unreachable");
    }
    return answer;
  }

  // The pull token of 1 image: 1 anonymous read of the token endpoint.
  async function pullToken(image) {
    const answer = await request(`${registryUrl}token?scope=repository:frostyard/${image}:pull`);
    if (!answer.ok) throw new SourceError("status");
    const doc = await jsonOf(answer);
    if (typeof doc?.token !== "string" || doc.token === "") throw new SourceError("shape");
    return doc.token;
  }

  async function listTags(image) {
    if (!IMAGE.test(String(image))) throw new SourceError("image");
    if (fixture !== null) {
      const doc = readFixture(join("registry", `${image}.json`));
      if (!Array.isArray(doc.tags)) throw new SourceError("fixture");
      return doc.tags.filter((tag) => typeof tag === "string");
    }
    return cached(`tags:${image}`, async () => {
      const token = await pullToken(image);
      const tags = [];
      let url = `${registryUrl}v2/frostyard/${image}/tags/list`;
      while (url !== null) {
        // The bearer token goes with the list request and with every page.
        const answer = await request(url, { accept: ACCEPT, token });
        if (!answer.ok) throw new SourceError("status");
        const doc = await jsonOf(answer);
        if (!Array.isArray(doc?.tags)) throw new SourceError("shape");
        tags.push(...doc.tags.filter((tag) => typeof tag === "string"));
        const next = nextLink(answer);
        url = next === null ? null : new URL(next, registryUrl).href;
      }
      return tags;
    });
  }

  // The labels blob of 1 image tag: an index gives the linux/amd64 manifest,
  // and the config blob holds `config.Labels`.
  async function imageLabels(image, tag) {
    if (!IMAGE.test(String(image))) throw new SourceError("image");
    if (typeof tag !== "string" || !IMAGE_VERSION.test(tag)) throw new SourceError("tag");
    if (fixture !== null) {
      const doc = readFixture(join("registry", `${image}.json`));
      const labels = doc?.labels?.[tag];
      if (labels === null || typeof labels !== "object") throw new SourceError("fixture");
      return labelsOf(labels);
    }
    return cached(`labels:${image}:${tag}`, async () => {
      const token = await pullToken(image);
      const manifestUrl = `${registryUrl}v2/frostyard/${image}/manifests/${tag}`;
      let manifest = await readManifest(manifestUrl, token);
      if (Array.isArray(manifest?.manifests)) {
        const entry = manifest.manifests.find(
          (item) => item?.platform?.os === "linux" && item?.platform?.architecture === "amd64",
        );
        if (entry === undefined) throw new SourceError("no_amd64");
        manifest = await readManifest(`${registryUrl}v2/frostyard/${image}/manifests/${entry.digest}`, token);
      }
      const digest = manifest?.config?.digest;
      if (typeof digest !== "string") throw new SourceError("shape");
      // A blob redirects to a CDN, so the answer is followed here.
      const blob = await request(`${registryUrl}v2/frostyard/${image}/blobs/${digest}`, { accept: ACCEPT, token });
      if (!blob.ok) throw new SourceError("status");
      const doc = await jsonOf(blob);
      return labelsOf(doc?.config?.Labels);
    });
  }

  async function readManifest(url, token) {
    const answer = await request(url, { accept: ACCEPT, token });
    if (!answer.ok) throw new SourceError("status");
    const doc = await jsonOf(answer);
    if (doc === null || typeof doc !== "object") throw new SourceError("shape");
    return doc;
  }

  async function featureVersions(feature) {
    if (typeof feature !== "string" || feature === "") throw new SourceError("feature");
    if (fixture !== null) {
      let text;
      try {
        text = readFileSync(join(fixture, "index", feature, "SHA256SUMS"), "utf8");
      } catch (error) {
        // No file is no index: an empty list, as an HTTP 404 is.
        if (error?.code === "ENOENT") return [];
        throw new SourceError("fixture");
      }
      return sumVersions(text, feature);
    }
    return cached(`index:${feature}`, async () => {
      let answer;
      try {
        answer = await fetchImpl(`${indexUrl}${feature}/SHA256SUMS`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new SourceError("unreachable");
      }
      // A feature with no index has no version: an empty list, not a failure.
      if (answer.status === 404) return [];
      if (!answer.ok) throw new SourceError("status");
      try {
        return sumVersions(await answer.text(), feature);
      } catch {
        throw new SourceError("read");
      }
    });
  }

  return { listTags, imageLabels, featureVersions };
}

// The OCI labels of an image config: { sourceSha, created }.
export function labelsOf(labels) {
  const source = labels?.["org.opencontainers.image.source"];
  const created = labels?.["org.opencontainers.image.created"];
  const match = typeof source === "string" ? SOURCE_BLOB.exec(source) : null;
  return {
    sourceSha: match === null ? null : match[1],
    created: typeof created === "string" ? created : null,
  };
}

// The versions of `<feature>_<version>_<rest>` in a SHA256SUMS file, in file
// order. A line with another shape is not a version of this feature.
export function sumVersions(text, feature) {
  const versions = [];
  for (const line of String(text).split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (match === null) continue;
    const file = match[2];
    const prefix = `${feature}_`;
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const underscore = rest.indexOf("_");
    const version = underscore < 0 ? rest : rest.slice(0, underscore);
    if (version === "") continue;
    if (!versions.includes(version)) versions.push(version);
  }
  return versions;
}

// The UTC day of an ISO timestamp, or null.
export function dayOf(timestamp) {
  if (typeof timestamp !== "string") return null;
  const day = timestamp.slice(0, 10);
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day) ? day : null;
}
