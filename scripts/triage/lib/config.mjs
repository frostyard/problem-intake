// The fixed values of the triage job and its test overrides
// (docs/specs/triage.md, "Configuration"). Production values are fixed here.
// A test overrides them only with TRIAGE_TEST=1; without it, a TRIAGE_*
// variable stops the run with exit 2 and no request.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository root of this checkout: routes, allowlists and the cutoff
// come from here (triage/), never from the state folder.
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

export const PRODUCTION = Object.freeze({
  glitchtipUrl: "https://glitchtip.ketelsen.cloud/api/0/",
  org: "frostyard",
  githubUrl: "https://github.com/",
  registryUrl: "https://ghcr.io/",
  indexUrl: "https://repository.frostyard.org/ext/",
});

// The variables a test may set, each only with TRIAGE_TEST=1.
export const OVERRIDES = Object.freeze([
  "TRIAGE_GLITCHTIP_URL",
  "TRIAGE_TOKEN_FILE",
  "TRIAGE_STATE_DIR",
  "TRIAGE_SOURCES",
]);

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

// A refused configuration. `code` is a fixed reason string; the message
// never holds a value of the environment.
export class ConfigError extends Error {
  constructor(code) {
    super(`config: ${code}`);
    this.name = "ConfigError";
    this.code = code;
  }
}

function absolutePath(value, code) {
  if (typeof value !== "string" || value === "" || !isAbsolute(value)) throw new ConfigError(code);
  return resolve(value);
}

// The configuration of 1 run. `env` is process.env in production.
// Returns { test, glitchtipUrl, org, tokenFile, createdFile, stateDir,
// githubUrl, registryUrl, indexUrl, sources }. `sources` is null in
// production; in a test it is the fixture folder of TRIAGE_SOURCES.
// Throws ConfigError for an override without TRIAGE_TEST=1, a test URL that
// is not on 127.0.0.1 or localhost, or a path that is not absolute.
export function loadConfig(env = process.env, home = homedir()) {
  const set = OVERRIDES.filter((name) => env[name] !== undefined);
  const test = env.TRIAGE_TEST === "1";
  if (set.length > 0 && !test) throw new ConfigError("override_without_test");

  const configDir = join(home, ".config", "problem-triage");
  const config = {
    test,
    glitchtipUrl: PRODUCTION.glitchtipUrl,
    org: PRODUCTION.org,
    tokenFile: join(configDir, "glitchtip-read.token"),
    createdFile: join(configDir, "glitchtip-read.created"),
    stateDir: join(home, ".local", "state", "problem-triage"),
    githubUrl: PRODUCTION.githubUrl,
    registryUrl: PRODUCTION.registryUrl,
    indexUrl: PRODUCTION.indexUrl,
    sources: null,
  };
  if (!test) return config;

  if (env.TRIAGE_GLITCHTIP_URL !== undefined) {
    let url;
    try {
      url = new URL(env.TRIAGE_GLITCHTIP_URL);
    } catch {
      throw new ConfigError("test_url_invalid");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ConfigError("test_url_invalid");
    if (!LOCAL_HOSTS.has(url.hostname)) throw new ConfigError("test_url_not_local");
    if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      throw new ConfigError("test_url_invalid");
    }
    if (!url.pathname.endsWith("/")) throw new ConfigError("test_url_invalid");
    config.glitchtipUrl = url.href;
  }
  if (env.TRIAGE_TOKEN_FILE !== undefined) {
    config.tokenFile = absolutePath(env.TRIAGE_TOKEN_FILE, "test_path_invalid");
    // The creation day lives beside the token file, as in production.
    config.createdFile = config.tokenFile.replace(/\.token$/, "") + ".created";
  }
  if (env.TRIAGE_STATE_DIR !== undefined) config.stateDir = absolutePath(env.TRIAGE_STATE_DIR, "test_path_invalid");
  if (env.TRIAGE_SOURCES !== undefined) config.sources = absolutePath(env.TRIAGE_SOURCES, "test_path_invalid");
  return config;
}
