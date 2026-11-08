// The mock GlitchTip and the small builders of the reader tests. It is a real
// node:http server on 127.0.0.1 (port 0), so the reader's own fetch, its
// timeout and its redirect refusal are the code under test. It serves the 2
// endpoints of the reader only, with Link paging, and it logs every method and
// path it got. No other host is reachable from a test.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { buildEvent } from "../../src/envelope.ts";

// An obvious fake, never a real token: 64 hex characters.
export const FAKE_TOKEN = "ab".repeat(32);

const EXAMPLES = new URL("../fixtures/examples/", import.meta.url);

// 1 report fixture of this repository.
export function exampleReport(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, EXAMPLES), "utf8"));
}

// 1 row of the events endpoint, shaped like GlitchTip's IssueEventSchema: the
// event id (never written out), the time, the tags and `context`, which is the
// event's `extra`.
// GlitchTip 6.2.6 serves the event list of an issue with the field names of
// its schema (`event_id`, `date_created`), not the camel case of the issue
// list; `camel` gives the Sentry form instead.
export function eventRow(report, dateCreated, camel = false) {
  const event = buildEvent(report);
  const tags = Object.entries(event.tags).map(([key, value]) => ({ key, value }));
  if (camel) return { eventID: event.event_id, dateCreated, tags, context: event.extra };
  return { event_id: event.event_id, date_created: dateCreated, tags, context: event.extra };
}

// 1 issue row of the issue list, with its events.
export function issueRow({ id, firstSeen, lastSeen = firstSeen, events = [] }) {
  return { id: String(id), firstSeen, lastSeen: lastSeen ?? firstSeen, events };
}

function link(url, rows, start, end, size) {
  const withCursor = (value) => {
    const next = new URL(url.href);
    next.searchParams.set("cursor", value);
    return next.href;
  };
  const parts = [];
  if (start > 0) {
    parts.push(`<${withCursor(String(Math.max(start - size, 0)))}>; rel="previous"; results="true"; cursor="${Math.max(start - size, 0)}"`);
  } else {
    parts.push(`<${url.href}>; rel="previous"; results="false"`);
  }
  if (end < rows.length) {
    parts.push(`<${withCursor(String(end))}>; rel="next"; results="true"; cursor="${end}"`);
  } else {
    parts.push(`<${url.href}>; rel="next"; results="false"`);
  }
  // GlitchTip 6.2.6 sets the header from a Python set, so its value is the
  // set's text: `{'<...>; rel="previous"; ..., <...>; rel="next"; ...'}`.
  return `{'${parts.join(", ")}'}`;
}

// A running mock. `plan` holds answers for the next requests (`{ status,
// headers, body }`), `handler` answers by URL, `log` keeps `{ method, path }`.
export async function startMock(options = {}) {
  const state = {
    token: options.token ?? FAKE_TOKEN,
    pageSize: options.pageSize ?? 50,
    issues: [],
    log: [],
    plan: [],
    handler: null,
    delayMs: 0,
    camelEvents: false,
  };

  const answer = (res, directive) => {
    const status = directive.status ?? 200;
    const headers = { ...(directive.headers ?? {}) };
    const body =
      directive.body === undefined ? "" : typeof directive.body === "string" ? directive.body : JSON.stringify(directive.body);
    if (state.delayMs > 0) {
      setTimeout(() => {
        res.writeHead(status, headers);
        res.end(body);
      }, state.delayMs);
      return;
    }
    res.writeHead(status, headers);
    res.end(body);
  };

  const paged = (res, url, rows) => {
    const start = Number(url.searchParams.get("cursor") ?? "0");
    const end = start + state.pageSize;
    answer(res, {
      status: 200,
      headers: { "content-type": "application/json", link: link(url, rows, start, end, state.pageSize) },
      body: rows.slice(start, end),
    });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    state.log.push({ method: req.method, path: `${url.pathname}${url.search}` });
    try {
      const planned = state.plan.shift();
      if (planned !== undefined) {
        answer(res, planned);
        return;
      }
      if (state.handler !== null) {
        const directive = state.handler(req, url);
        if (directive !== null && directive !== undefined) {
          answer(res, directive);
          return;
        }
      }
      if (req.headers.authorization !== `Bearer ${state.token}`) {
        answer(res, { status: 401 });
        return;
      }
      if (req.method !== "GET") {
        answer(res, { status: 405 });
        return;
      }
      if (url.pathname === "/api/0/organizations/frostyard/issues/") {
        paged(res, url, state.issues.map(issueRow));
        return;
      }
      const events = /^\/api\/0\/issues\/([0-9]+)\/events\/$/.exec(url.pathname);
      if (events !== null) {
        const issue = state.issues.find((one) => String(one.id) === events[1]);
        if (issue === undefined) {
          answer(res, { status: 404 });
          return;
        }
        // An entry that is already shaped like an event row is served as it is.
        paged(
          res,
          url,
          issue.events.map((one) => (one.context !== undefined ? one : eventRow(one.report, one.dateCreated, state.camelEvents))),
        );
        return;
      }
      answer(res, { status: 404 });
    } catch {
      // A broken case answers 500, so a test fails at once instead of hanging.
      answer(res, { status: 500 });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/api/0/`,
    port,
    state,
    log: state.log,
    setIssues(issues) {
      state.issues = [...issues];
    },
    planStatus(...directives) {
      state.plan.push(...directives);
    },
    setHandler(handler) {
      state.handler = handler;
    },
    setPageSize(size) {
      state.pageSize = size;
    },
    clearLog() {
      state.log.length = 0;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
