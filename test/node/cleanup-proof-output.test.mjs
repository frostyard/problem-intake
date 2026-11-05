// Guards scripts/glitchtip-cleanup-proof.sh (docs/runbook/glitchtip.md,
// "Retention"): whatever the GlitchTip container prints, the script shows only
// its own fixed-shape lines, never an exception message or stderr text.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../scripts/glitchtip-cleanup-proof.sh", import.meta.url));
const FAKE = "test-cleanup-proof-not-a-real-secret";

// A stub for "docker exec ... manage.py shell": it eats the Python program and
// prints the fake secret in bad-shaped lines on stdout and on stderr, then a
// valid ERROR status.
function runWithStub() {
  const dir = mkdtempSync(join(tmpdir(), "cleanup-proof-"));
  try {
    const stub = join(dir, "docker");
    writeFileSync(
      stub,
      [
        "#!/bin/sh",
        "cat >/dev/null",
        `echo "Traceback: ValueError: bad key ${FAKE}"`,
        `echo "ERROR stage=send type=ValueError message=${FAKE}"`,
        `echo "ERROR stage=send type=${FAKE}"`,
        `echo "COUNT ${FAKE}=1"`,
        `echo "COUNT stage=${FAKE}"`,
        `echo "COUNT retention_days=72 key ${FAKE}"`,
        `echo "${FAKE}" >&2`,
        `echo "ERROR stage=send type=HTTPError ${FAKE}" >&2`,
        'echo "ERROR stage=send type=HTTPError"',
        'echo "STATUS result=ERROR"',
        "",
      ].join("\n"),
    );
    chmodSync(stub, 0o700);
    return spawnSync("bash", [script], {
      encoding: "utf8",
      env: { ...process.env, DOCKER: stub, GLITCHTIP_WEB_CONTAINER: "stub", GLITCHTIP_PROOF_DEBUG: "1" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the cleanup proof never shows a secret printed by GlitchTip", () => {
  const result = runWithStub();
  assert.equal(result.status, 1, `exit status ${result.status}`);
  assert.ok(!result.stdout.includes(FAKE), "the fake secret is on stdout");
  assert.ok(!result.stderr.includes(FAKE), "the fake secret is on stderr");
  // The well-shaped line passes.
  assert.match(result.stdout, /^ERROR: stage=send type=HTTPError$/m);
});

test("the cleanup proof's Python prints no exception message", () => {
  const text = readFileSync(script, "utf8");
  const python = text.slice(text.indexOf("<<'PY'"), text.indexOf("\nPY\n"));
  assert.ok(python.length > 1000, "the Python part was not found");
  assert.doesNotMatch(python, /str\(error\)/);
  assert.doesNotMatch(python, /message=/);
  assert.doesNotMatch(text, /PROOF_DEBUG/, "a debug path shows GlitchTip stderr");
});
