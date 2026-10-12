import { describe, it, expect } from 'vitest';
import * as J from './json';

const P = (s: string) => { const r = J.parse(s); if (!r.ok) throw new Error(r.error.message); return r.node; };
const S = (n: J.JNode) => J.stringify(n, 0);

describe('parse/stringify', () => {
  it('round-trips and pretty-prints like JSON.stringify', () => {
    const src = '{"a":1,"b":[true,null,"x\\n"],"c":{"d":-1.5}}';
    const n = P(src);
    expect(S(n)).toBe(src);
    expect(J.stringify(n, 2)).toBe(JSON.stringify(JSON.parse(src), null, 2));
    expect(J.stringify(n, 4)).toBe(JSON.stringify(JSON.parse(src), null, 4));
  });
  it('preserves key order including integer-like keys', () => {
    expect(S(P('{"b":1,"10":2,"2":3,"a":4}'))).toBe('{"b":1,"10":2,"2":3,"a":4}');
  });
  it('preserves big number precision', () => {
    expect(S(P('[12345678901234567890123]'))).toBe('[12345678901234567890123]');
  });
  it('handles unicode escapes and empty containers', () => {
    expect(J.toJS(P('{"u":"\\u00e9","e":{},"a":[]}'))).toEqual({ u: 'é', e: {}, a: [] });
  });
  it.each([
    ['{"a":1,}', 1, 7], // points at the offending comma,
    ['{\n  "a": 1\n  "b": 2\n}', 3, 3],
    ['[1, 2', 1, 6],
    ['{a:1}', 1, 2],
    ['"abc', 1, 1],
    ['01', 1, 2],
    ['', 1, 1],
    ['[1] x', 1, 5],
  ])('reports error with line/col for %j', (src, line, col) => {
    const r = J.parse(src);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.error.line).toBe(line); expect(r.error.col).toBe(col); }
  });
  it('agrees with JSON.parse on validity for assorted inputs', () => {
    for (const s of ['1', '-0', '1e5', '"\\/"', 'true', ' null ', '[1,]', 'tru', '{"a"}', '-', '1.', '.5', '"\t"']) {
      let ok = true; try { JSON.parse(s); } catch { ok = false; }
      expect(J.parse(s).ok, s).toBe(ok);
    }
  });
  it('parses ~5MB JSON reasonably fast', () => {
    const big = JSON.stringify(Array.from({ length: 40000 }, (_, i) => ({ id: i, name: 'user' + i, tags: ['a', 'b'], nested: { x: i * 1.5, ok: i % 2 === 0 } })));
    expect(big.length).toBeGreaterThan(3_000_000);
    const t = performance.now();
    const n = P(big);
    expect(J.stringify(n, 0)).toBe(big);
    expect(performance.now() - t).toBeLessThan(5000);
  });
});

