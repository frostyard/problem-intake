// The data files of the triage job (docs/specs/triage.md): the cutoff config,
// the route table, the allowlists and the script that seeds them from a snosi
// checkout. No network: the seed test builds its own git repository.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const schema = JSON.parse(read("schema/v1.json"));

// Every temporary folder this file makes, removed when it ends.
const temps = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const UNIT = new RegExp(schema.$defs.unit_failed.properties.unit.pattern);
const FEATURE = new RegExp(schema.$defs.sysext_update_failed.properties.feature.pattern);
const REPO = /^frostyard\/[a-z0-9-]+$/;
const SEED_HEADER = /^# Seed: frostyard\/snosi ([0-9a-f]{40}), scripts\/triage\/seed-allow\.mjs\. A new entry is a PR, never a value from a report\.$/;

test("triage/config.json holds the publication cutoff and nothing else", () => {
  const config = JSON.parse(read("triage/config.json"));
  assert.deepEqual(Object.keys(config), ["first_seen_cutoff"]);
  const cutoff = config.first_seen_cutoff;
  assert.ok(cutoff === null || /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(cutoff), `bad cutoff: ${cutoff}`);
});

test("triage/routes.json routes every filed kind and files the rest", () => {
  const routes = JSON.parse(read("triage/routes.json"));
  assert.deepEqual(Object.keys(routes).sort(), ["app_problem", "kinds", "not_filed", "schema"]);
  assert.equal(routes.schema, "frostyard.problem-triage-routes/1");

  // An app routes by app_id, so every app of the schema has a row and no kind does.
  assert.deepEqual(Object.keys(routes.app_problem).sort(), [...schema.$defs.app_problem.properties.app_id.enum].sort());
  for (const repo of Object.values(routes.app_problem)) assert.match(repo, REPO);

  // Every kind of the schema is in exactly 1 of the 2 lists, and app_problem in neither.
  const filed = Object.entries(routes.kinds);
  for (const kind of schema.properties.kind.enum) {
    const hits = filed.filter(([name]) => name === kind).length + routes.not_filed.filter((name) => name === kind).length;
    assert.equal(hits, kind === "app_problem" ? 0 : 1, `${kind} is in ${hits} lists`);
  }
  for (const [kind, repo] of filed) {
    assert.ok(schema.properties.kind.enum.includes(kind), `${kind} is not a schema kind`);
    assert.match(repo, REPO, `${kind} routes to ${repo}`);
  }
  for (const kind of routes.not_filed) assert.ok(schema.properties.kind.enum.includes(kind), `${kind} is not a schema kind`);
  assert.deepEqual([...routes.not_filed].sort(), ["count", "crash"]);
});

test("the allowlists are seeded from 1 snosi commit and hold only schema names", () => {
  const readList = (path) => {
    const lines = read(path).split("\n");
    assert.equal(lines.at(-1), "", `${path} has no newline at the end`);
    const [header, ...names] = lines.slice(0, -1);
    const match = SEED_HEADER.exec(header);
    assert.ok(match !== null, `${path}: bad seed line: ${header}`);
    return { commit: match[1], names };
  };

  const units = readList("triage/allow/units.txt");
  const features = readList("triage/allow/features.txt");
  assert.equal(units.commit, features.commit, "the 2 allowlists name different commits");

  for (const [path, list, pattern] of [
    ["triage/allow/units.txt", units.names, UNIT],
    ["triage/allow/features.txt", features.names, FEATURE],
  ]) {
    assert.ok(list.length >= 1, `${path} is empty`);
    for (const name of list) {
      assert.ok(name !== "" && !/\s/.test(name), `${path}: bad entry "${name}"`);
      assert.match(name, pattern, `${path}: "${name}" is not a schema name`);
    }
    assert.deepEqual(list, [...new Set(list)].sort(), `${path} is not sorted with no duplicates`);
  }
});

