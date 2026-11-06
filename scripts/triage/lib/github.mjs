// The GitHub calls of the triage job (docs/specs/triage.md, "The publisher"):
// `gh` with the existing machine sign-in, 1 counter for the whole run, and a
// budget that stops the work before the reserve for the health issue.
//
// A diagnostic never holds stdout or stderr of `gh`: only a fixed reason code.
//
// node: builtins only: the team VM runs the job with no `npm`.
import { execFileSync } from "node:child_process";

// The limit of the run is used up: the rest of the work waits for the next run.
export class BudgetError extends Error {
  constructor() {
    super("github: budget");
    this.name = "BudgetError";
    this.code = "budget";
  }
}

// The run's work deadline passed: no work call starts.
export class DeadlineError extends Error {
  constructor() {
    super("github: deadline");
    this.name = "DeadlineError";
    this.code = "deadline";
  }
}

// `gh` failed. `status` is the HTTP status of a `gh api` error, or null.
export class GitHubError extends Error {
  constructor(code, status = null) {
    super(`github: ${code}`);
    this.name = "GitHubError";
    this.code = code;
    this.status = status;
  }
}

const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_CALL_MS = 60_000;
const MIN_CALL_MS = 1_000;
const HEALTH_RESERVE_MS = 60_000;
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_TOTAL = 1000;
const SEARCH_MAX_PAGES = 11;

function parseOutput(text, code) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new GitHubError(code);
  }
}

