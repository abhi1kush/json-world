// Pure semantic JSON diff on the order-preserving JNode model.
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
export interface DiffOptions { ignoreKeyOrder?: boolean; arrayKey?: string }
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
    if (keyed) {
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
