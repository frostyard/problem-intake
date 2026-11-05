// The public weekly aggregates, frostyard.problem-stats/1 (docs/specs/stats.md).
// Rows come from the Analytics Engine SQL API and are validated against the
// schema's enums and patterns before use; a bad row fails the whole job.
import schema from "../schema/v1.json";
import { CLASS_FIELD } from "./dimensions.ts";
import { MIN_CELL, type PublishedTable, type RawTable, suppressTable } from "./suppress.ts";
import { countValue } from "./sql.ts";
import type { Kind } from "./types.ts";

export const STATS_SCHEMA = "frostyard.problem-stats/1";
export const INDEX_SCHEMA = "frostyard.problem-stats-index/1";

const KINDS: readonly string[] = schema.properties.kind.enum;
const IMAGE_IDS: readonly string[] = schema.properties.image.properties.id.enum;
const APP_IDS: readonly string[] = schema.$defs.app_problem.properties.app_id.enum;
const IMAGE_VERSION = /^[0-9]{14}$/;

function classValues(kind: Kind): readonly string[] {
  const field = CLASS_FIELD[kind];
  if (field === null) return [""];
  const def = (schema.$defs as unknown as Record<string, { properties: Record<string, { enum?: string[] }> }>)[kind];
  return def.properties[field].enum ?? [];
}

export interface StatsRow {
  kind: Kind;
  image_id: string;
  image_version: string;
  class: string;
  app_id: string;
  n: number;
}

export class RowError extends Error {
  constructor() {
    super("invalid_row");
    this.name = "RowError";
  }
}

export function validateRow(row: unknown): StatsRow {
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new RowError();
  const r = row as Record<string, unknown>;
  const { kind, image_id, image_version, class: cls, app_id } = r;
  const n = countValue(r.n);
  if (typeof kind !== "string" || !KINDS.includes(kind)) throw new RowError();
  if (typeof image_id !== "string" || !IMAGE_IDS.includes(image_id)) throw new RowError();
  if (typeof image_version !== "string" || !IMAGE_VERSION.test(image_version)) throw new RowError();
  if (typeof cls !== "string" || !classValues(kind as Kind).includes(cls)) throw new RowError();
  const appOk = kind === "app_problem" ? typeof app_id === "string" && APP_IDS.includes(app_id) : app_id === "";
  if (!appOk || n === null) throw new RowError();
  return { kind: kind as Kind, image_id, image_version, class: cls, app_id: app_id as string, n };
}

function add(table: RawTable, group: string, cell: string, n: number): void {
  table[group] ??= {};
  table[group][cell] = (table[group][cell] ?? 0) + n;
}

export interface StatsTable extends PublishedTable {
  group_by: string;
  cell_by: string;
}

export interface StatsDocument {
  schema: typeof STATS_SCHEMA;
  week: string;
  min_cell: number;
  tables: {
    reports: StatsTable;
    app_problems: StatsTable;
    installs: StatsTable;
  };
}

// 3 tables with no shared counts, so no table can be subtracted from another:
// system reports (all kinds but app_problem and count) by image and kind, app
// problems by app and class, installs (count) by image and image version.
export function buildStats(week: string, rows: StatsRow[]): StatsDocument {
  const reports: RawTable = {};
  const apps: RawTable = {};
  const installs: RawTable = {};
  for (const row of rows) {
    if (row.kind === "count") add(installs, row.image_id, row.image_version, row.n);
    else if (row.kind === "app_problem") add(apps, row.app_id, row.class, row.n);
    else add(reports, row.image_id, row.kind, row.n);
  }
  return {
    schema: STATS_SCHEMA,
    week,
    min_cell: MIN_CELL,
    tables: {
      reports: { group_by: "image", cell_by: "kind", ...suppressTable(reports) },
      app_problems: { group_by: "app_id", cell_by: "class", ...suppressTable(apps) },
      installs: { group_by: "image", cell_by: "image_version", ...suppressTable(installs) },
    },
  };
}

export interface StatsIndex {
  schema: typeof INDEX_SCHEMA;
  weeks: string[];
}
