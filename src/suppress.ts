// Small-cell and complementary suppression for the public aggregates
// (docs/specs/stats.md, plan T857 section 5, Tamalane k2).
//
// A table has groups; each group has cells. Each group total is the sum of
// its cells, and the grand total is the sum of the group totals. A value from
// 1 to MIN_CELL - 1 is never published (null). When an equation (a group, or
// the grand total) holds exactly 1 suppressed value, that value could be
// found by subtraction, so 1 more value of that equation is suppressed: the
// smallest published cell (or group total), and the equation's total only
// when nothing else is left. This repeats over both levels until nothing
// changes. Zero cells are absent.

export const MIN_CELL = 5;

export type RawTable = Record<string, Record<string, number>>;

export interface PublishedGroup {
  total: number | null;
  cells: Record<string, number | null>;
}

export interface PublishedTable {
  total: number | null;
  groups: Record<string, PublishedGroup>;
}

interface Item {
  value: number;
  key: string;
  suppressed: boolean;
}

function isSmall(value: number): boolean {
  return value >= 1 && value < MIN_CELL;
}

// Keys are unique inside 1 equation, so the order is total.
function byValueThenKey(a: Item, b: Item): number {
  return a.value - b.value || (a.key < b.key ? -1 : 1);
}

// Make 1 equation safe: when exactly 1 of its values is suppressed, suppress
// the smallest published part, or the total when no part is published.
// Returns true when it changed anything.
function protect(total: Item, parts: Item[]): boolean {
  const all = [total, ...parts];
  if (all.filter((item) => item.suppressed).length !== 1) return false;
  const candidates = parts.filter((item) => !item.suppressed).sort(byValueThenKey);
  // With no published part left, the 1 suppressed value is a part, so the
  // total is still published: suppress it.
  const pick = candidates[0] ?? total;
  pick.suppressed = true;
  return true;
}

export function suppressTable(raw: RawTable): PublishedTable {
  const groupKeys = Object.keys(raw).sort();
  const groups: { key: string; total: Item; cells: Item[] }[] = [];
  for (const key of groupKeys) {
    const cells: Item[] = Object.keys(raw[key])
      .sort()
      .filter((cell) => raw[key][cell] > 0)
      .map((cell) => ({ key: cell, value: raw[key][cell], suppressed: isSmall(raw[key][cell]) }));
    if (cells.length === 0) continue;
    const value = cells.reduce((sum, cell) => sum + cell.value, 0);
    groups.push({ key, cells, total: { key, value, suppressed: isSmall(value) } });
  }
  const grandValue = groups.reduce((sum, group) => sum + group.total.value, 0);
  const grand: Item = { key: "", value: grandValue, suppressed: isSmall(grandValue) };

  let changed = true;
  while (changed) {
    changed = false;
    for (const group of groups) {
      if (protect(group.total, group.cells)) changed = true;
    }
    if (
      protect(
        grand,
        groups.map((group) => group.total),
      )
    ) {
      changed = true;
    }
  }

  const published: PublishedTable = { total: grand.suppressed ? null : grand.value, groups: {} };
  for (const group of groups) {
    const cells: Record<string, number | null> = {};
    for (const cell of group.cells) cells[cell.key] = cell.suppressed ? null : cell.value;
    published.groups[group.key] = { total: group.total.suppressed ? null : group.total.value, cells };
  }
  return published;
}
