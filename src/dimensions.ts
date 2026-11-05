// Values derived from a validated report. Every value is a schema value:
// an enum, a pattern-checked string, or a fixed name. No request data.
import type { Kind, Report } from "./types.ts";

// The class-like detail field of each kind (docs/specs/analytics-points.md).
export const CLASS_FIELD: Record<Kind, string | null> = {
  unit_failed: "result",
  update_stage_failed: "error_class",
  booted_older_image: "how",
  sysext_update_failed: "outcome",
  tpm_unlock: "outcome",
  integrity_error: "subsystem",
  crash: "signal",
  app_problem: "class",
  count: null,
};

export function classOf(report: Report): string {
  const field = CLASS_FIELD[report.kind];
  if (field === null) return "";
  const value = report.detail[field];
  return typeof value === "string" ? value : "";
}

// The client name without its version: "chairlift" or "snosi-health".
export function clientName(report: Report): string {
  return report.client.split("/", 1)[0];
}

export function detailString(report: Report, field: string): string {
  const value = report.detail[field];
  return typeof value === "string" ? value : "";
}
