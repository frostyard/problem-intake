// The public sources that verify a report value (docs/specs/triage.md,
// "Verification"): the git repository of the routed module, the image registry
// and the sysext index. Every read is anonymous, every answer is kept for the
// rest of the run, and every failure is a SourceError, which the reader holds
// as `source_unavailable` for that problem.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 120000;
const HTTP_TIMEOUT_MS = 20000;
const MAX_REGISTRY_PAGES = 50;
const HEX64 = "[0-9a-f]{64}";
const CHECKSUM_LINE = new RegExp(`^(${HEX64}) [ *](.+)$`);

export class SourceError extends Error {
  constructor(code) {
    super(`source: ${code}`);
    this.name = "SourceError";
    this.code = code;
  }
}

function splitRepo(repo) {
  const at = repo.indexOf("/");
  return { owner: repo.slice(0, at), name: repo.slice(at + 1) };
}

function cacheName(repo) {
  const { owner, name } = splitRepo(repo);
  return `${owner}__${name}`;
}

function countLines(text) {
  if (text === "") return 0;
  return text.replace(/\n$/, "").split("\n").length;
}

// The URL of the registry's next page, only when it stays on the same origin
// and the same path: anything else is refused.
function samePathNext(header, current) {
  if (typeof header !== "string" || header === "") return null;
  for (const match of header.matchAll(/<([^<>]*)>\s*;\s*rel="([a-z]+)"/g)) {
    if (match[2] !== "next") continue;
    let next;
    try {
      next = new URL(match[1], current);
    } catch {
      return null;
    }
    const base = new URL(current);
    if (next.origin !== base.origin || next.pathname !== base.pathname) return null;
    return next.href;
  }
  return null;
}

