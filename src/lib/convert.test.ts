// Integration tests: run the real WASM build from converter/pkg in Node.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { initSync, convert as rawConvert } from '../../converter/pkg/converter.js';
import { wrap, ConvertFn, detectFormat } from './convert';
import { parse, stringify } from './json';

let convert: ConvertFn;
beforeAll(() => {
  initSync({ module: readFileSync(new URL('../../converter/pkg/converter_bg.wasm', import.meta.url)) });
  convert = wrap(rawConvert);
});
const out = (r: ReturnType<ConvertFn>) => { if (!r.ok) throw new Error(`${r.message} @${r.line}:${r.col}`); return r.output; };
// canonical text through our own order-preserving parser (exact numbers)
const canon = (s: string) => { const r = parse(s); if (!r.ok) throw new Error(r.error.message); return stringify(r.node, 0); };

describe('wasm converter', () => {
  it('JSON -> YAML -> JSON', () => {
    const src = '{"name":"x","n":12345678901234567890123,"list":[1,"two",null,true,{"k":"v"}],"empty":{},"e2":[],"s":"true","10":1,"2":2}';
    const y = out(convert(src, 'json', 'yaml'));
    expect(y).toContain('name: x');
    expect(y).toContain('s: "true"');
    expect(canon(out(convert(y, 'yaml', 'json')))).toBe(canon(src));
  });
  it('YAML features: anchors, merge, multi-doc, order', () => {
    const j = JSON.parse(out(convert('a: &x {p: 1}\nb: *x\nc:\n  <<: *x\n  q: 2\n', 'yaml', 'json')));
    expect(j).toEqual({ a: { p: 1 }, b: { p: 1 }, c: { p: 1, q: 2 } });
    expect(JSON.parse(out(convert('1\n---\n2\n', 'yaml', 'json')))).toEqual([1, 2]);
    expect(convert('1\n---\n2\n', 'yaml', 'json', { multiDoc: 'error' }).ok).toBe(false);
    expect(out(convert('z: 1\na: 2\n', 'yaml', 'json', { indent: 0 }))).toBe('{"z":1,"a":2}');
  });
  it('errors carry line and column', () => {
    const r = convert('{\n  "a": 1,\n  "b" 2\n}', 'json', 'yaml');
    expect(r).toMatchObject({ ok: false, line: 3, col: 7 });
    const y = convert('a: [1, 2\nb: 3', 'yaml', 'json');
    expect(y.ok).toBe(false); if (!y.ok) { expect(y.line).toBeGreaterThan(0); expect(y.col).toBeGreaterThan(0); }
    const x = convert('<a>\n<b></c>\n</a>', 'xml', 'json');
    expect(x).toMatchObject({ ok: false, line: 2 });
  });
  it('XML -> JSON convention', () => {
    const j = JSON.parse(out(convert('<r a="1"><i>x</i><i>y</i><e/><t k="v">txt</t><![CDATA[c]]></r>', 'xml', 'json')));
    expect(j).toEqual({ r: { '@a': '1', i: ['x', 'y'], e: null, t: { '@k': 'v', '#text': 'txt' }, '#text': 'c' } });
  });
  it('JSON -> XML options', () => {
    expect(out(convert('[1,2]', 'json', 'xml', { rootName: 'nums' }))).toContain('<nums>\n  <item>1</item>\n  <item>2</item>\n</nums>');
    expect(out(convert('{"bad key":1, "2x": 2}', 'json', 'xml'))).toContain('<bad_key>1</bad_key>');
    expect(convert('{"r":{"bad key":1}}', 'json', 'xml', { invalidNames: 'error' }).ok).toBe(false);
  });
  it('JSON -> XML -> JSON identical (convention example)', () => {
    const src = '{"feed":{"@xmlns":"http://www.w3.org/2005/Atom","title":"T","entry":[{"@id":"1","title":"A & B","link":{"@href":"http://x?a=1&b=2"}},{"@id":"2","title":"<C>","link":null}]}}';
    expect(canon(out(convert(out(convert(src, 'json', 'xml')), 'xml', 'json')))).toBe(canon(src));
  });
  it('detectFormat', () => {
    expect(detectFormat('<a/>')).toBe('xml'); expect(detectFormat(' {"a":1}')).toBe('json');
    expect(detectFormat('a: 1')).toBe('yaml'); expect(detectFormat('x', 'f.yml')).toBe('yaml');
  });
});

// ---------------- property tests (fuzz-ish)
const anyJson = fc.jsonValue({ maxDepth: 4 });
const xmlText = fc.stringMatching(/^[A-Za-z_<>&"'é][A-Za-z0-9 _<>&"'é.]{0,8}[A-Za-z_<>&é]$/);
const xmlName = fc.stringMatching(/^[a-z][a-z0-9_.-]{0,6}$/);
const xmlLeaf = fc.oneof(fc.constant(null), xmlText);
const xmlTree: fc.Arbitrary<unknown> = fc.letrec(tie => ({
  node: fc.oneof({ depthSize: 'small', withCrossShrink: true },
    xmlLeaf,
    fc.dictionary(xmlName, fc.oneof(tie('node'), fc.array(fc.oneof(xmlLeaf, tie('obj')), { minLength: 2, maxLength: 3 })), { minKeys: 1, maxKeys: 3 }),
  ),
  obj: fc.dictionary(xmlName, tie('node'), { minKeys: 1, maxKeys: 3 }),
})).node;

describe('property: round trips', () => {
  it('JSON -> YAML -> JSON is identical for arbitrary JSON', () => {
    fc.assert(fc.property(anyJson, v => {
      const src = JSON.stringify(v);
      const y = out(convert(src, 'json', 'yaml'));
      expect(canon(out(convert(y, 'yaml', 'json')))).toBe(canon(src));
    }), { numRuns: 300 });
  });
  it('JSON -> XML -> JSON is identical for convention-conforming JSON', () => {
    fc.assert(fc.property(xmlName, xmlTree, (root, v) => {
      const src = JSON.stringify({ [root]: v });
      const x = out(convert(src, 'json', 'xml'));
      expect(canon(out(convert(x, 'xml', 'json')))).toBe(canon(src));
    }), { numRuns: 300 });
  });
  it('JSON -> XML always yields well-formed XML (or a clear error)', () => {
    fc.assert(fc.property(anyJson, v => {
      const r = convert(JSON.stringify(v), 'json', 'xml');
      if (r.ok) expect(convert(r.output, 'xml', 'json').ok).toBe(true);
      else expect(r.message.length).toBeGreaterThan(0);
    }), { numRuns: 300 });
  });
  it('converter never throws on garbage input', () => {
    fc.assert(fc.property(fc.string({ maxLength: 80 }), fc.constantFrom('json', 'yaml', 'xml'), (s, f) => {
      const r = convert(s, f as any, 'json');
      expect(typeof r.ok).toBe('boolean');
    }), { numRuns: 300 });
  });
});
