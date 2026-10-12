// Pure semantic JSON diff on the order-preserving JNode model.
import { diffArrays } from 'diff';
import { JNode, Seg, Path, isContainer, stringify, sortKeys } from './json';

export type DiffKind = 'same' | 'added' | 'removed' | 'changed' | 'nested';
export interface DiffChild { label: Seg; leftSeg?: Seg; rightSeg?: Seg; node: DiffNode }
export interface DiffNode {
  kind: DiffKind;
  left?: JNode;
  right?: JNode;
  children?: DiffChild[];
  /** Number of leaf differences in this subtree (added + removed + changed). */
  count: number;
  /** Object key order differs (only reported when key order is not ignored). */
  orderChanged?: boolean;
}
export interface DiffOptions {
  ignoreKeyOrder?: boolean;
  arrayKey?: string;
  /** Align array elements with an LCS (Myers) diff over canonical element strings instead of by index. */
  alignArrays?: boolean;
}
export interface DiffSummary { added: number; removed: number; changed: number; total: number }

/** Canonical form of a JSON number text so 1, 1.0, 1e0 and 10e-1 compare equal, exactly (no float rounding). */
export function canonicalNumber(raw: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (!m) return raw;
  const [, sign, ip, fp = '', ex = '0'] = m;
  let digits = (ip + fp).replace(/^0+/, '');
  if (!digits) return '0';
  let exp = BigInt(ex) - BigInt(fp.length);
  const trail = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trail);
  exp += BigInt(trail);
  return `${sign}${digits}e${exp}`;
}

export function equalPrim(a: JNode, b: JNode): boolean {
  if (a.t !== b.t) return false;
  switch (a.t) {
    case 'string': return a.v === (b as typeof a).v;
    case 'boolean': return a.v === (b as typeof a).v;
    case 'null': return true;
    case 'number': return canonicalNumber(a.raw) === canonicalNumber((b as typeof a).raw);
    default: return false;
  }
}

const leaf = (kind: DiffKind, left?: JNode, right?: JNode): DiffNode => ({ kind, left, right, count: kind === 'same' ? 0 : 1 });

/** Side-only subtree (whole subtree added or removed); children kept so it can be browsed. */
function oneSide(n: JNode, side: 'added' | 'removed'): DiffNode {
  const d: DiffNode = { kind: side, count: 1, ...(side === 'added' ? { right: n } : { left: n }) };
  if (n.t === 'object') d.children = n.entries.map(([k, v]) => ({ label: k, [side === 'added' ? 'rightSeg' : 'leftSeg']: k, node: oneSide(v, side) }));
  if (n.t === 'array') d.children = n.items.map((v, i) => ({ label: i, [side === 'added' ? 'rightSeg' : 'leftSeg']: i, node: oneSide(v, side) }));
  return d;
}

function keyOf(n: JNode, k: string): string | undefined {
  if (n.t !== 'object') return undefined;
  const e = n.entries.find(x => x[0] === k);
  if (!e) return undefined;
  const v = e[1];
  if (v.t === 'string') return 's:' + v.v;
  if (v.t === 'number') return 'n:' + canonicalNumber(v.raw);
  if (v.t === 'boolean' || v.t === 'null') return 'p:' + stringify(v, 0);
  return undefined;
}

