// The state folder of the triage job (docs/specs/triage.md, "State files"):
// mode 0700, each file 0600, JSON written through a temporary file in the
// same folder and then renamed, so a reader never sees half a document.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export class StateError extends Error {
  constructor(code) {
    super(`state: ${code}`);
    this.name = "StateError";
    this.code = code;
  }
}

// Makes the state folder (and its parents) when it is missing, and sets it
// to 0700. A symlink or a file in its place is refused.
export function ensureStateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StateError("state_dir_not_a_directory");
  chmodSync(dir, 0o700);
}

// The parsed JSON of a state file, or `fallback` when the file is missing.
// A file that is not valid JSON throws StateError("state_file_invalid").
export function readJson(path, fallback) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new StateError("state_file_unreadable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new StateError("state_file_invalid");
  }
}

// Writes `text` to `path` with mode 0600: a temporary file in the same
// folder, fsync, then rename over the old file.
export function writeFileAtomic(path, text) {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    rmSync(tmp, { force: true });
    throw error;
  }
}

// Writes `value` as JSON (2-space indent, 1 newline at the end), atomically.
export function writeJsonAtomic(path, value) {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}

// The UTC day (YYYY-MM-DD) of `now` (a Date or milliseconds).
export function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}
