// The suppression guard (docs/specs/stats.md). An independent check: build the
// linear system of every published value (each group total is the sum of its
// cells, the grand total is the sum of the group totals) and solve it exactly
// over the rationals. A suppressed value that the system fixes to 1 value is
// a leak, and the test fails.
import { describe, expect, it } from "vitest";
import { MIN_CELL, type PublishedTable, type RawTable, suppressTable } from "../src/suppress.ts";

// ---- Exact rational arithmetic with BigInt --------------------------------

type Q = { n: bigint; d: bigint };

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function q(n: bigint, d = 1n): Q {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}
const sub = (a: Q, b: Q): Q => q(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Q, b: Q): Q => q(a.n * b.n, a.d * b.d);
const div = (a: Q, b: Q): Q => q(a.n * b.d, a.d * b.n);
const isZero = (a: Q): boolean => a.n === 0n;

// Reduced row echelon form, in place. Returns the pivot column of each row.
function rref(rows: Q[][], columns: number): number[] {
  const pivots: number[] = [];
  let r = 0;
  for (let c = 0; c < columns && r < rows.length; c++) {
    const p = rows.findIndex((row, i) => i >= r && !isZero(row[c]));
    if (p === -1) continue;
    [rows[r], rows[p]] = [rows[p], rows[r]];
    const pivot = rows[r][c];
    rows[r] = rows[r].map((x) => div(x, pivot));
    for (let i = 0; i < rows.length; i++) {
      if (i !== r && !isZero(rows[i][c])) {
        const factor = rows[i][c];
        rows[i] = rows[i].map((x, j) => sub(x, mul(factor, rows[r][j])));
      }
    }
    pivots.push(c);
    r += 1;
  }
  return pivots;
}

// Every suppressed value that the published values determine uniquely.
// The unknowns are the suppressed values; the right-hand side uses the
// published values.
function determinedSuppressed(published: PublishedTable): string[] {
  const unknowns: string[] = [];
  const index = (name: string) => {
    if (!unknowns.includes(name)) unknowns.push(name);
    return unknowns.indexOf(name);
  };
  // 1 equation: total - sum(parts) = 0, as terms (name, coefficient, value).
  type Term = { name: string; coef: bigint; value: number | null };
  const equations: Term[][] = [];
  const groupNames = Object.keys(published.groups);
  for (const g of groupNames) {
    const group = published.groups[g];
    const terms: Term[] = [{ name: `T:${g}`, coef: 1n, value: group.total }];
    for (const [c, value] of Object.entries(group.cells)) terms.push({ name: `C:${g}:${c}`, coef: -1n, value });
    equations.push(terms);
  }
  const grand: Term[] = [{ name: "G", coef: 1n, value: published.total }];
  for (const g of groupNames) grand.push({ name: `T:${g}`, coef: -1n, value: published.groups[g].total });
  equations.push(grand);

  for (const terms of equations) for (const t of terms) if (t.value === null) index(t.name);
  if (unknowns.length === 0) return [];
  const rows: Q[][] = equations.map((terms) => {
    const row = Array.from({ length: unknowns.length + 1 }, () => q(0n));
    let rhs = 0n;
    for (const t of terms) {
      if (t.value === null) row[unknowns.indexOf(t.name)] = q(t.coef);
      else rhs -= t.coef * BigInt(t.value);
    }
    row[unknowns.length] = q(rhs);
    return row;
  });
  const pivots = rref(rows, unknowns.length);
  const leaks: string[] = [];
  pivots.forEach((col, r) => {
    const others = rows[r].slice(0, unknowns.length).some((x, j) => j !== col && !isZero(x));
    if (!others) leaks.push(unknowns[col]);
  });
  return leaks;
}

function publishedNumbers(table: PublishedTable): number[] {
  const out: number[] = [];
  if (table.total !== null) out.push(table.total);
  for (const group of Object.values(table.groups)) {
    if (group.total !== null) out.push(group.total);
    for (const value of Object.values(group.cells)) if (value !== null) out.push(value);
  }
  return out;
}

function assertSafe(raw: RawTable): PublishedTable {
  const published = suppressTable(raw);
  expect(determinedSuppressed(published)).toEqual([]);
  for (const value of publishedNumbers(published)) {
    expect(value === 0 || value >= MIN_CELL).toBe(true);
  }
  // Published values are the true values.
  for (const [g, group] of Object.entries(published.groups)) {
    const cells = Object.entries(raw[g]).filter(([, v]) => v > 0);
    const total = cells.reduce((s, [, v]) => s + v, 0);
    if (group.total !== null) expect(group.total).toBe(total);
    for (const [c, value] of Object.entries(group.cells)) if (value !== null) expect(value).toBe(raw[g][c]);
  }
  return published;
}