export function diff(a: JNode | undefined, b: JNode | undefined, o: DiffOptions = {}): DiffNode {
  const ignoreOrder = o.ignoreKeyOrder !== false;
  if (a === undefined && b === undefined) return leaf('same');
  if (a === undefined) return oneSide(b!, 'added');
  if (b === undefined) return oneSide(a, 'removed');
  if (a.t !== b.t || !isContainer(a)) {
    if (a.t === b.t && equalPrim(a, b)) return leaf('same', a, b);
    return { ...leaf('changed', a, b) };
  }
  const children: DiffChild[] = [];
  let orderChanged = false;
  if (a.t === 'object' && b.t === 'object') {
    const bm = new Map(b.entries);
    const am = new Map(a.entries);
    for (const [k, v] of a.entries) children.push({ label: k, leftSeg: k, rightSeg: bm.has(k) ? k : undefined, node: diff(v, bm.get(k), o) });
    for (const [k, v] of b.entries) if (!am.has(k)) children.push({ label: k, rightSeg: k, node: diff(undefined, v, o) });
    if (!ignoreOrder) {
      const ca = a.entries.map(e => e[0]).filter(k => bm.has(k));
      const cb = b.entries.map(e => e[0]).filter(k => am.has(k));
      orderChanged = ca.some((k, i) => k !== cb[i]);
    }
  } else if (a.t === 'array' && b.t === 'array') {
    const key = o.arrayKey;
    const keyed = key && a.items.length + b.items.length > 0 &&
      [...a.items, ...b.items].every(x => keyOf(x, key) !== undefined) &&
      new Set(a.items.map(x => keyOf(x, key))).size === a.items.length &&
      new Set(b.items.map(x => keyOf(x, key))).size === b.items.length;
    if (o.alignArrays && !keyed) {
      for (const p of alignItems(a.items, b.items)) {
        children.push({ label: p.i ?? p.j!, leftSeg: p.i, rightSeg: p.j, node: diff(p.i === undefined ? undefined : a.items[p.i], p.j === undefined ? undefined : b.items[p.j], o) });
      }
    } else if (keyed) {
      const bi = new Map(b.items.map((x, i) => [keyOf(x, key!)!, i]));
      const seen = new Set<number>();
      a.items.forEach((x, i) => {
        const j = bi.get(keyOf(x, key!)!);
        if (j !== undefined) seen.add(j);
        children.push({ label: i, leftSeg: i, rightSeg: j, node: diff(x, j === undefined ? undefined : b.items[j], o) });
      });
      b.items.forEach((x, j) => { if (!seen.has(j)) children.push({ label: j, rightSeg: j, node: diff(undefined, x, o) }); });
    } else {
      const n = Math.max(a.items.length, b.items.length);
      for (let i = 0; i < n; i++) children.push({ label: i, leftSeg: i < a.items.length ? i : undefined, rightSeg: i < b.items.length ? i : undefined, node: diff(a.items[i], b.items[i], o) });
    }
  }
  const count = children.reduce((s, c) => s + c.node.count, 0) + (orderChanged ? 1 : 0);
  return { kind: count ? 'nested' : 'same', left: a, right: b, children, count, orderChanged: orderChanged || undefined };
}

export function summarize(d: DiffNode): DiffSummary {
  const s = { added: 0, removed: 0, changed: 0, total: 0 };
  const walk = (n: DiffNode) => {
    if (n.kind === 'added') s.added++;
    else if (n.kind === 'removed') s.removed++;
    else if (n.kind === 'changed') s.changed++;
    else { if (n.orderChanged) s.changed++; n.children?.forEach(c => walk(c.node)); }
  };
  walk(d);
  s.total = s.added + s.removed + s.changed;
  return s;
}

export interface DiffEntry { path: Path; kind: 'added' | 'removed' | 'changed'; left?: JNode; right?: JNode }
/** Flat list of differences in display order; paths use the label segments. */
export function listDiffs(d: DiffNode, path: Path = []): DiffEntry[] {
  const out: DiffEntry[] = [];
  const walk = (n: DiffNode, p: Path) => {
    if (n.kind === 'added' || n.kind === 'removed' || n.kind === 'changed') { out.push({ path: p, kind: n.kind, left: n.left, right: n.right }); return; }
    if (n.orderChanged) out.push({ path: p, kind: 'changed', left: n.left, right: n.right });
    n.children?.forEach(c => walk(c.node, [...p, c.label]));
  };
  walk(d, path);
  return out;
}

/** Pretty text used for the line diff (keys sorted when key order is ignored). */
export function diffText(n: JNode, o: DiffOptions = {}, indent = 2): string {
  return stringify(o.ignoreKeyOrder !== false ? sortKeys(n) : n, indent);
}

export type LineRow = { left?: { n: number; text: string }; right?: { n: number; text: string }; kind: 'same' | 'added' | 'removed' | 'changed' };
/** Side-by-side rows from a list of line-diff chunks (as produced by the `diff` package). */
export function sideBySide(chunks: { value: string; added?: boolean; removed?: boolean }[]): LineRow[] {
  const rows: LineRow[] = [];
  let ln = 1, rn = 1;
  const lines = (v: string) => { const l = v.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.removed && chunks[i + 1]?.added) {
      const L = lines(c.value), R = lines(chunks[i + 1].value);
      for (let k = 0; k < Math.max(L.length, R.length); k++) {
        rows.push({
          left: k < L.length ? { n: ln++, text: L[k] } : undefined,
          right: k < R.length ? { n: rn++, text: R[k] } : undefined,
          kind: k < L.length && k < R.length ? 'changed' : k < L.length ? 'removed' : 'added',
        });
      }
      i++;
    } else if (c.removed) for (const t of lines(c.value)) rows.push({ left: { n: ln++, text: t }, kind: 'removed' });
    else if (c.added) for (const t of lines(c.value)) rows.push({ right: { n: rn++, text: t }, kind: 'added' });
    else for (const t of lines(c.value)) rows.push({ left: { n: ln++, text: t }, right: { n: rn++, text: t }, kind: 'same' });
  }
  return rows;
}

