// The Sentry event and envelope that the Worker sends to GlitchTip
// (docs/design/intake.md). Built only from schema values of a validated
// report. No request data, no client time, no IP, no server_name. The
// report_id is only the event_id (32-hex form), never a tag: GlitchTip keeps
// tag values for ever (ADR-0005).
//
// This module uses only erasable TypeScript, so Node can import it directly
// (scripts/glitchtip-send-event.mjs in the GlitchTip CI job).
import { classOf, clientName, detailString } from "./dimensions.ts";
import type { Report } from "./types.ts";
import { VERSION } from "./version.ts";

export const SENTRY_CLIENT = `frostyard-problem-intake/${VERSION}`;

export interface SentryEvent {
  event_id: string;
  level: "error";
  platform: "other";
  message: string;
  tags: Record<string, string>;
  fingerprint: string[];
  extra: { detail: Report["detail"] };
  user: { ip_address: null };
}

// Detail fields whose names would be unclear as a tag of their own.
const TAG_RENAME: Record<string, string> = {
  version: "feature_version",
  count: "count_bucket",
};

export function eventId(reportId: string): string {
  return reportId.replaceAll("-", "");
}

// The part of the fingerprint after kind and class.
function groupKey(report: Report): string[] {
  switch (report.kind) {
    case "unit_failed":
      return [detailString(report, "unit")];
    case "sysext_update_failed":
      return [detailString(report, "feature")];
    case "tpm_unlock":
      return [detailString(report, "tpm_rc")];
    case "crash":
      return [detailString(report, "exe")];
    case "app_problem": {
      const appId = detailString(report, "app_id");
      const code = detailString(report, "code");
      if (code !== "") return [appId, code];
      const frames = report.detail.frames;
      if (Array.isArray(frames)) return [appId, ...frames.slice(0, 3)];
      const location = detailString(report, "location");
      return location === "" ? [appId] : [appId, location];
    }
    default:
      return [];
  }
}

export function buildEvent(report: Report): SentryEvent {
  const cls = classOf(report);
  const tags: Record<string, string> = {
    week: report.week,
    image: report.image.id,
    image_version: report.image.version,
    secure: String(report.secure),
    kind: report.kind,
    client: report.client,
    client_name: clientName(report),
  };
  for (const [field, value] of Object.entries(report.detail)) {
    if (Array.isArray(value)) continue;
    tags[TAG_RENAME[field] ?? field] = String(value);
  }
  const key = groupKey(report);
  const fingerprint = [report.kind, cls, ...key];
  // The message is the issue title in GlitchTip: kind, class and the short
  // group key (for an app: the app and its code, no frames), all schema values.
  const shortKey =
    report.kind === "app_problem" ? [detailString(report, "app_id"), detailString(report, "code")] : key;
  const message = [report.kind, cls, ...shortKey].filter((part) => part !== "").join(" ");
  return {
    event_id: eventId(report.report_id),
    level: "error",
    platform: "other",
    message,
    tags,
    fingerprint,
    extra: { detail: report.detail },
    user: { ip_address: null },
  };
}

// A Sentry envelope with 1 event item:
// envelope header, item header, item payload, each on 1 line.
export function buildEnvelope(report: Report): string {
  const event = buildEvent(report);
  const payload = JSON.stringify(event);
  const length = new TextEncoder().encode(payload).byteLength;
  const envelopeHeader = JSON.stringify({ event_id: event.event_id });
  const itemHeader = JSON.stringify({ type: "event", content_type: "application/json", length });
  return `${envelopeHeader}\n${itemHeader}\n${payload}\n`;
}
