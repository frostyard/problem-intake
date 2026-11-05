/// <reference types="vite/client" />
// The Worker never sends the report_id as a GlitchTip tag (ADR-0005): GlitchTip
// keeps tag values for ever (issue_events_tagvalue has no cleanup). The
// event_id carries the report_id, in its 32-hex form, and nothing else does.
import { describe, expect, it } from "vitest";
import { buildEnvelope, buildEvent } from "../src/envelope.ts";
import type { Report } from "../src/types.ts";

// Every fixture file, read by the bundler, so a new fixture is checked too.
const fixtures = import.meta.glob<Report>("./fixtures/examples/*.json", { eager: true, import: "default" });

describe("the report_id in the outgoing event", () => {
  const cases = Object.entries(fixtures).map(([path, report]) => [path.replace(/^.*\//, ""), report] as const);

  it("covers every fixture", () => {
    expect(cases.length).toBeGreaterThanOrEqual(9);
  });

  it.each(cases)("%s: no tag holds the report_id; event_id is its 32-hex form", (_name, fixture) => {
    const report = structuredClone(fixture);
    const hyphen = report.report_id;
    const hex = hyphen.replaceAll("-", "");
    expect(hyphen).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const event = buildEvent(report);
    for (const [key, value] of Object.entries(event.tags)) {
      for (const form of [hyphen, hex]) {
        expect(key, `tag key ${key}`).not.toContain(form);
        expect(value, `tag ${key}`).not.toContain(form);
      }
    }
    expect(Object.keys(event.tags)).not.toContain("report_id");
    expect(event.event_id).toBe(hex);
    // In the whole envelope, only the envelope header and the event_id hold it.
    const envelope = buildEnvelope(report);
    expect(envelope.split(hyphen)).toHaveLength(1);
    expect(envelope.split(hex)).toHaveLength(3);
    expect(JSON.parse(envelope.split("\n")[0])).toEqual({ event_id: hex });
  });
});
