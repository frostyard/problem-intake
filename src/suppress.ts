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
//
// Bound rule. A reader also knows that every listed value is an integer of 1
// or more. The slack of a set of suppressed values is the sum of (value - 1)
// over them. When a group total is published and the slack of its suppressed
// cells is 0, every suppressed cell is exactly 1; and when the grand total is
// published and the slack of the suppressed cells of all suppressed-total
// groups is 0, every suppressed total sits at its lower bound (published
// cells + 1 for each suppressed cell). In both cases 1 more part of that
// equation is suppressed (the smallest published part, else the total), and
// the loop goes on to a fixed point.
//
// Why this is sufficient (docs/specs/stats.md, rule 7). At the fixed point:
// - A group with a published total and k suppressed cells has k >= 2 (linear
//   rule) and a cell sum S >= k + 1 (bound rule). Its cells occur in no other
//   equation, so each can be 1 or 2 with the others >= 1.
// - A group with a suppressed total T has at least 1 suppressed cell (linear
//   rule), so any T >= L = published cells + suppressed cells is possible.
// - With a published grand total, at least 2 totals are suppressed (linear
//   rule) and their sum R >= (sum of L) + 1 (bound rule): each total can be L
//   or L + 1, the others take the rest, and so each of its cells can be 1 or 2.
// - With a suppressed grand total, at least 1 group total is suppressed
//   (linear rule) and has no upper bound, so it and the grand total can move.
// So every suppressed value has at least 2 possible integer values.

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

// The sum of (value - 1) over the suppressed items: 0 means that a reader
// who knows their sum knows that each one is 1.
function slack(items: Item[]): number {
  return items.filter((item) => item.suppressed).reduce((sum, item) => sum + item.value - 1, 0);
}

// Suppress 1 more part of an equation (the smallest published part), or its
// total when no part is published.
function widen(total: Item, parts: Item[]): boolean {
  const pick = parts.filter((item) => !item.suppressed).sort(byValueThenKey)[0] ?? total;
  if (pick.suppressed) return false;
  pick.suppressed = true;
  return true;
}

// The bound rule for a group with a published total.
function protectGroupBound(total: Item, cells: Item[]): boolean {
  if (total.suppressed || !cells.some((cell) => cell.suppressed)) return false;
  return slack(cells) === 0 && widen(total, cells);
}

// The bound rule for a published grand total.
function protectGrandBound(grand: Item, groups: { total: Item; cells: Item[] }[]): boolean {
  const hidden = groups.filter((group) => group.total.suppressed);
  if (grand.suppressed || hidden.length === 0) return false;
  const total = hidden.reduce((sum, group) => sum + slack(group.cells), 0);
  return (
    total === 0 &&
    widen(
      grand,
      groups.map((group) => group.total),
    )
  );
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
    // The bound rules run only at a fixed point of the linear rule: a value
    // that the linear rule is about to suppress adds slack, and an earlier
    // bound check would suppress more than it must.
    if (changed) continue;
    for (const group of groups) {
      if (protectGroupBound(group.total, group.cells)) changed = true;
    }
    if (!changed && protectGrandBound(grand, groups)) changed = true;
  }

  const published: PublishedTable = { total: grand.suppressed ? null : grand.value, groups: {} };
  for (const group of groups) {
    const cells: Record<string, number | null> = {};
    for (const cell of group.cells) cells[cell.key] = cell.suppressed ? null : cell.value;
    published.groups[group.key] = { total: group.total.suppressed ? null : group.total.value, cells };
  }
  return published;
}
