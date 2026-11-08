// The Go frame rules of the triage job (docs/specs/triage.md, "Published
// forms of a frame", "The frame rule", "Routed module"). Everything here works
// without a tag: it classifies a raw frame and gives its published form. The
// check at a tag (git grep) is in the reader; this module only gives it the
// pattern and the path.
//
// node: builtins only: the team VM runs the job with no `npm`.

// The standard library top-level packages of the schema `frames` pattern
// (schema/v1.json $defs.app_problem.frames). Rule 4 publishes the first path
// segment of such a frame.
export const STDLIB = Object.freeze([
  "archive", "bufio", "bytes", "cmp", "compress", "container", "context", "crypto", "database", "debug",
  "embed", "encoding", "errors", "expvar", "flag", "fmt", "go", "hash", "html", "image", "index",
  "internal", "io", "iter", "log", "main", "maps", "math", "mime", "net", "os", "path", "plugin",
  "reflect", "regexp", "runtime", "slices", "sort", "strconv", "strings", "structs", "sync", "syscall",
  "testing", "text", "time", "unicode", "unique", "unsafe", "vendor", "weak",
]);
const STDLIB_SET = new Set(STDLIB);

// The fixed published words: rule 1 (`other`), rule 3 (`unverified`), rule 5
// (`main`), rule 6 (`go-imap`), rule 7 (`frostyard`), and rule 4 (the
// standard library packages).
export const FIXED_FORMS = Object.freeze(new Set(["other", "unverified", "frostyard", "main", "go-imap", ...STDLIB]));

const GO_IMAP = "github.com/emersion/go-imap/v2";
const FROSTYARD = "github.com/frostyard/";
const N = "[A-Za-z_][A-Za-z0-9_]*";
const CLOSURE = /\.(?:func[1-9][0-9]{0,2}|[1-9][0-9]{0,2})$/;
const PKGPATH = /^((?:\/[A-Za-z0-9_-]+)*)\.(.+)$/;

// The 6 parent forms of step 3, each with the form name and the groups that
// hold the type and the function name.
const PARENT_FORMS = [
  { re: new RegExp(`^(${N})\\[\\.\\.\\.\\]\\.(${N})$`), form: "value", type: 1, name: 2 },
  { re: new RegExp(`^\\(\\*(${N})\\[\\.\\.\\.\\]\\)\\.(${N})$`), form: "pointer", type: 1, name: 2 },
  { re: new RegExp(`^\\(\\*(${N})\\)\\.(${N})$`), form: "pointer", type: 1, name: 2 },
  { re: new RegExp(`^(${N})\\[\\.\\.\\.\\]$`), form: "free", type: 0, name: 1 },
  { re: new RegExp(`^(${N})\\.(${N})$`), form: "value", type: 1, name: 2 },
  { re: new RegExp(`^(${N})$`), form: "free", type: 0, name: 1 },
];

function parentForm(symbol) {
  for (const { re, form, type, name } of PARENT_FORMS) {
    const m = re.exec(symbol);
    if (m) return { form, type: type === 0 ? null : m[type], name: m[name] };
  }
  return null;
}

// The repository name of a route, `frostyard/<name>`.
export function repoName(repo) {
  return repo.slice(repo.indexOf("/") + 1);
}

// The module part of a frame of the routed module, or null when the frame is
// not of that module ("Routed module"): `github.com/frostyard/<repo>/v<N>` when
// the frame goes on with `/v<N>` and then `.` or `/`, N 2 or more with no
// leading zero; else `github.com/frostyard/<repo>`.
export function routedModulePart(frame, name) {
  const base = `${FROSTYARD}${name}`;
  if (!frame.startsWith(base)) return null;
  const rest = frame.slice(base.length);
  if (!rest.startsWith(".") && !rest.startsWith("/")) return null;
  const major = /^\/v([2-9]|[1-9][0-9]+)(?=[./])/.exec(rest);
  return major ? `${base}/v${major[1]}` : base;
}