describe('path ops', () => {
  const doc = () => P('{"users":[{"name":"a"},{"name":"b"}],"meta":{"x":1,"y":2}}');
  it('pathToString', () => {
    expect(J.pathToString(['users', 2, 'name'])).toBe('$.users[2].name');
    expect(J.pathToString(['a b', 0])).toBe('$["a b"][0]');
    expect(J.pathToString([])).toBe('$');
  });
  it('get/set', () => {
    const d = doc();
    expect(J.getAt(d, ['users', 1, 'name'])).toEqual({ t: 'string', v: 'b' });
    const d2 = J.setAt(d, ['users', 1, 'name'], { t: 'number', raw: '5' });
    expect(S(d2)).toBe('{"users":[{"name":"a"},{"name":5}],"meta":{"x":1,"y":2}}');
    expect(S(d)).toContain('"b"'); // immutability
    expect(J.getAt(d, ['nope'])).toBeUndefined();
    expect(() => J.setAt(d, ['users', 9], { t: 'null' })).toThrow();
  });
  it('delete', () => {
    expect(S(J.deleteAt(doc(), ['users', 0]))).toBe('{"users":[{"name":"b"}],"meta":{"x":1,"y":2}}');
    expect(S(J.deleteAt(doc(), ['meta', 'x']))).toBe('{"users":[{"name":"a"},{"name":"b"}],"meta":{"y":2}}');
    expect(() => J.deleteAt(doc(), [])).toThrow();
  });
  it('insert / addKey', () => {
    expect(S(J.insertAt(P('[1,2]'), [], 1, P('9')))).toBe('[1,9,2]');
    expect(S(J.addKey(P('{"a":1,"c":3}'), [], 'b', P('2'), 1))).toBe('{"a":1,"b":2,"c":3}');
    expect(() => J.addKey(P('{"a":1}'), [], 'a', P('2'))).toThrow();
  });
  it('rename keeps position and rejects duplicates', () => {
    expect(S(J.renameKey(doc(), ['meta', 'x'], 'z'))).toBe('{"users":[{"name":"a"},{"name":"b"}],"meta":{"z":1,"y":2}}');
    expect(() => J.renameKey(doc(), ['meta', 'x'], 'y')).toThrow();
  });
  it('move array items', () => {
    const [r, p] = J.moveItem(P('[1,2,3]'), [0], 1);
    expect(S(r)).toBe('[2,1,3]'); expect(p).toEqual([1]);
    const [r2, p2] = J.moveItem(P('[1,2,3]'), [0], -1);
    expect(S(r2)).toBe('[1,2,3]'); expect(p2).toEqual([0]);
  });
  it('addChild / addSibling', () => {
    const [a, ap] = J.addChild(P('{"newKey":1}'), []);
    expect(S(a)).toBe('{"newKey":1,"newKey_copy":null}'); expect(ap).toEqual(['newKey_copy']);
    const [b, bp] = J.addSibling(P('{"a":1,"b":2}'), ['a']);
    expect(S(b)).toBe('{"a":1,"newKey":null,"b":2}'); expect(bp).toEqual(['newKey']);
    const [c] = J.addSibling(P('[1,2]'), [0], P('7'));
    expect(S(c)).toBe('[1,7,2]');
  });
  it('convertType', () => {
    expect(J.convertType(P('"42"'), 'number')).toEqual({ t: 'number', raw: '42' });
    expect(J.convertType(P('"abc"'), 'number')).toEqual({ t: 'number', raw: '0' });
    expect(S(J.convertType(P('{"a":1,"b":2}'), 'array'))).toBe('[1,2]');
    expect(S(J.convertType(P('[5]'), 'object'))).toBe('{"0":5}');
    expect(J.convertType(P('1'), 'string')).toEqual({ t: 'string', v: '1' });
  });
  it('sortKeys deep, leaving arrays ordered', () => {
    expect(S(J.sortKeys(P('{"b":{"z":1,"a":2},"a":[{"d":1,"c":2}]}')))).toBe('{"a":[{"c":2,"d":1}],"b":{"a":2,"z":1}}');
  });
  it('parseLiteral', () => {
    expect(J.parseLiteral('12')).toEqual({ t: 'number', raw: '12' });
    expect(J.parseLiteral('hello')).toEqual({ t: 'string', v: 'hello' });
    expect(J.parseLiteral('"12"')).toEqual({ t: 'string', v: '12' });
    expect(S(J.parseLiteral('{"a":[1]}'))).toBe('{"a":[1]}');
    expect(J.parseLiteral('null')).toEqual({ t: 'null' });
  });
});

describe('unique keys', () => {
  it('generates key, key_copy, key_copy2...', () => {
    expect(J.uniqueKey(['a'], 'b')).toBe('b');
    expect(J.uniqueKey(['a'], 'a')).toBe('a_copy');
    expect(J.uniqueKey(['a', 'a_copy'], 'a')).toBe('a_copy2');
    expect(J.uniqueKey(['a', 'a_copy', 'a_copy2'], 'a')).toBe('a_copy3');
  });
});

