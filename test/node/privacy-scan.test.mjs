// Static privacy scan of the Worker source (docs/design/intake.md, AGENTS.md
// hard rules). It reads src/ (not the generated validator) and fails when the
// code could read a client header or log anything.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const srcDir = join(root, "src");

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (relative(srcDir, path) === "generated") continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts")) {
      out.push(path);
    }
  }
  return out;
}

const files = sourceFiles(srcDir).map((path) => ({
  name: relative(root, path),
  text: readFileSync(path, "utf8"),
}));

// [what, pattern]. Header names are matched as written anywhere in the file,
// comments included, so a header cannot be read under a comment's cover.
const FORBIDDEN = [
  ["the X-Forwarded-For header", /x-forwarded-for/i],
  ["the True-Client-IP header", /true-client-ip/i],
  ["the X-Real-IP header", /x-real-ip/i],
  ["the User-Agent header", /user-agent/i],
  ["the Forwarded header", /["'`]forwarded["'`]/i],
  ["the Cookie header", /["'`]cookie["'`]/i],
  ["the Referer header", /["'`]referer["'`]/i],
  ["request.cf", /request\.cf\b/],
  ["a .cf property", /\.cf\b/],
  ["a cf key", /\bcf\s*[:}]|\{\s*cf\b/],
  ["console logging", /\bconsole\s*[.[]/],
  ["a copy of all request headers", /new\s+Headers\s*\(\s*request|\.\.\.\s*request\.headers/],
  ["a header iteration", /headers\s*\.\s*(entries|keys|values|forEach)\s*\(|for\s*\([^)]*of\s+[^)]*headers\b/],
  ["a copy of the incoming request", /new\s+Request\s*\(\s*request\b|(?<!async )\bfetch\s*\(\s*request\b|request\.clone\s*\(/],
];

test("src/ holds TypeScript files to scan", () => {
  assert.ok(files.length >= 5, "the scan found too few files");
  assert.ok(files.some((f) => f.name === "src/report.ts"));
});

for (const [what, pattern] of FORBIDDEN) {
  test(`src/ never uses ${what}`, () => {
    const hits = files.filter((f) => pattern.test(f.text)).map((f) => f.name);
    assert.deepEqual(hits, [], `${what} appears in ${hits.join(", ")}`);
  });
}

test("cf-connecting-ip appears in exactly 1 place: the rate-limit key", () => {
  const places = [];
  for (const f of files) {
    for (const [i, line] of f.text.split("\n").entries()) {
      if (/cf-connecting-ip/i.test(line)) places.push(`${f.name}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.equal(places.length, 1, places.join("\n"));
  assert.match(places[0], /^src\/report\.ts:\d+: return request\.headers\.get\("cf-connecting-ip"\) \?\? LOCAL_RATE_KEY;$/);
});

test("every request header read is on the allowlist", () => {
  const allowed = new Set(["content-type", "content-length", "cf-connecting-ip"]);
  const reads = [];
  for (const f of files) {
    for (const match of f.text.matchAll(/headers\s*\.\s*(get|has)\s*\(\s*([^)]*)\)/g)) {
      reads.push({ file: f.name, arg: match[2].trim() });
    }
  }
  assert.ok(reads.length >= 3, "the scan found too few header reads");
  for (const { file, arg } of reads) {
    const literal = /^"([a-z0-9-]+)"$/.exec(arg);
    assert.ok(literal, `${file}: a header read with a computed name: ${arg}`);
    assert.ok(allowed.has(literal[1]), `${file}: reads header ${literal[1]}`);
  }
});

test("only forward.ts and sql.ts make outgoing requests", () => {
  const callers = files.filter((f) => /(?<!async )\bfetch\s*\(/.test(f.text)).map((f) => f.name).sort();
  assert.deepEqual(callers, ["src/forward.ts", "src/sql.ts"]);
});
