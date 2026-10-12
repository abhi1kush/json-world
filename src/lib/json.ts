// Pure JSON document model with order-preserving objects and path operations.
export type JNode =
  | { t: 'object'; entries: [string, JNode][] }
  | { t: 'array'; items: JNode[] }
  | { t: 'string'; v: string }
  | { t: 'number'; raw: string }
  | { t: 'boolean'; v: boolean }
  | { t: 'null' };
export type JType = JNode['t'];
export type Seg = string | number;
export type Path = Seg[];

export interface ParseError { message: string; line: number; col: number; offset: number }
export type ParseResult = { ok: true; node: JNode } | { ok: false; error: ParseError };

// ---------- parser ----------
export function parse(text: string): ParseResult {
  let i = 0;
  const n = text.length;
  const fail = (msg: string, at = i): never => {
    let line = 1, col = 1;
    for (let k = 0; k < at && k < n; k++) {
      if (text.charCodeAt(k) === 10) { line++; col = 1; } else col++;
    }
    throw { __pe: true, message: msg, line, col, offset: Math.min(at, n) } as any;
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++; else break;
    }
  };
  const str = (): string => {
    const start = i;
    i++; // opening quote
    let out = '';
    let seg = i;
    while (true) {
      if (i >= n) fail('Unterminated string', start);
      const c = text.charCodeAt(i);
      if (c === 34) { out += text.slice(seg, i); i++; return out; }
      if (c < 32) fail('Control character in string');
      if (c === 92) {
        out += text.slice(seg, i);
        const e = text[i + 1];
        switch (e) {
          case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
          case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break;
          case 'r': out += '\r'; break; case 't': out += '\t'; break;
          case 'u': {
            const h = text.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('Invalid unicode escape');
            out += String.fromCharCode(parseInt(h, 16)); i += 4; break;
          }
          default: fail('Invalid escape sequence');
        }
        i += 2; seg = i;
      } else i++;
    }
  };
  const num = (): JNode => {
    const m = /-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;
    m.lastIndex = i;
    const r = m.exec(text);
    if (!r || r[0] === '-' || r[0] === '') fail('Invalid number');
    i += r![0].length;
    return { t: 'number', raw: r![0] };
  };
  const value = (depth: number): JNode => {
    if (depth > 5000) fail('Nesting too deep');
    ws();
    if (i >= n) fail('Unexpected end of input');
    const c = text[i];
    if (c === '{') {
      i++; const entries: [string, JNode][] = [];
      ws();
      if (text[i] === '}') { i++; return { t: 'object', entries }; }
      while (true) {
        ws();
        if (text[i] !== '"') fail('Expected property name in double quotes');
        const k = str(); ws();
        if (text[i] !== ':') fail("Expected ':' after property name");
        i++;
        entries.push([k, value(depth + 1)]);
        ws();
        if (text[i] === ',') { const comma = i; i++; ws(); if (text[i] === '}') fail("Trailing comma before '}'", comma); continue; }
        if (text[i] === '}') { i++; return { t: 'object', entries }; }
        fail("Expected ',' or '}'");
      }
    }
    if (c === '[') {
      i++; const items: JNode[] = [];
      ws();
      if (text[i] === ']') { i++; return { t: 'array', items }; }
      while (true) {
        items.push(value(depth + 1)); ws();
        if (text[i] === ',') { const comma = i; i++; ws(); if (text[i] === ']') fail("Trailing comma before ']'", comma); continue; }
        if (text[i] === ']') { i++; return { t: 'array', items }; }
        fail("Expected ',' or ']'");
      }
    }
    if (c === '"') return { t: 'string', v: str() };
    if (c === '-' || (c >= '0' && c <= '9')) return num();
    if (text.startsWith('true', i)) { i += 4; return { t: 'boolean', v: true }; }
    if (text.startsWith('false', i)) { i += 5; return { t: 'boolean', v: false }; }
    if (text.startsWith('null', i)) { i += 4; return { t: 'null' }; }
    return fail(`Unexpected token '${c}'`);
  };
  try {
    const node = value(0); ws();
    if (i < n) fail('Unexpected content after JSON value');
    return { ok: true, node };
  } catch (e: any) {
    if (e && e.__pe) return { ok: false, error: { message: e.message, line: e.line, col: e.col, offset: e.offset } };
    throw e;
  }
}

