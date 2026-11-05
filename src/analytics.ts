// Workers Analytics Engine data points (docs/specs/analytics-points.md).
// Blobs hold only schema values. Never the report_id, never an IP, never a
// header value.
import { classOf, clientName, detailString } from "./dimensions.ts";
import type { Report } from "./types.ts";

// REPORTS blob order. The SQL of the weekly job reads these positions.
export const REPORT_BLOBS = [
  "kind",
  "image_id",
  "image_version",
  "secure",
  "client_name",
  "class",
  "app_id",
  "app_version",
  "install_age",
  "channel",
] as const;

export function reportPoint(report: Report): AnalyticsEngineDataPoint {
  return {
    indexes: [report.kind],
    blobs: [
      report.kind,
      report.image.id,
      report.image.version,
      String(report.secure),
      clientName(report),
      classOf(report),
      detailString(report, "app_id"),
      detailString(report, "app_version"),
      detailString(report, "install_age"),
      detailString(report, "channel"),
    ],
    doubles: [1],
  };
}

// The status class of a forward failure: "4xx", "5xx", "3xx", "timeout",
// "network" or "config" (a missing or malformed secret).
export type FailureClass = "3xx" | "4xx" | "5xx" | "timeout" | "network" | "config";

export function statusClass(status: number): FailureClass {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  return "3xx";
}

export function healthPoint(failure: FailureClass): AnalyticsEngineDataPoint {
  return {
    indexes: ["forward_failed"],
    blobs: ["forward_failed", failure],
    doubles: [1],
  };
}