// A seeded generator (mulberry32), so a failure is reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the leak checker", () => {
  it("finds a value that subtraction gives back", () => {
    // Only x hidden: x = total - y.
    const naive: PublishedTable = { total: 13, groups: { a: { total: 13, cells: { x: null, y: 10 } } } };
    expect(determinedSuppressed(naive)).toEqual(["C:a:x"]);
  });

  it("finds a value hidden across 2 levels", () => {
    // x and a's total hidden, but G - b = a, then a - y = x.
    const naive: PublishedTable = {
      total: 33,
      groups: { a: { total: null, cells: { x: null, y: 10 } }, b: { total: 20, cells: { z: 20 } } },
    };
    expect(determinedSuppressed(naive).sort()).toEqual(["C:a:x", "T:a"]);
  });
});

describe("suppressTable", () => {
  it("publishes a table with no small value as is", () => {
    expect(assertSafe({ a: { x: 5, y: 9 }, b: { z: 12 } })).toEqual({
      total: 26,
      groups: { a: { total: 14, cells: { x: 5, y: 9 } }, b: { total: 12, cells: { z: 12 } } },
    });
  });

  it("hides 1 small cell and its smallest neighbor", () => {
    const published = assertSafe({ a: { x: 2, y: 7, z: 30 } });
    expect(published.groups.a).toEqual({ total: 39, cells: { x: null, y: null, z: 30 } });
  });

  it("hides 1 small group total and another group total", () => {
    const published = assertSafe({ a: { x: 3 }, b: { y: 8 }, c: { z: 50 } });
    expect(published.groups.a.total).toBeNull();
    expect(published.groups.b.total).toBeNull();
    expect(published.groups.c.total).toBe(50);
    expect(published.total).toBe(61);
  });

  it("hides everything when every value is small", () => {
    const published = assertSafe({ a: { x: 1 }, b: { y: 2 } });
    expect(published).toEqual({
      total: null,
      groups: { a: { total: null, cells: { x: null } }, b: { total: null, cells: { y: null } } },
    });
  });

  it("handles a group with 1 cell", () => {
    assertSafe({ a: { x: 4 }, b: { y: 6, z: 9 } });
    assertSafe({ a: { x: 40 }, b: { y: 1, z: 9 } });
  });

  it("leaves zero cells and empty groups out", () => {
    expect(assertSafe({ a: { x: 0, y: 9 }, b: { z: 0 } })).toEqual({
      total: 9,
      groups: { a: { total: 9, cells: { y: 9 } } },
    });
    expect(suppressTable({})).toEqual({ total: 0, groups: {} });
  });

  it("is safe on 3000 seeded random tables", () => {
    const next = rng(0x7857);
    let suppressedSomething = 0;
    for (let t = 0; t < 3000; t++) {
      const raw: RawTable = {};
      const groups = 1 + Math.floor(next() * 6);
      for (let g = 0; g < groups; g++) {
        const cells: Record<string, number> = {};
        const count = 1 + Math.floor(next() * 6);
        for (let c = 0; c < count; c++) {
          const r = next();
          cells[`c${c}`] = r < 0.15 ? 0 : r < 0.55 ? 1 + Math.floor(next() * 4) : 5 + Math.floor(next() * 40);
        }
        raw[`g${g}`] = cells;
      }
      const published = assertSafe(raw);
      if (JSON.stringify(published).includes("null")) suppressedSomething += 1;
    }
    // The generator must exercise suppression, not only clean tables.
    expect(suppressedSomething).toBeGreaterThan(1500);
  });
});

// ---- Exact integer check (the bound "every listed value is >= 1") ---------
//
// Enumerate every integer assignment >= 1 of the suppressed values that is
// consistent with the published values and the 2 levels of equations, and
// return the suppressed values that have only 1 possible value. Upper bounds:
// with a published grand total the enumeration is exact; with a suppressed
// grand total the totals have no upper bound, so the window stops at the true
// total + 2 (a value with 2 possible values inside the window has 2 in all).

// Every way to write `sum` as `parts` integers >= 1.
function* compositions(sum: number, parts: number): Generator<number[]> {
  if (parts === 0) {
    if (sum === 0) yield [];
    return;
  }
  if (parts === 1) {
    if (sum >= 1) yield [sum];
    return;
  }
  for (let first = 1; first <= sum - (parts - 1); first++) {
    for (const rest of compositions(sum - first, parts - 1)) yield [first, ...rest];
  }
}