// The parsed stdout of a failed call, or null. `gh` exits non-zero when a
// GraphQL answer holds errors, and prints the answer on stdout.
function failedStdout(error) {
  const text = String(error?.stdout ?? "").trim();
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Returns the GitHub client of 1 run: api(), graphql(), searchIssues(), used(),
// remaining(), overSoft() and raiseBudget(). Each `gh` spawn is 1 call.
//
// 2 limits: `softLimit` stops the loop work and throws BudgetError, so that the
// reserved calls stay for the health issue; `limit` is the hard limit of the
// run. raiseBudget() lifts the soft limit to the hard 1 for the health issue.
export function createGitHub({ env = process.env, limit = 150, softLimit = limit, clock = null, deadlineAt = null } = {}) {
  let count = 0;
  let soft = Math.max(0, Math.min(softLimit, limit));
  // The health phase runs after the deadline, in the 60 second reserve.
  let reserve = false;

  function now() {
    return clock === null ? Date.now() : clock();
  }

  // The time 1 call may take. The work phase gets the time left before the
  // deadline only (at most 60 seconds); at or below 0 the call does not start.
  // The health phase adds its reserve of 60 seconds.
  function callTimeout() {
    if (deadlineAt === null) return MAX_CALL_MS;
    const left = deadlineAt - now() + (reserve ? HEALTH_RESERVE_MS : 0);
    if (left <= 0) throw new DeadlineError();
    return Math.max(MIN_CALL_MS, Math.min(MAX_CALL_MS, left));
  }

  function spawnCall(args, input) {
    if (count >= soft) throw new BudgetError();
    // The timeout is computed before the count, so a refused call is no call.
    const timeout = callTimeout();
    count += 1;
    try {
      return execFileSync("gh", args, {
        env,
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: MAX_BUFFER,
        timeout,
      });
    } catch (error) {
      if (error?.signal !== undefined && error?.signal !== null) throw new GitHubError("timeout");
      const stderr = String(error?.stderr ?? "");
      const match = /HTTP ([0-9]{3})/.exec(stderr);
      if (match !== null) throw new GitHubError("http", Number(match[1]));
      if (error?.code === "ENOENT") throw new GitHubError("no_gh");
      // A GraphQL answer with errors: keep the answer, the caller decides.
      const answer = failedStdout(error);
      if (answer !== null && typeof answer === "object" && !Array.isArray(answer) && Object.hasOwn(answer, "data")) {
        return JSON.stringify(answer);
      }
      throw new GitHubError("gh_failed");
    }
  }

  // `gh api <path> --method <M>`, with the JSON body on stdin. Returns the
  // parsed answer, or null for an empty answer.
  function api(path, { method = "GET", body, fields } = {}) {
    const args = ["api", path, "--method", method];
    let input;
    if (fields !== undefined) {
      for (const [name, value] of Object.entries(fields)) args.push("-f", `${name}=${value}`);
    }
    if (body !== undefined) {
      args.push("--input", "-");
      input = JSON.stringify(body);
    }
    return parseOutput(spawnCall(args, input), "api_output");
  }

  // `gh api graphql -f query=... -F name=value`.
  function graphql(query, variables = {}) {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [name, value] of Object.entries(variables)) args.push("-F", `${name}=${value}`);
    const answer = parseOutput(spawnCall(args, undefined), "graphql_output");
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) throw new GitHubError("graphql_shape");
    // A deleted or transferred issue comes back as a null alias plus an error
    // of type NOT_FOUND: the answer holds the other issues, so it is used.
    if (answer.errors !== undefined) {
      const errors = Array.isArray(answer.errors) ? answer.errors : [];
      const notFound = errors.length > 0 && errors.every((error) => error?.type === "NOT_FOUND");
      if (!notFound || answer.data === undefined || answer.data === null) throw new GitHubError("graphql_errors");
    }
    return answer.data ?? null;
  }

  // The one search command of the spec: the job issues of the organization.
  // `limit` is 100 for a key lookup and 1000 for the rebuild of published.json.
  function searchIssues(query, { limit: max = 100 } = {}) {
    const answer = parseOutput(
      spawnCall(
        [
          "search",
          "issues",
          query,
          "--owner",
          "frostyard",
          "--author",
          "frostyard-machines",
          "--label",
          "problem-report",
          "--json",
          "repository,number,title,body,state",
          "--limit",
          String(max),
        ],
        undefined,
      ),
      "search_output",
    );
    if (answer === null) return [];
    if (!Array.isArray(answer)) throw new GitHubError("search_shape");
    return answer;
  }

  // The `search/issues` API, 1 call for each page of 100, until every hit is
  // read (the collected items reach total_count) or a page is short. Returns
  // { items, totalCount }, or null when the read is incomplete: a page with
  // incomplete_results, a hit count over GitHub's 1000 cap, a short page that
  // leaves hits unread, or a page the gate stopped.
  function searchIssuePages(query, { maxItems = SEARCH_MAX_TOTAL, gate = null } = {}) {
    const items = [];
    let totalCount = 0;
    for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
      if (gate !== null && !gate()) return null;
      let answer;
      try {
        answer = api("search/issues", {
          method: "GET",
          fields: { q: query, per_page: SEARCH_PER_PAGE, page },
        });
      } catch (error) {
        if (error instanceof BudgetError || error instanceof DeadlineError) throw error;
        return null;
      }
      if (answer === null || !Array.isArray(answer.items)) return null;
      if (answer.incomplete_results === true) return null;
      if (page === 1) {
        totalCount = Number(answer.total_count ?? 0);
        if (!Number.isSafeInteger(totalCount) || totalCount < 0 || totalCount > maxItems) return null;
      }
      items.push(...answer.items);
      if (items.length >= totalCount) break;
      if (answer.items.length < SEARCH_PER_PAGE) break;
    }
    // A short page, or the page cap, left hits unread: the read is incomplete.
    if (items.length < totalCount) return null;
    return { items, totalCount };
  }

  return {
    api,
    graphql,
    searchIssuePages,
    searchIssues,
    used: () => count,
    remaining: () => Math.max(0, limit - count),
    // True when the loop work must stop: the reserve is all that is left.
    overSoft: () => count >= soft,
    // The health phase may use the whole run: the soft limit becomes the hard
    // 1, and its calls get the 60 second reserve past the deadline.
    raiseBudget: () => {
      soft = limit;
      reserve = true;
    },
    limit,
  };
}