// The seed script, against a git repository that holds every case of the
// selection rule: a system unit, a user unit, a template unit, a mask, the
// installer tree, a `.wants/` alias, a `.d/` drop-in and 2 features.
test("scripts/triage/seed-allow.mjs writes the 2 allowlists", () => {
  const tmp = mkdtempSync(join(tmpdir(), "triage-seed-"));
  temps.push(tmp);
  const repo = join(tmp, "snosi");
  const out = join(tmp, "allow");
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  const put = (path, text = "") => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };

  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  put("mkosi.images/base/mkosi.extra/usr/lib/systemd/system/alpha.service", "[Unit]\n");
  put("mkosi.images/base/mkosi.extra/usr/lib/systemd/system/x@.service", "[Unit]\n");
  put("shared/snow/tree/usr/lib/systemd/user/beta.service", "[Unit]\n");
  put("shared/firn-installer/tree/usr/lib/systemd/system/installer.service", "[Unit]\n");
  put("mkosi.images/base/mkosi.extra/usr/lib/systemd/system/a.service.d/b.conf", "[Service]\n");
  put("mkosi.images/base/mkosi.extra/usr/lib/systemd/system/multi-user.target.wants/wanted.service", "[Unit]\n");
  put("mkosi.images/base/mkosi.extra/usr/lib/sysupdate.gamma.d/gamma.feature", "[Feature]\n");
  put("mkosi.images/base/mkosi.extra/usr/lib/sysupdate.delta-x.d/delta-x.feature", "[Feature]\n");
  symlinkSync("/dev/null", join(repo, "mkosi.images/base/mkosi.extra/usr/lib/systemd/system/masked.service"));
  git("add", "-A");
  git("-c", "user.name=test", "-c", "user.email=test@test.invalid", "commit", "-q", "-m", "seed");

  const run = (args) => spawnSync(process.execPath, [join(root, "scripts/triage/seed-allow.mjs"), ...args], { encoding: "utf8" });
  const commit = git("rev-parse", "HEAD").trim();
  const seed = run(["--snosi", repo, "--commit", commit, "--out", out]);
  assert.equal(seed.status, 0, seed.stderr);

  const header = `# Seed: frostyard/snosi ${commit}, scripts/triage/seed-allow.mjs. A new entry is a PR, never a value from a report.`;
  assert.equal(readFileSync(join(out, "units.txt"), "utf8"), `${header}\nalpha.service\nbeta.service\nx@.service\n`);
  assert.equal(readFileSync(join(out, "features.txt"), "utf8"), `${header}\ndelta-x\ngamma\n`);

  // A commit that is not 40 hex characters is refused, and nothing is written.
  const bad = run(["--snosi", repo, "--commit", "HEAD", "--out", join(tmp, "bad")]);
  assert.equal(bad.status, 2, bad.stdout);
  assert.ok(!existsSync(join(tmp, "bad")), "the refused run wrote its output folder");
});

// Every `ssh` command of the runbook, with its wrapped lines joined. `ssh`
// joins its arguments into 1 line for the remote shell, so a quoted remote
// command must be 1 double-quoted argument (docs/runbook/triage.md).
function sshCommands(text) {
  const lines = text.split("\n");
  const commands = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.startsWith("ssh ")) continue;
    let command = line;
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (!/^\s+\S/.test(next) || /^\s+(```|\||#)/.test(next)) break;
      command += ` ${next.trim()}`;
      i += 1;
    }
    commands.push(command);
  }
  return commands;
}

test("every ssh command of the triage runbook quotes its remote command", () => {
  const host = "fleet@10.0.1.176";
  const commands = sshCommands(read("docs/runbook/triage.md"));
  assert.ok(commands.length >= 2, `found ${commands.length} ssh commands, expected at least 2`);
  for (const command of commands) {
    const at = command.indexOf(`${host} `);
    assert.ok(at >= 0, `no ${host} in: ${command}`);
    const remote = command.slice(at + host.length + 1).trim();
    if (!remote.includes("'")) continue;
    assert.ok(remote.startsWith('"'), `remote command is not 1 double-quoted argument: ${command}`);
    assert.ok(remote.endsWith('"'), `remote command has no closing quote: ${command}`);
  }
});
