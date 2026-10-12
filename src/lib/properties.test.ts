// Java .properties through the real WASM build: flattening, escaping, parsing and round trips.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { initSync, convert as rawConvert } from '../../converter/pkg/converter.js';
import { wrap, ConvertFn, ConvertOptions, detectFormat } from './convert';

let conv: ConvertFn;
beforeAll(() => { initSync({ module: readFileSync(new URL('../../converter/pkg/converter_bg.wasm', import.meta.url)) }); conv = wrap(rawConvert); });
const run = (i: string, f: any, t: any, o: ConvertOptions = {}) => { const r = conv(i, f, t, o); if (!r.ok) throw new Error(`${r.message} @${r.line}:${r.col}`); return r.output; };
const toP = (v: unknown, o: ConvertOptions = {}) => run(JSON.stringify(v), 'json', 'properties', o);
const fromP = (s: string, o: ConvertOptions = {}) => JSON.parse(run(s, 'properties', 'json', o));

describe('JSON → Properties', () => {
  it('flattens Spring Boot style', () => {
    expect(toP({ server: { port: 8080, hosts: ['a', 'b'], users: [{ n: 'x' }] }, nil: null, eo: {}, ea: [], ok: false }))
      .toBe('server.port=8080\nserver.hosts[0]=a\nserver.hosts[1]=b\nserver.users[0].n=x\nnil=\neo=\nea=\nok=false\n');
  });
  it('escapes per java.util.Properties', () => {
    expect(toP({ 'a b': ' x=y:z#!\\' })).toBe('a\\ b=\\ x\\=y\\:z\\#\\!\\\\\n');
    expect(toP({ m: 'l1\nl2\tt' })).toBe('m=l1\\nl2\\tt\n');
    expect(toP({ u: 'é😀' })).toBe('u=\\u00E9\\uD83D\\uDE00\n');
    expect(toP({ u: 'é😀' }, { escapeUnicode: false })).toBe('u=é😀\n');
  });
});
describe('Properties → JSON', () => {
  it('parses comments, continuations and all separators', () => {
    expect(fromP('# c\n! c\na=1\nb : 2\nc 3\nd=\\\n   ef\ne=\n')).toEqual({ a: '1', b: '2', c: '3', d: 'ef', e: '' });
  });
  it('rebuilds nested objects and arrays; optional type inference', () => {
    expect(fromP('a.b[1]=y\na.b[0]=x\nn=5\nt=true')).toEqual({ a: { b: ['x', 'y'] }, n: '5', t: 'true' });
    expect(fromP('n=5\nt=true\nf=1.5\ns=05', { inferTypes: true })).toEqual({ n: 5, t: true, f: 1.5, s: '05' });
  });
  it('detects .properties files by extension', () => { expect(detectFormat('a=1', 'app.properties')).toBe('properties'); });
});
describe('round trips JSON → properties → JSON', () => {
  it('nested objects and arrays (inferTypes restores numbers/booleans)', () => {
    const v = { server: { port: 8080, ssl: true, hosts: ['a', 'b'], users: [{ name: 'x', roles: ['r1', 'r2'] }, { name: 'y' }] }, matrix: [[1, 2], [3, [4, 5]]], ratio: 0.25 };
    for (const escapeUnicode of [true, false]) expect(fromP(toP(v, { escapeUnicode }), { inferTypes: true })).toEqual(v);
  });
  it('property: arbitrary string trees round-trip exactly', () => {
    const key = fc.string({ minLength: 1, maxLength: 6 }).filter(k => !/[.[\]]/.test(k) && k !== '__proto__');
    const leaf = fc.string({ maxLength: 12 }).filter(s => s !== '');
    const tree = fc.letrec(t => ({
      node: fc.oneof({ depthSize: 'small' }, leaf, fc.array(t('node'), { minLength: 1, maxLength: 3 }), fc.dictionary(key, t('node'), { minKeys: 1, maxKeys: 3 })),
    })).node;
    fc.assert(fc.property(fc.dictionary(key, tree, { minKeys: 1, maxKeys: 4 }), fc.boolean(), (v, escapeUnicode) => {
      expect(fromP(toP(v, { escapeUnicode }))).toEqual(v);
    }), { numRuns: 300 });
  });
});
