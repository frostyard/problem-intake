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

function parseOutput(text, code) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new GitHubError(code);
  }
}

// Returns the GitHub client of 1 run: api(), graphql(), searchIssues(), used(),
// remaining(), overSoft() and raiseBudget(). Each `gh` spawn is 1 call.
//
// 2 limits: `softLimit` stops the loop work and throws BudgetError, so that the
// reserved calls stay for the health issue; `limit` is the hard limit of the
// run. raiseBudget() lifts the soft limit to the hard 1 for the health issue.
export function createGitHub({ env = process.env, limit = 150, softLimit = limit } = {}) {
  let count = 0;
  let soft = Math.max(0, Math.min(softLimit, limit));

  function spawnCall(args, input) {
    if (count >= soft) throw new BudgetError();
    count += 1;
    try {
      return execFileSync("gh", args, {
        env,
        input,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        maxBuffer: MAX_BUFFER,
      });
    } catch (error) {
      const stderr = String(error?.stderr ?? "");
      const match = /HTTP ([0-9]{3})/.exec(stderr);
      if (match !== null) throw new GitHubError("http", Number(match[1]));
      if (error?.code === "ENOENT") throw new GitHubError("no_gh");
      throw new GitHubError("gh_failed");
    }
  }

  // `gh api <path> --method <M>`, with the JSON body on stdin. Returns the
  // parsed answer, or null for an empty answer.
  function api(path, { method = "GET", body } = {}) {
    const args = ["api", path, "--method", method];
    let input;
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
  function searchIssues(query) {
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
          "100",
        ],
        undefined,
      ),
      "search_output",
    );
    if (answer === null) return [];
    if (!Array.isArray(answer)) throw new GitHubError("search_shape");
    return answer;
  }

  return {
    api,
    graphql,
    searchIssues,
    used: () => count,
    remaining: () => Math.max(0, limit - count),
    // True when the loop work must stop: the reserve is all that is left.
    overSoft: () => count >= soft,
    // The health issue may use the reserve: the soft limit becomes the hard 1.
    raiseBudget: () => {
      soft = limit;
    },
    limit,
  };
}