// Parses a frame of the routed module (steps 1 to 3). Returns null when the
// frame is not of that module, else { module, pkgpath, parsed } where parsed
// is null when no parent form fits (the frame cannot verify), or
// { form, type, name, depth, parent, published }. `published` is the parent
// frame with no closure suffix (rule 2).
export function parseRoutedFrame(frame, name) {
  const module = routedModulePart(frame, name);
  if (module === null) return null;
  const split = PKGPATH.exec(frame.slice(module.length));
  if (split === null) return { module, pkgpath: null, parsed: null };
  const pkgpath = split[1].slice(1);
  const symbol = split[2];

  // Step 2: remove 2 closure suffixes, then 1, then none.
  const candidates = [];
  const one = CLOSURE.test(symbol) ? symbol.replace(CLOSURE, "") : null;
  const two = one !== null && CLOSURE.test(one) ? one.replace(CLOSURE, "") : null;
  if (two !== null) candidates.push({ symbol: two, depth: 2 });
  if (one !== null) candidates.push({ symbol: one, depth: 1 });
  candidates.push({ symbol, depth: 0 });
  for (const candidate of candidates) {
    const parent = parentForm(candidate.symbol);
    if (parent === null) continue;
    const published = `${module}${pkgpath === "" ? "" : `/${pkgpath}`}.${candidate.symbol}`;
    return {
      module,
      pkgpath,
      parsed: { ...parent, depth: candidate.depth, parent: candidate.symbol, published },
    };
  }
  return { module, pkgpath, parsed: null };
}

// The `git grep -E` pattern of step 4 for a parsed parent.
export function grepPattern(parsed) {
  const receiver = "[A-Za-z_][A-Za-z0-9_]*";
  switch (parsed.form) {
    case "free":
      return `^func ${parsed.name}[[(]`;
    case "pointer":
      return `^func \\(${receiver} \\*?${parsed.type}(\\[[^]]*\\])?\\) ${parsed.name}[[(]`;
    case "value":
      return `^func \\(${receiver} ${parsed.type}(\\[[^]]*\\])?\\) ${parsed.name}[[(]`;
    default:
      throw new Error("unknown parent form");
  }
}

// The pathspecs of step 4: the `*.go` files directly in <pkgpath> (the
// repository root when there is none), not `_test.go`.
export function grepPathspecs(pkgpath) {
  const dir = pkgpath === "" ? "" : `${pkgpath}/`;
  return [`:(glob)${dir}*.go`, `:(glob,exclude)${dir}*_test.go`];
}

// The class of a raw frame with no tag:
//   { rule: "fixed", form }    rules 1, 4, 5, 6, 7: the form is final
//   { rule: "routed", module, pkgpath, parsed } rule 2 or 3, decided at a tag
//   null                       a frame that fits no rule (not a schema frame)
export function classifyFrame(frame, name) {
  if (typeof frame !== "string") return null;
  if (frame === "other") return { rule: "fixed", form: "other" };
  const routed = parseRoutedFrame(frame, name);
  if (routed !== null) return { rule: "routed", ...routed };
  if (frame.startsWith(FROSTYARD)) return { rule: "fixed", form: "frostyard" };
  if (frame.startsWith(`${GO_IMAP}.`) || frame.startsWith(`${GO_IMAP}/`)) return { rule: "fixed", form: "go-imap" };
  if (frame.startsWith("main.")) return { rule: "fixed", form: "main" };
  const first = /^([a-z]+)[./]/.exec(frame);
  if (first !== null && STDLIB_SET.has(first[1])) return { rule: "fixed", form: first[1] };
  return null;
}

// The published form of a frame for the problem key: the fixed form, or the
// parent frame of a routed frame. A routed frame with no parent form cannot
// verify, so every observation that holds it is dropped; its key uses
// `unverified` only so that the reader knows the key of such a held issue.
export function keyForm(frame, name) {
  const c = classifyFrame(frame, name);
  if (c === null) return null;
  if (c.rule === "fixed") return c.form;
  return c.parsed === null ? "unverified" : c.parsed.published;
}

// True when `frame` is a valid published frame of a problem routed to
// `frostyard/<name>`: a fixed word, or a parent frame of the routed module
// with no closure suffix that fits the grammar.
export function isPublishedFrame(frame, name) {
  if (typeof frame !== "string" || frame.length === 0 || frame.length > 160) return false;
  if (FIXED_FORMS.has(frame)) return true;
  const routed = parseRoutedFrame(frame, name);
  return routed !== null && routed.parsed !== null && routed.parsed.depth === 0 && routed.parsed.published === frame;
}