describe('copy / paste', () => {
  const doc = () => P('{"cfg":{"deep":{"x":[1,{"y":2}]}},"list":[10,20],"name":"n"}');
  it('copies a whole (collapsed) subtree regardless of UI state', () => {
    const c = J.copyNode(doc(), ['cfg'], 0);
    expect(c).toEqual({ text: '{"deep":{"x":[1,{"y":2}]}}', key: 'cfg' });
  });
  it('pastes subtree into array (append when array selected)', () => {
    const c = J.copyNode(doc(), ['cfg']);
    const { root, path } = J.paste(doc(), ['list'], c);
    expect(path).toEqual(['list', 2]);
    expect(J.toJS(J.getAt(root, path)!)).toEqual({ deep: { x: [1, { y: 2 }] } });
  });
  it('inserts after selected array item', () => {
    const { root, path } = J.paste(doc(), ['list', 0], '"z"');
    expect(S(J.getAt(root, ['list'])!)).toBe('[10,"z",20]'); expect(path).toEqual(['list', 1]);
  });
  it('pastes into object with auto-unique key from source', () => {
    const c = J.copyNode(doc(), ['cfg']);
    const r1 = J.paste(doc(), [], c);
    expect(r1.path).toEqual(['cfg_copy']);
    const r2 = J.paste(r1.root, [], c);
    expect(r2.path).toEqual(['cfg_copy2']);
    expect(J.toJS(J.getAt(r2.root, ['cfg_copy2'])!)).toEqual(J.toJS(J.getAt(doc(), ['cfg'])!));
  });
  it('uses explicit key, falling back to unique when taken', () => {
    expect(J.paste(doc(), [], '1', 'auto', 'fresh').path).toEqual(['fresh']);
    expect(J.paste(doc(), [], '1', 'auto', 'name').path).toEqual(['name_copy']);
    expect(J.paste(doc(), ['cfg'], '1').path).toEqual(['cfg', 'pasted']);
  });
  it('inserts as sibling after primitive in object', () => {
    const { root, path } = J.paste(P('{"a":1,"b":2}'), ['a'], { text: '5', key: 'a' });
    expect(S(root)).toBe('{"a":1,"a_copy":5,"b":2}'); expect(path).toEqual(['a_copy']);
  });
  it('replace mode replaces the selected value', () => {
    const { root } = J.paste(doc(), ['name'], '{"k":[1]}', 'replace');
    expect(S(J.getAt(root, ['name'])!)).toBe('{"k":[1]}');
  });
  it('primitive root is replaced', () => {
    expect(S(J.paste(P('1'), [], '[2]').root)).toBe('[2]');
  });
  it('rejects invalid clipboard JSON', () => {
    expect(() => J.paste(doc(), ['list'], '{bad')).toThrow(/not valid JSON/);
  });
  it('plain-text clipboard can be quoted by caller', () => {
    expect(() => J.paste(doc(), ['list'], 'hello')).toThrow();
    expect(J.paste(doc(), ['list'], JSON.stringify('hello')).path).toEqual(['list', 2]);
  });
});

describe('sync round-trips', () => {
  it('text -> tree -> edit -> text -> tree is stable', () => {
    const text = '{\n  "users": [\n    {\n      "name": "a"\n    }\n  ]\n}';
    let n = P(text);
    expect(J.stringify(n, 2)).toBe(text);
    n = J.setAt(n, ['users', 0, 'name'], J.parseLiteral('Bob'));
    const t2 = J.stringify(n, 2);
    expect(t2).toContain('"name": "Bob"');
    expect(J.stringify(P(t2), 2)).toBe(t2);
    expect(J.stringify(P(t2), 4)).toBe(JSON.stringify(JSON.parse(t2), null, 4));
  });
  it('string escapes survive round-trip', () => {
    const v = 'quote " backslash \\ tab \t newline \n emoji 😀 \u2028';
    const n = J.fromJS({ v });
    expect(J.toJS(P(J.stringify(n, 2)))).toEqual({ v });
  });
  it('minify / format', () => {
    const n = P('{ "a" : [ 1 , 2 ] }');
    expect(J.minify(n)).toBe('{"a":[1,2]}');
  });
});

describe('search', () => {
  it('finds keys and values with ancestors', () => {
    const { matches, ancestors } = J.search(P('{"a":{"Name":"x"},"b":"findme","c":[1,"FIND"]}'), 'find');
    expect([...matches].sort()).toEqual([J.pathKey(['b']), J.pathKey(['c', 1])].sort());
    expect(ancestors.has(J.pathKey([]))).toBe(true);
    expect(ancestors.has(J.pathKey(['c']))).toBe(true);
    expect(J.search(P('{"a":{"Name":"x"}}'), 'name').matches.has(J.pathKey(['a', 'Name']))).toBe(true);
  });
});