// ---------------------------------------------------------------- array sorting normalization
/** Compare strings by Unicode code point (not UTF-16 code unit, not locale). */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!, y = b.codePointAt(i)!;
    if (x !== y) return x < y ? -1 : 1;
    if (x > 0xffff) i++; // both are the same astral char: skip its low surrogate
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Canonical JSON string: object keys sorted by code point, no whitespace, exact number text. */
export function canonicalString(n: JNode): string {
  return normalizeInner(n, false).canon;
}

function normalizeInner(n: JNode, sortArrays: boolean): { node: JNode; canon: string } {
  switch (n.t) {
    case 'object': {
      // children first (post-order)
      const kids = n.entries.map(([k, v]) => ({ k, ...normalizeInner(v, sortArrays) }));
      const canon = '{' + kids.slice().sort((a, b) => compareCodePoints(a.k, b.k)).map(c => JSON.stringify(c.k) + ':' + c.canon).join(',') + '}';
      return { node: { t: 'object', entries: kids.map(c => [c.k, c.node]) }, canon };
    }
    case 'array': {
      const kids = n.items.map(v => normalizeInner(v, sortArrays));
      if (sortArrays) kids.sort((a, b) => compareCodePoints(a.canon, b.canon)); // Array.prototype.sort is stable
      return { node: { t: 'array', items: kids.map(c => c.node) }, canon: '[' + kids.map(c => c.canon).join(',') + ']' };
    }
    default:
      return { node: n, canon: stringify(n, 0) };
  }
}

/**
 * Sort every array bottom-up: children are normalized first (deepest arrays first), then each array's
 * elements are stably sorted by the canonical string of the already-normalized element.
 * Object key order is kept as-is.
 */
export function sortArraysDeep(n: JNode): JNode {
  return normalizeInner(n, true).node;
}

// ---------------------------------------------------------------- LCS array alignment
/** Structural similarity used to pair unmatched elements inside one gap (0 = don't pair). */
function similarity(x: JNode, y: JNode): number {
  if (x.t !== y.t) return 0;
  if (x.t === 'object' && y.t === 'object') {
    const ks = new Set(x.entries.map(e => e[0]));
    let shared = 0, sameVal = 0;
    for (const [k, v] of y.entries) if (ks.has(k)) { shared++; const xv = x.entries.find(e => e[0] === k)![1]; if (xv.t === v.t && !isContainer(v) && equalPrim(xv, v)) sameVal++; }
    return 1 + shared * 2 + sameVal;
  }
  return 1;
}

/**
 * Align two arrays: equal elements (same canonical JSON) are matched with an LCS (Myers) diff;
 * within each gap between matches, unmatched elements of the same type are paired greedily by
 * similarity (shared keys / equal values) as "changed"; the rest are added / removed.
 */
export function alignItems(a: JNode[], b: JNode[]): { i?: number; j?: number }[] {
  const ca = a.map(canonicalString), cb = b.map(canonicalString);
  const chunks = diffArrays(ca, cb);
  const out: { i?: number; j?: number }[] = [];
  let i = 0, j = 0;
  let gapL: number[] = [], gapR: number[] = [];
  const flush = () => {
    if (!gapL.length && !gapR.length) return;
    const pairOf = new Map<number, number>();
    const usedR = new Set<number>();
    if (gapL.length * gapR.length <= 250_000) {
      // greedy best-first over all candidate pairs (higher score, then closer position)
      const cands: [number, number, number][] = [];
      for (const l of gapL) for (const r of gapR) { const s = similarity(a[l], b[r]); if (s > 0) cands.push([s, l, r]); }
      cands.sort((x, y) => y[0] - x[0] || Math.abs(x[1] - x[2]) - Math.abs(y[1] - y[2]) || x[1] - y[1]);
      for (const [, l, r] of cands) if (!pairOf.has(l) && !usedR.has(r)) { pairOf.set(l, r); usedR.add(r); }
    } else {
      // very large gaps: pair in order by type
      for (const l of gapL) { const r = gapR.find(r => !usedR.has(r) && a[l].t === b[r].t); if (r !== undefined) { pairOf.set(l, r); usedR.add(r); } }
    }
    for (const l of gapL) out.push(pairOf.has(l) ? { i: l, j: pairOf.get(l) } : { i: l });
    for (const r of gapR) if (!usedR.has(r)) out.push({ j: r });
    gapL = []; gapR = [];
  };
  for (const c of chunks) {
    const n = c.count ?? c.value.length;
    if (c.removed) for (let k = 0; k < n; k++) gapL.push(i++);
    else if (c.added) for (let k = 0; k < n; k++) gapR.push(j++);
    else { flush(); for (let k = 0; k < n; k++) out.push({ i: i++, j: j++ }); }
  }
  flush();
  return out;
}
