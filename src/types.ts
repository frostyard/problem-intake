// The report document after schema validation (schema/v1.json,
// frostyard/core docs/specs/problem-report.md). Only validated documents
// reach these types.

export type Kind =
  | "unit_failed"
  | "update_stage_failed"
  | "booted_older_image"
  | "sysext_update_failed"
  | "tpm_unlock"
  | "integrity_error"
  | "crash"
  | "app_problem"
  | "count";

export type DetailValue = string | number | boolean | string[];

export interface Report {
  schema: "frostyard.problem/1";
  report_id: string;
  week: string;
  image: { id: string; version: string };
  secure: boolean;
  client: string;
  kind: Kind;
  detail: Record<string, DetailValue>;
}