// The sources of 1 run. `stateDir` holds the cache clones, `runGit` is the
// git runner (a test injects 1 that fails), `fetchImpl` reads the registry and
// the index. In a test `config.sources` is the fixture folder: git URLs are
// file:// URLs, and the registry and the index are files.
export function createSources({ config, stateDir, runGit, fetchImpl = globalThis.fetch, deadline = null, now = Date.now }) {
  // Each read gets its own timeout, cut to the time left before the run's
  // deadline, so the source checks cannot run the job past it.
  const limit = (ms) => (deadline === null ? ms : Math.max(1000, Math.min(ms, deadline - now())));
  const gitOptions = () => ({
    timeout: limit(GIT_TIMEOUT_MS),
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const prefix = config.sources === null ? [] : ["-c", "protocol.file.allow=always"];

  const tagSets = new Map();
  const fetchedTags = new Set();
  const ready = new Set();
  const modules = new Map();
  const trees = new Map();
  const files = new Map();
  const imageTagLists = new Map();
  const indexLists = new Map();

  // Runs git and never throws: { code, stdout }, where code is the exit status
  // (1 for a grep miss when git reported it). Any other failure is the
  // caller's to map to a SourceError.
  async function git(args) {
    try {
      const result = await runGit([...prefix, ...args], gitOptions());
      return { code: 0, stdout: typeof result === "string" ? result : String(result?.stdout ?? "") };
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : "failed";
      return { code, stdout: typeof error?.stdout === "string" ? error.stdout : "" };
    }
  }

  function remoteUrl(repo) {
    const { owner, name } = splitRepo(repo);
    if (config.sources !== null) return `file://${join(config.sources, "git", `${owner}__${name}`)}`;
    return `${config.githubUrl}${owner}/${name}.git`;
  }

  function cloneDir(repo) {
    return join(stateDir, "cache", "git", cacheName(repo));
  }

  async function ensureRepo(repo) {
    if (ready.has(repo)) return cloneDir(repo);
    const dir = cloneDir(repo);
    mkdirSync(join(stateDir, "cache"), { recursive: true, mode: 0o700 });
    mkdirSync(join(stateDir, "cache", "git"), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!existsSync(join(dir, "HEAD"))) {
      const init = await git(["-C", dir, "init", "--bare", "--quiet"]);
      if (init.code !== 0) throw new SourceError("git_init");
      const add = await git(["-C", dir, "remote", "add", "origin", remoteUrl(repo)]);
      // A cache folder that is already a repository keeps its own origin; the
      // URL of this checkout wins, because the fixture folder can change.
      if (add.code !== 0) await git(["-C", dir, "remote", "set-url", "origin", remoteUrl(repo)]);
    }
    ready.add(repo);
    return dir;
  }

  // The tag set of a repository, from `git ls-remote --tags`. Annotated tags
  // appear twice (`v1.0.0` and `v1.0.0^{}`); the peeled row is dropped.
  async function tags(repo) {
    if (tagSets.has(repo)) return tagSets.get(repo);
    const result = await git(["ls-remote", "--tags", remoteUrl(repo)]);
    if (result.code !== 0) throw new SourceError("git_tags");
    const names = new Set();
    for (const line of result.stdout.split("\n")) {
      const match = /^[0-9a-f]{40,64}\trefs\/tags\/(.+)$/.exec(line.trim());
      if (match === null) continue;
      names.add(match[1].replace(/\^\{\}$/, ""));
    }
    tagSets.set(repo, names);
    return names;
  }

  // Makes a tag readable in the cache clone, 1 shallow fetch for each tag.
  async function ensureTag(repo, tag) {
    const id = `${repo}\u0000${tag}`;
    if (fetchedTags.has(id)) return;
    const dir = await ensureRepo(repo);
    const have = await git(["-C", dir, "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
    if (have.code !== 0) {
      const fetched = await git(["-C", dir, "fetch", "--depth", "1", "origin", "tag", tag]);
      if (fetched.code !== 0) throw new SourceError("git_fetch");
    }
    fetchedTags.add(id);
  }

  async function dir(repo, tag) {
    await ensureTag(repo, tag);
    return cloneDir(repo);
  }

  // True when `literal` is in the tree of `tag`, matched fixed (no pattern):
  // the reader passes the code with its quotes.
  async function grepFixed(repo, tag, literal) {
    const where = await dir(repo, tag);
    const result = await git(["-C", where, "grep", "-q", "-F", "-e", literal, tag]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new SourceError("git_grep");
  }

  // True when the pattern matches in the pathspecs of `tag`. The `--` keeps a
  // pathspec from being read as a revision.
  async function grepFrame(repo, tag, pattern, pathspecs) {
    const where = await dir(repo, tag);
    const result = await git(["-C", where, "grep", "-q", "-E", "-e", pattern, tag, "--", ...pathspecs]);
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new SourceError("git_grep");
  }

  // The module line of go.mod at `tag`, which the module part of a frame must
  // equal. A missing go.mod is a read failure of the source.
  async function goModule(repo, tag) {
    const id = `${repo}\u0000${tag}`;
    if (modules.has(id)) return modules.get(id);
    const where = await dir(repo, tag);
    const result = await git(["-C", where, "show", `${tag}:go.mod`]);
    if (result.code !== 0) throw new SourceError("git_show");
    const match = /^module[ \t]+(\S+)[ \t]*$/m.exec(result.stdout);
    if (match === null) throw new SourceError("git_show");
    modules.set(id, match[1]);
    return match[1];
  }

  // Every path of the tree at `tag`.
  async function tree(repo, tag) {
    const id = `${repo}\u0000${tag}`;
    if (trees.has(id)) return trees.get(id);
    const where = await dir(repo, tag);
    const result = await git(["-C", where, "ls-tree", "-r", "--name-only", tag]);
    if (result.code !== 0) throw new SourceError("git_tree");
    const paths = result.stdout.split("\n").filter((line) => line !== "");
    trees.set(id, paths);
    return paths;
  }

  // The number of lines of `<tag>:<path>`, or null when the tree has no such
  // file.
  async function fileLines(repo, tag, path) {
    const id = `${repo}\u0000${tag}\u0000${path}`;
    if (files.has(id)) return files.get(id);
    const where = await dir(repo, tag);
    const result = await git(["-C", where, "cat-file", "-p", `${tag}:${path}`]);
    const lines = result.code === 0 ? countLines(result.stdout) : null;
    files.set(id, lines);
    return lines;
  }

  // The line count of the Rust file of a `location` value (docs/specs/triage.md,
  // Verification: the file at the repository root, or below the folder of any
  // Cargo.toml of that tag), or null when no candidate exists. With several
  // candidates the longest counts: the location verifies when any of them has
  // that many lines.
  async function locationLines(repo, tag, path) {
    const paths = new Set(await tree(repo, tag));
    const folders = new Set([""]);
    for (const entry of paths) {
      if (entry === "Cargo.toml") continue;
      if (entry.endsWith("/Cargo.toml")) folders.add(entry.slice(0, -"/Cargo.toml".length));
    }
    const candidates = [path];
    for (const folder of [...folders].sort()) {
      if (folder !== "") candidates.push(`${folder}/${path}`);
    }
    let most = null;
    for (const candidate of candidates) {
      if (!paths.has(candidate)) continue;
      const lines = await fileLines(repo, tag, candidate);
      if (lines !== null && (most === null || lines > most)) most = lines;
    }
    return most;
  }

  async function readText(url) {
    let response;
    try {
      response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(limit(HTTP_TIMEOUT_MS)) });
    } catch {
      throw new SourceError("http");
    }
    if (response.status === 404) return { status: 404, text: "" };
    if (!response.ok) {
      throw new SourceError("http");
    }
    try {
      return { status: response.status, text: await response.text() };
    } catch {
      throw new SourceError("http");
    }
  }

  // The registry token of 1 image of frostyard, anonymous.
  async function registryToken(image) {
    const url = `${config.registryUrl}token?scope=repository:frostyard/${image}:pull`;
    const { status, text } = await readText(url);
    if (status === 404) throw new SourceError("registry");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new SourceError("registry");
    }
    if (body === null || typeof body !== "object" || typeof body.token !== "string" || body.token === "") {
      throw new SourceError("registry");
    }
    return body.token;
  }

  async function registryPage(url, token) {
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "error",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(limit(HTTP_TIMEOUT_MS)),
      });
    } catch {
      throw new SourceError("registry");
    }
    if (!response.ok) throw new SourceError("registry");
    let body;
    try {
      body = JSON.parse(await response.text());
    } catch {
      throw new SourceError("registry");
    }
    if (body === null || typeof body !== "object" || !Array.isArray(body.tags)) {
      throw new SourceError("registry");
    }
    const tags = body.tags.filter((tag) => typeof tag === "string");
    return { tags, next: samePathNext(response.headers.get("link"), url) };
  }

  // The tags of `ghcr.io/frostyard/<image>`. A fixture folder holds the answer
  // as `<sources>/registry/<image>.json`.
  async function imageTags(image) {
    if (imageTagLists.has(image)) {
      const cached = imageTagLists.get(image);
      if (cached.ok) return cached.tags;
      throw cached.error;
    }
    try {
      let tags;
      if (config.sources !== null) {
        const file = join(config.sources, "registry", `${image}.json`);
        let text;
        try {
          text = readFileSync(file, "utf8");
        } catch {
          throw new SourceError("registry_fixture");
        }
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          throw new SourceError("registry_fixture");
        }
        if (body === null || typeof body !== "object" || !Array.isArray(body.tags)) {
          throw new SourceError("registry_fixture");
        }
        tags = body.tags.filter((tag) => typeof tag === "string");
      } else {
        const token = await registryToken(image);
        tags = [];
        let url = `${config.registryUrl}v2/frostyard/${image}/tags/list?n=1000`;
        let pages = 0;
        for (;;) {
          const page = await registryPage(url, token);
          tags.push(...page.tags);
          pages += 1;
          if (page.next === null) break;
          // A list longer than the page limit is not read in full, so a
          // missing tag would look unverified: that is a source failure.
          if (pages >= MAX_REGISTRY_PAGES) throw new SourceError("registry_pages");
          url = page.next;
        }
      }
      imageTagLists.set(image, { ok: true, tags });
      return tags;
    } catch (error) {
      const wrapped = error instanceof SourceError ? error : new SourceError("registry");
      imageTagLists.set(image, { ok: false, error: wrapped });
      throw wrapped;
    }
  }

  function parseChecksums(text) {
    const names = [];
    for (const line of text.split("\n")) {
      const match = CHECKSUM_LINE.exec(line.trim());
      if (match !== null) names.push(match[2]);
    }
    return names;
  }

  // The file names of the SHA256SUMS index of 1 feature. A 404, or a missing
  // fixture file, is an empty list: the feature has published nothing.
  async function featureFiles(feature) {
    if (indexLists.has(feature)) {
      const cached = indexLists.get(feature);
      if (cached.ok) return cached.names;
      throw cached.error;
    }
    try {
      let names;
      if (config.sources !== null) {
        const file = join(config.sources, "index", feature, "SHA256SUMS");
        if (!existsSync(file)) {
          names = [];
        } else {
          names = parseChecksums(readFileSync(file, "utf8"));
        }
      } else {
        const { status, text } = await readText(`${config.indexUrl}${encodeURIComponent(feature)}/SHA256SUMS`);
        names = status === 404 ? [] : parseChecksums(text);
      }
      indexLists.set(feature, { ok: true, names });
      return names;
    } catch (error) {
      const wrapped = error instanceof SourceError ? error : new SourceError("index");
      indexLists.set(feature, { ok: false, error: wrapped });
      throw wrapped;
    }
  }

  return { tags, ensureTag, grepFixed, grepFrame, goModule, tree, fileLines, locationLines, imageTags, featureFiles };
}
