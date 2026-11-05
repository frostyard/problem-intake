#!/usr/bin/env node
// Build the Worker bundle with `wrangler deploy --dry-run` into a fresh
// temporary folder, then remove it. Nothing is uploaded.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const outdir = mkdtempSync(join(tmpdir(), "problem-intake-dry-run-"));
try {
  const result = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", outdir], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outdir, { recursive: true, force: true });
}