function uniqueByEnumeration(raw: RawTable, published: PublishedTable): string[] {
  const names = Object.keys(published.groups);
  const info = names.map((g) => {
    const group = published.groups[g];
    const hiddenCells = Object.keys(group.cells).filter((c) => group.cells[c] === null);
    const shown = Object.values(group.cells).reduce<number>((s, v) => s + (v ?? 0), 0);
    const trueTotal = Object.values(raw[g]).reduce((s, v) => s + v, 0);
    return { g, group, hiddenCells, shown, trueTotal, lower: shown + hiddenCells.length };
  });
  // For each group: total -> the possible values of each suppressed cell.
  const options = info.map(({ group, hiddenCells, shown, trueTotal, lower }, i) => {
    let lo = lower;
    let hi: number;
    if (group.total !== null) {
      lo = hi = group.total;
    } else if (published.total !== null) {
      const others = info.reduce((s, o, j) => (j === i ? s : s + (o.group.total ?? o.lower)), 0);
      hi = published.total - others;
    } else {
      hi = trueTotal + 2;
    }
    const byTotal = new Map<number, Map<string, Set<number>>>();
    for (let t = lo; t <= hi; t++) {
      const cells = new Map<string, Set<number>>(hiddenCells.map((c) => [c, new Set<number>()]));
      let any = false;
      for (const values of compositions(t - shown, hiddenCells.length)) {
        any = true;
        values.forEach((v, k) => cells.get(hiddenCells[k])?.add(v));
      }
      if (any) byTotal.set(t, cells);
    }
    return byTotal;
  });
  const seen = new Map<string, Set<number>>();
  const note = (name: string, value: number) => {
    if (!seen.has(name)) seen.set(name, new Set());
    seen.get(name)?.add(value);
  };
  const choose = (i: number, totals: number[]) => {
    if (i === info.length) {
      const sum = totals.reduce((s, t) => s + t, 0);
      if (published.total !== null && sum !== published.total) return;
      if (published.total === null) note("G", sum);
      totals.forEach((t, j) => {
        if (info[j].group.total === null) note(`T:${info[j].g}`, t);
        for (const [c, values] of options[j].get(t) ?? []) for (const v of values) note(`C:${info[j].g}:${c}`, v);
      });
      return;
    }
    for (const t of options[i].keys()) choose(i + 1, [...totals, t]);
  };
  choose(0, []);
  const hidden: string[] = [];
  if (published.total === null) hidden.push("G");
  for (const { g, group, hiddenCells } of info) {
    if (group.total === null) hidden.push(`T:${g}`);
    for (const c of hiddenCells) hidden.push(`C:${g}:${c}`);
  }
  return hidden.filter((name) => (seen.get(name)?.size ?? 0) < 2);
}

describe("the bound rule (every listed value is an integer >= 1)", () => {
  it("the integer checker finds a value that the lower bound gives back", () => {
    // y + z = 2 and each is >= 1, so y = z = 1.
    const naive: PublishedTable = { total: 27, groups: { A: { total: 7, cells: { x: 5, y: null, z: null } }, B: { total: 20, cells: { x: 20 } } } };
    expect(uniqueByEnumeration({ A: { x: 5, y: 1, z: 1 }, B: { x: 20 } }, naive).sort()).toEqual(["C:A:y", "C:A:z"]);
  });

  it("hides 1 more cell when the suppressed cells of a group can only be 1", () => {
    const raw = { A: { x: 5, y: 1, z: 1 }, B: { x: 20 } };
    const published = assertSafe(raw);
    expect(uniqueByEnumeration(raw, published)).toEqual([]);
    expect(published.groups.A).toEqual({ total: 7, cells: { x: null, y: null, z: null } });
  });

  it("hides 1 more total when the suppressed totals sit at their lower bound", () => {
    // The totals of A and B are 1 and hidden; with G = 42 and C = 40 shown,
    // A + B = 2 and each is >= 1, so A = B = 1 (and so are their cells).
    const naive: PublishedTable = {
      total: 42,
      groups: { A: { total: null, cells: { x: null } }, B: { total: null, cells: { y: null } }, C: { total: 40, cells: { w: 40 } } },
    };
    const raw = { A: { x: 1 }, B: { y: 1 }, C: { w: 40 } };
    expect(uniqueByEnumeration(raw, naive).sort()).toEqual(["C:A:x", "C:B:y", "T:A", "T:B"]);
    const published = assertSafe(raw);
    expect(uniqueByEnumeration(raw, published)).toEqual([]);
    expect(published.groups.C).toEqual({ total: null, cells: { w: null } });
    expect(published.total).toBe(42);
  });

  it("leaves no suppressed value with only 1 possible integer value on 2000 seeded small tables", () => {
    const next = rng(0xb0d5);
    let suppressedSomething = 0;
    for (let t = 0; t < 2000; t++) {
      const raw: RawTable = {};
      const groups = 1 + Math.floor(next() * 3);
      for (let g = 0; g < groups; g++) {
        const cells: Record<string, number> = {};
        const count = 1 + Math.floor(next() * 3);
        for (let c = 0; c < count; c++) cells[`c${c}`] = next() < 0.5 ? 1 + Math.floor(next() * 2) : 1 + Math.floor(next() * 9);
        raw[`g${g}`] = cells;
      }
      const published = assertSafe(raw);
      const unique = uniqueByEnumeration(raw, published);
      expect(unique, JSON.stringify(raw)).toEqual([]);
      if (JSON.stringify(published).includes("null")) suppressedSomething += 1;
    }
    expect(suppressedSomething).toBeGreaterThan(1000);
  });
});
