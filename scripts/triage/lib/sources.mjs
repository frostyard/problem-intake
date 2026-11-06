// The public sources of the release step (docs/specs/triage.md, "The
// publisher" step 3): the tags and OCI labels of an image in ghcr, and the
// versions of a sysext feature in its SHA256SUMS index. Every check is an
// anonymous read, and 1 failed read is `source_unavailable`.
//
// A test gives TRIAGE_SOURCES, a fixture folder: `registry/<image>.json` holds
// { tags, labels } and `index/<feature>/SHA256SUMS` the real index format. No
// request leaves the machine then.
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

async function request(url, { accept, token } = {}) {
  const headers = {};
  if (accept !== undefined) headers.accept = accept;
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  let answer;
  try {
    answer = await fetch(url, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SourceError("unreachable");
  }
  if (!answer.ok) throw new SourceError("status");
  return answer;
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
// answer is cached in memory for the run.
export function createSources({ config } = {}) {
  const cache = new Map();
  const fixture = config?.sources ?? null;
  const registryUrl = config?.registryUrl ?? "https://ghcr.io/";
  const indexUrl = config?.indexUrl ?? "https://repository.frostyard.org/ext/";

  function cached(key, read) {
    if (!cache.has(key)) {
      const value = Promise.resolve().then(read);
      // A failed read is not cached: the next key may read it again.
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

  async function listTags(image) {
    if (!IMAGE.test(String(image))) throw new SourceError("image");
    if (fixture !== null) {
      const doc = readFixture(join("registry", `${image}.json`));
      if (!Array.isArray(doc.tags)) throw new SourceError("fixture");
      return doc.tags.filter((tag) => typeof tag === "string");
    }
    return cached(`tags:${image}`, async () => {
      const token = await registryToken(image);
      const tags = [];
      let url = `${registryUrl}v2/frostyard/${image}/tags/list`;
      while (url !== null) {
        const answer = await request(url, { accept: ACCEPT });
        let doc;
        try {
          doc = await answer.json();
        } catch {
          throw new SourceError("json");
        }
        if (!Array.isArray(doc?.tags)) throw new SourceError("shape");
        tags.push(...doc.tags.filter((tag) => typeof tag === "string"));
        url = nextLink(answer);
        if (url !== null) url = new URL(url, registryUrl).href;
      }
      return tags;
    });
  }

  async function registryToken(image) {
    const url = `${registryUrl}token?scope=repository:frostyard/${image}:pull`;
    const answer = await request(url);
    try {
      const doc = await answer.json();
      if (typeof doc?.token !== "string" || doc.token === "") throw new SourceError("shape");
      return doc.token;
    } catch (error) {
      if (error instanceof SourceError) throw error;
      throw new SourceError("json");
    }
  }

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
      const token = await registryToken(image);
      const manifest = await jsonAt(`${registryUrl}v2/frostyard/${image}/manifests/${tag}`, token);
      let config = manifest;
      if (Array.isArray(manifest?.manifests)) {
        // A multi-platform index: take the linux/amd64 manifest.
        const entry = manifest.manifests.find(
          (item) => item?.platform?.os === "linux" && item?.platform?.architecture === "amd64",
        );
        if (entry === undefined) throw new SourceError("no_amd64");
        config = await jsonAt(`${registryUrl}v2/frostyard/${image}/manifests/${entry.digest}`, token);
      }
      const digest = config?.config?.digest;
      if (typeof digest !== "string") throw new SourceError("shape");
      return labelsOf(await jsonAt(`${registryUrl}v2/frostyard/${image}/blobs/${digest}`, token));
    });
  }

  async function jsonAt(url, token) {
    // A ghcr blob redirects to a CDN, so the answer is followed here.
    const answer = await request(url, { accept: ACCEPT, token });
    try {
      return await answer.json();
    } catch {
      throw new SourceError("json");
    }
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
        answer = await fetch(`${indexUrl}${feature}/SHA256SUMS`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
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