// ---------- serializer ----------
export function stringify(node: JNode, indent: number | string = 2): string {
  const ind = typeof indent === 'number' ? ' '.repeat(indent) : indent;
  const parts: string[] = [];
  const w = (nd: JNode, cur: string) => {
    switch (nd.t) {
      case 'string': parts.push(JSON.stringify(nd.v)); return;
      case 'number': parts.push(nd.raw); return;
      case 'boolean': parts.push(nd.v ? 'true' : 'false'); return;
      case 'null': parts.push('null'); return;
      case 'array': {
        if (!nd.items.length) { parts.push('[]'); return; }
        const nx = cur + ind;
        parts.push(ind ? '[\n' : '[');
        nd.items.forEach((it, k) => { if (k) parts.push(ind ? ',\n' : ','); parts.push(nx); w(it, nx); });
        parts.push(ind ? '\n' + cur + ']' : ']'); return;
      }
      case 'object': {
        if (!nd.entries.length) { parts.push('{}'); return; }
        const nx = cur + ind;
        parts.push(ind ? '{\n' : '{');
        nd.entries.forEach(([k, v], j) => {
          if (j) parts.push(ind ? ',\n' : ',');
          parts.push(nx, JSON.stringify(k), ind ? ': ' : ':'); w(v, nx);
        });
        parts.push(ind ? '\n' + cur + '}' : '}'); return;
      }
    }
  };
  w(node, '');
  return parts.join('');
}
export const minify = (n: JNode) => stringify(n, 0);

// ---------- conversion ----------
export function fromJS(v: unknown): JNode {
  if (v === null || v === undefined) return { t: 'null' };
  if (Array.isArray(v)) return { t: 'array', items: v.map(fromJS) };
  switch (typeof v) {
    case 'string': return { t: 'string', v };
    case 'number': return Number.isFinite(v) ? { t: 'number', raw: String(v) } : { t: 'null' };
    case 'boolean': return { t: 'boolean', v };
    case 'object': return { t: 'object', entries: Object.entries(v as object).map(([k, x]) => [k, fromJS(x)]) };
  }
  return { t: 'null' };
}
export function toJS(n: JNode): unknown {
  switch (n.t) {
    case 'string': return n.v; case 'number': return Number(n.raw);
    case 'boolean': return n.v; case 'null': return null;
    case 'array': return n.items.map(toJS);
    case 'object': { const o: Record<string, unknown> = {}; for (const [k, v] of n.entries) o[k] = toJS(v); return o; }
  }
}

/** Parse user-typed literal for inline editing. Falls back to string if not valid JSON. */
export function parseLiteral(input: string): JNode {
  const r = parse(input.trim());
  if (r.ok) return r.node;
  return { t: 'string', v: input };
}
/** Text shown in an inline value editor. */
export function literalText(n: JNode): string {
  return n.t === 'string' ? n.v : stringify(n, 0);
}

// ---------- path ----------
export function pathToString(p: Path): string {
  let s = '$';
  for (const seg of p) {
    if (typeof seg === 'number') s += `[${seg}]`;
    else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seg)) s += '.' + seg;
    else s += `[${JSON.stringify(seg)}]`;
  }
  return s;
}
export const pathKey = (p: Path) => JSON.stringify(p);
export const samePath = (a: Path, b: Path) => a.length === b.length && a.every((x, i) => x === b[i]);

export function getAt(root: JNode, p: Path): JNode | undefined {
  let cur: JNode | undefined = root;
  for (const seg of p) {
    if (!cur) return undefined;
    if (cur.t === 'array' && typeof seg === 'number') cur = cur.items[seg];
    else if (cur.t === 'object' && typeof seg === 'string') cur = cur.entries.find(e => e[0] === seg)?.[1];
    else return undefined;
  }
  return cur;
}

function update(root: JNode, p: Path, fn: (n: JNode) => JNode): JNode {
  if (!p.length) return fn(root);
  const [seg, ...rest] = p;
  if (root.t === 'array' && typeof seg === 'number') {
    if (seg < 0 || seg >= root.items.length) throw new Error(`Index out of range: ${seg}`);
    const items = root.items.slice(); items[seg] = update(items[seg], rest, fn);
    return { t: 'array', items };
  }
  if (root.t === 'object' && typeof seg === 'string') {
    const idx = root.entries.findIndex(e => e[0] === seg);
    if (idx < 0) throw new Error(`No such key: ${seg}`);
    const entries = root.entries.slice(); entries[idx] = [seg, update(entries[idx][1], rest, fn)];
    return { t: 'object', entries };
  }
  throw new Error('Invalid path');
}
const parentOf = (p: Path) => p.slice(0, -1);
const last = (p: Path) => p[p.length - 1];

export const setAt = (root: JNode, p: Path, v: JNode) => update(root, p, () => v);

export function deleteAt(root: JNode, p: Path): JNode {
  if (!p.length) throw new Error('Cannot delete root');
  const seg = last(p);
  return update(root, parentOf(p), par => {
    if (par.t === 'array' && typeof seg === 'number') {
      if (seg < 0 || seg >= par.items.length) throw new Error('Index out of range');
      return { t: 'array', items: par.items.filter((_, i) => i !== seg) };
    }
    if (par.t === 'object' && typeof seg === 'string') {
      if (!par.entries.some(e => e[0] === seg)) throw new Error(`No such key: ${seg}`);
      return { t: 'object', entries: par.entries.filter(e => e[0] !== seg) };
    }
    throw new Error('Invalid path');
  });
}

