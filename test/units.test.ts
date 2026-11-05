import { describe, expect, it } from "vitest";
import { declaredLengthTooLarge } from "../src/body.ts";
import { buildEnvelope, buildEvent, eventId } from "../src/envelope.ts";
import { parseDsn, parseDsnMap } from "../src/forward.ts";
import { isJsonContentType, killSwitchOn } from "../src/report.ts";
import { isoWeek, previousWeek, sqlDateTime, weekRange } from "../src/week.ts";
import { EXAMPLES, example } from "./helpers.ts";

describe("buildEvent", () => {
  it.each([
    ["unit_failed", ["unit_failed", "exit-code", "user@.service"], "unit_failed exit-code user@.service"],
    ["update_stage_failed", ["update_stage_failed", "network"], "update_stage_failed network"],
    ["booted_older_image", ["booted_older_image", "boot_menu"], "booted_older_image boot_menu"],
    ["sysext_update_failed", ["sysext_update_failed", "failed", "docker"], "sysext_update_failed failed docker"],
    ["tpm_unlock", ["tpm_unlock", "recovery_key", "PCR_CHANGED"], "tpm_unlock recovery_key PCR_CHANGED"],
    ["integrity_error", ["integrity_error", "composefs"], "integrity_error composefs"],
    ["crash", ["crash", "SIGSEGV", "gnome-shell"], "crash SIGSEGV gnome-shell"],
  ])("fingerprints %s by kind, class and key", (kind, fingerprint, message) => {
    const event = buildEvent(example(kind));
    expect(event.fingerprint).toEqual(fingerprint);
    expect(event.message).toBe(message);
    expect(event.level).toBe("error");
  });

  it("fingerprints a Go panic by app and its first 3 frames", () => {
    const report = example("app_problem");
    const event = buildEvent(report);
    const frames = report.detail.frames as string[];
    expect(event.fingerprint).toEqual(["app_problem", "panic", "org.frostyard.nsl", ...frames.slice(0, 3)]);
    expect(event.message).toBe("app_problem panic org.frostyard.nsl");
    expect(event.tags).toMatchObject({ app_id: "org.frostyard.nsl", app_version: "0.9.2", class: "panic", component: "daemon" });
    expect(event.tags).not.toHaveProperty("frames");
  });

  it("fingerprints an app error by its code", () => {
    const report = example("app_problem");
    report.detail = { app_id: "org.frostyard.nsl", app_version: "0.9.2", runtime: "go", component: "cli", class: "error", code: "store.migrate_failed" };
    const event = buildEvent(report);
    expect(event.fingerprint).toEqual(["app_problem", "error", "org.frostyard.nsl", "store.migrate_failed"]);
    expect(event.message).toBe("app_problem error org.frostyard.nsl store.migrate_failed");
    expect(event.tags.code).toBe("store.migrate_failed");
  });

  it("fingerprints a Rust panic by its location, or by the app alone", () => {
    const report = example("app_problem");
    report.detail = { app_id: "org.frostyard.Frostmail", app_version: "1.0.0", runtime: "rust", component: "gui", class: "panic", location: "src/sync/imap.rs:214" };
    expect(buildEvent(report).fingerprint).toEqual(["app_problem", "panic", "org.frostyard.Frostmail", "src/sync/imap.rs:214"]);
    delete report.detail.location;
    expect(buildEvent(report).fingerprint).toEqual(["app_problem", "panic", "org.frostyard.Frostmail"]);
  });

  it.each(Object.keys(EXAMPLES).filter((k) => k !== "count"))("tags %s with every envelope value and no IP", (kind) => {
    const report = example(kind);
    const event = buildEvent(report);
    expect(event.tags).toMatchObject({
      report_id: report.report_id,
      week: report.week,
      image: report.image.id,
      image_version: report.image.version,
      secure: String(report.secure),
      kind: report.kind,
      client: report.client,
    });
    expect(event.event_id).toBe(eventId(report.report_id));
    expect(event.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(event.user).toEqual({ ip_address: null });
    expect(Object.keys(event).sort()).toEqual(["event_id", "extra", "fingerprint", "level", "message", "platform", "tags", "user"]);
    for (const [key, value] of Object.entries(event.tags)) {
      expect(key).toMatch(/^[a-z_]{1,32}$/);
      expect(value.length).toBeLessThanOrEqual(200);
    }
  });

  it("renames detail fields that would be unclear as tags", () => {
    expect(buildEvent(example("sysext_update_failed")).tags).toHaveProperty("feature_version");
    expect(buildEvent(example("integrity_error")).tags).toHaveProperty("count_bucket");
  });

  it("builds an envelope of 3 lines with the byte length of the payload", () => {
    const text = buildEnvelope(example("crash"));
    const lines = text.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    expect(JSON.parse(lines[1]).length).toBe(new TextEncoder().encode(lines[2]).byteLength);
  });
});

describe("DSN parsing", () => {
  it("turns a DSN into the envelope URL and the public key", () => {
    expect(parseDsn("https://0123456789abcdef0123456789abcdef@glitchtip.test.invalid:8443/42")).toEqual({
      url: "https://glitchtip.test.invalid:8443/api/42/envelope/",
      key: "0123456789abcdef0123456789abcdef",
    });
  });

  it("refuses a map with an unknown project name", () => {
    expect(parseDsnMap(JSON.stringify({ system: "https://0123456789abcdef0123456789abcdef@g.test.invalid/1", other: "x" }))).toBeNull();
    expect(parseDsnMap(undefined)).toBeNull();
    expect(parseDsnMap("null")).toBeNull();
  });
});

describe("request checks", () => {
  it.each([
    ["off", false],
    ["on", true],
    ["Off", true],
    ["", true],
    [undefined, true],
  ])("kill switch %j is on: %j", (value, on) => {
    expect(killSwitchOn(value)).toBe(on);
  });

  it.each([
    ["application/json", true],
    [" application/json ; charset=utf-8", true],
    ["application/json+x", false],
    ["text/json", false],
    [null, false],
  ])("content type %j is JSON: %j", (value, ok) => {
    expect(isJsonContentType(value)).toBe(ok);
  });

  it.each([
    [null, false],
    ["8192", false],
    ["8193", true],
    [" 9000 ", true],
    ["abc", false],
    ["-1", false],
    ["99999999999999999999", false],
  ])("declared length %j is too large: %j", (value, tooLarge) => {
    expect(declaredLengthTooLarge(value, 8192)).toBe(tooLarge);
  });

});

describe("ISO weeks", () => {
  it.each([
    [Date.UTC(2026, 10, 4), "2026-W45"],
    [Date.UTC(2021, 0, 3), "2020-W53"],
    [Date.UTC(2024, 11, 30), "2025-W01"],
    [Date.UTC(2026, 0, 1), "2026-W01"],
    [Date.UTC(2027, 0, 3, 23, 59), "2026-W53"],
  ])("week of %i is %s", (ms, week) => {
    expect(isoWeek(new Date(ms))).toBe(week);
  });

  it("gives the range of a week, and refuses a week that does not exist", () => {
    expect(weekRange("2026-W45")).toEqual({ start: Date.UTC(2026, 10, 2), end: Date.UTC(2026, 10, 9) });
    expect(weekRange("2020-W53")).toEqual({ start: Date.UTC(2020, 11, 28), end: Date.UTC(2021, 0, 4) });
    expect(weekRange("2021-W53")).toBeNull();
    expect(weekRange("2026-W54")).toBeNull();
    expect(weekRange("26-W01")).toBeNull();
  });

  it("gives the previous week", () => {
    expect(previousWeek(new Date(Date.UTC(2026, 10, 9, 3, 23)))).toBe("2026-W45");
    expect(previousWeek(new Date(Date.UTC(2026, 0, 5)))).toBe("2026-W01");
    expect(previousWeek(new Date(Date.UTC(2021, 0, 4)))).toBe("2020-W53");
  });

  it("formats SQL times in UTC", () => {
    expect(sqlDateTime(Date.UTC(2026, 10, 2))).toBe("2026-11-02 00:00:00");
  });
});