/** Insert into an array at index (0..length). */
export function insertAt(root: JNode, arrPath: Path, index: number, v: JNode): JNode {
  return update(root, arrPath, a => {
    if (a.t !== 'array') throw new Error('Not an array');
    const i = Math.max(0, Math.min(index, a.items.length));
    const items = a.items.slice(); items.splice(i, 0, v);
    return { t: 'array', items };
  });
}

/** Add key to object at position (default end). Throws if key exists. */
export function addKey(root: JNode, objPath: Path, key: string, v: JNode, position?: number): JNode {
  return update(root, objPath, o => {
    if (o.t !== 'object') throw new Error('Not an object');
    if (o.entries.some(e => e[0] === key)) throw new Error(`Key already exists: ${key}`);
    const entries = o.entries.slice();
    entries.splice(position ?? entries.length, 0, [key, v]);
    return { t: 'object', entries };
  });
}

export function renameKey(root: JNode, p: Path, newKey: string): JNode {
  const old = last(p);
  if (typeof old !== 'string') throw new Error('Not an object key');
  if (old === newKey) return root;
  return update(root, parentOf(p), o => {
    if (o.t !== 'object') throw new Error('Not an object');
    if (o.entries.some(e => e[0] === newKey)) throw new Error(`Key already exists: ${newKey}`);
    return { t: 'object', entries: o.entries.map(e => (e[0] === old ? [newKey, e[1]] : e)) };
  });
}

/** Move array item by delta (-1 up, +1 down). Returns [root, newPath]. */
export function moveItem(root: JNode, p: Path, delta: number): [JNode, Path] {
  const idx = last(p);
  if (typeof idx !== 'number') throw new Error('Not an array item');
  const to = idx + delta;
  let ok = false;
  const r = update(root, parentOf(p), a => {
    if (a.t !== 'array') throw new Error('Not an array');
    if (to < 0 || to >= a.items.length) return a;
    ok = true;
    const items = a.items.slice(); const [x] = items.splice(idx, 1); items.splice(to, 0, x);
    return { t: 'array', items };
  });
  return ok ? [r, [...parentOf(p), to]] : [root, p];
}

export function uniqueKey(existing: Iterable<string>, base: string): string {
  const set = new Set(existing);
  if (!set.has(base)) return base;
  let c = `${base}_copy`;
  for (let k = 2; set.has(c); k++) c = `${base}_copy${k}`;
  return c;
}

export function defaultFor(t: JType): JNode {
  switch (t) {
    case 'object': return { t: 'object', entries: [] };
    case 'array': return { t: 'array', items: [] };
    case 'string': return { t: 'string', v: '' };
    case 'number': return { t: 'number', raw: '0' };
    case 'boolean': return { t: 'boolean', v: false };
    case 'null': return { t: 'null' };
  }
}
/** Convert a node to another type, keeping data where sensible. */
export function convertType(n: JNode, t: JType): JNode {
  if (n.t === t) return n;
  const prim = n.t === 'string' ? n.v : n.t === 'number' ? n.raw : n.t === 'boolean' ? String(n.v) : n.t === 'null' ? '' : null;
  switch (t) {
    case 'string': return { t: 'string', v: prim ?? stringify(n, 0) };
    case 'number': { const x = Number(prim); return { t: 'number', raw: prim !== null && prim.trim() !== '' && Number.isFinite(x) ? String(x) : '0' }; }
    case 'boolean': return { t: 'boolean', v: prim === 'true' || (n.t === 'number' && Number(n.raw) !== 0) };
    case 'null': return { t: 'null' };
    case 'array':
      if (n.t === 'object') return { t: 'array', items: n.entries.map(e => e[1]) };
      return { t: 'array', items: n.t === 'null' ? [] : [n] };
    case 'object':
      if (n.t === 'array') return { t: 'object', entries: n.items.map((v, i) => [String(i), v]) };
      return { t: 'object', entries: n.t === 'null' ? [] : [['value', n]] };
  }
}

export function sortKeys(n: JNode, deep = true): JNode {
  if (n.t === 'object') {
    const entries = n.entries.map(([k, v]) => [k, deep ? sortKeys(v) : v] as [string, JNode]);
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { t: 'object', entries };
  }
  if (n.t === 'array' && deep) return { t: 'array', items: n.items.map(x => sortKeys(x)) };
  return n;
}

export const childCount = (n: JNode) => (n.t === 'object' ? n.entries.length : n.t === 'array' ? n.items.length : 0);
export const isContainer = (n: JNode) => n.t === 'object' || n.t === 'array';

/** Add a new child to a container (default null / "newKey"). Returns [root, childPath]. */
export function addChild(root: JNode, p: Path, v: JNode = { t: 'null' }, key = 'newKey'): [JNode, Path] {
  const n = getAt(root, p);
  if (!n) throw new Error('Invalid path');
  if (n.t === 'array') return [insertAt(root, p, n.items.length, v), [...p, n.items.length]];
  if (n.t === 'object') { const k = uniqueKey(n.entries.map(e => e[0]), key); return [addKey(root, p, k, v), [...p, k]]; }
  throw new Error('Not a container');
}
/** Add a sibling after the node. Returns [root, newPath]. */
export function addSibling(root: JNode, p: Path, v: JNode = { t: 'null' }, key = 'newKey'): [JNode, Path] {
  if (!p.length) throw new Error('Root has no siblings');
  const par = getAt(root, parentOf(p))!;
  const seg = last(p);
  if (par.t === 'array') return [insertAt(root, parentOf(p), (seg as number) + 1, v), [...parentOf(p), (seg as number) + 1]];
  if (par.t === 'object') {
    const k = uniqueKey(par.entries.map(e => e[0]), key);
    const pos = par.entries.findIndex(e => e[0] === seg) + 1;
    return [addKey(root, parentOf(p), k, v, pos), [...parentOf(p), k]];
  }
  throw new Error('Invalid path');
}

// ---------- copy / paste ----------
export interface Clip { text: string; key?: string }
export function copyNode(root: JNode, p: Path, indent = 2): Clip {
  const n = getAt(root, p);
  if (!n) throw new Error('Invalid path');
  const k = last(p);
  return { text: stringify(n, indent), key: typeof k === 'string' ? k : undefined };
}

export type PasteMode = 'auto' | 'replace';
/**
 * Paste rules:
 *  - replace: selected node's value is replaced.
 *  - auto, selected is object: added as new key (given key, or clip key/"pasted" made unique e.g. key_copy).
 *  - auto, selected is array: appended at the end.
 *  - auto, selected is primitive inside array: inserted after it.
 *  - auto, selected is primitive inside object: inserted after it as a sibling with unique key.
 *  - auto, selected is primitive root: replaced.
 * Returns new root and path of pasted node. Throws on invalid clipboard JSON.
 */
export function paste(root: JNode, sel: Path, clip: Clip | string, mode: PasteMode = 'auto', key?: string): { root: JNode; path: Path } {
  const c: Clip = typeof clip === 'string' ? { text: clip } : clip;
  const r = parse(c.text.trim());
  if (!r.ok) throw new Error(`Clipboard is not valid JSON: ${r.error.message} (line ${r.error.line}, col ${r.error.col})`);
  const v = r.node;
  const target = getAt(root, sel);
  if (!target) throw new Error('Invalid path');
  const base = key ?? c.key ?? 'pasted';
  if (mode === 'replace') return { root: setAt(root, sel, v), path: sel };
  if (target.t === 'object') {
    const k = key !== undefined && !target.entries.some(e => e[0] === key) ? key : uniqueKey(target.entries.map(e => e[0]), base);
    return { root: addKey(root, sel, k, v), path: [...sel, k] };
  }
  if (target.t === 'array') return { root: insertAt(root, sel, target.items.length, v), path: [...sel, target.items.length] };
  if (!sel.length) return { root: v, path: [] };
  const par = getAt(root, parentOf(sel))!;
  if (par.t === 'array') {
    const at = (last(sel) as number) + 1;
    return { root: insertAt(root, parentOf(sel), at, v), path: [...parentOf(sel), at] };
  }
  const [nr, np] = addSibling(root, sel, v, base);
  return { root: nr, path: np };
}

// ---------- search ----------
/** Returns set of pathKeys that match (key or primitive value contains q, case-insensitive). */
export function search(root: JNode, q: string, limit = 50000): { matches: Set<string>; ancestors: Set<string> } {
  const matches = new Set<string>(); const ancestors = new Set<string>();
  const needle = q.toLowerCase();
  if (!needle) return { matches, ancestors };
  const walk = (n: JNode, p: Path): boolean => {
    if (matches.size >= limit) return false;
    let hit = false;
    const k = p[p.length - 1];
    if (typeof k === 'string' && k.toLowerCase().includes(needle)) hit = true;
    if (!isContainer(n) && literalText(n).toLowerCase().includes(needle)) hit = true;
    let child = false;
    if (n.t === 'object') for (const [ck, cv] of n.entries) { if (walk(cv, [...p, ck])) child = true; }
    if (n.t === 'array') n.items.forEach((cv, i) => { if (walk(cv, [...p, i])) child = true; });
    if (hit) matches.add(pathKey(p));
    if (child) ancestors.add(pathKey(p));
    return hit || child;
  };
  walk(root, []);
  return { matches, ancestors };
}
