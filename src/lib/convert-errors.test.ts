// Error surfacing for the Convert tab: every format and pair reports a located, human-readable problem.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { initSync, convert as rawConvert } from '../../converter/pkg/converter.js';
import { wrap, ConvertFn, Format, runConvert, diagText, locate } from './convert';

let conv: ConvertFn;
beforeAll(() => { initSync({ module: readFileSync(new URL('../../converter/pkg/converter_bg.wasm', import.meta.url)) }); conv = wrap(rawConvert); });
const FORMATS: Format[] = ['json', 'yaml', 'xml'];
const targets = (f: Format) => FORMATS.filter(t => t !== f);
const err = (input: string, from: Format, to: Format) => {
  const r = runConvert(conv, input, from, to);
  if (r.kind !== 'error') throw new Error(`expected error for ${from}->${to}: ${JSON.stringify(r)}`);
  return r.diag;
};

// [name, format, input, line, col, message regex]
const CASES: [string, Format, string, number, number, RegExp][] = [
  ['JSON trailing comma', 'json', '{\n  "a": 1,\n}', 2, 9, /trailing comma/i],
  ['JSON unclosed brace', 'json', '{\n  "a": {\n    "b": 1\n  }', 4, 4, /Unexpected end of input/],
  ['JSON invalid char', 'json', '{\n  "a": @\n}', 2, 8, /./],
  ['YAML bad indentation', 'yaml', 'a:\n  b: 1\n c: 2', 3, 2, /./],
  ['YAML tab indentation', 'yaml', 'a:\n\tb: 1', 2, 1, /tab/i],
  ['XML unclosed tag', 'xml', '<r>\n  <a>x</a>\n  <b>', 3, 3, /Unclosed element <b>/],
  ['XML mismatched tags', 'xml', '<r>\n  <a>\n    <b/>\n</r>', 4, 1, /expected `<\/a>`/],
  ['XML invalid char', 'xml', '<a>\n ok \u0001</a>', 2, 5, /U\+0001/],
];

describe('runConvert errors', () => {
  for (const [name, f, input, line, col, re] of CASES) for (const t of targets(f)) it(`${name} (${f} → ${t})`, () => {
    const d = err(input, f, t);
    expect(d.stage).toBe('parse');
    expect(d.title).toBe(`Invalid ${f.toUpperCase()}`);
    expect([d.line, d.col]).toEqual([line, col]);
    expect(d.message).toMatch(re);
    expect(d.from).not.toBeNull();
    expect(diagText(d)).toContain(`at line ${line}, column ${col}`);
  });
  it('empty / whitespace input is neutral', () => {
    for (const f of FORMATS) for (const t of targets(f)) { expect(runConvert(conv, '', f, t).kind).toBe('empty'); expect(runConvert(conv, ' \n\t\n', f, t).kind).toBe('empty'); }
  });
  it('valid input converts', () => { expect(runConvert(conv, '{"a":1}', 'json', 'xml').kind).toBe('ok'); });
  it('JSON → XML: top-level scalar is a located convert error', () => {
    for (const s of ['5', '"s"', 'true', 'null']) {
      const d = err('\n  ' + s, 'json', 'xml');
      expect(d.stage).toBe('convert'); expect(d.title).toBe("Can't convert JSON → XML");
      expect(d.message).toMatch(/top-level .* root element/); expect([d.line, d.col]).toEqual([2, 3]);
    }
    expect(runConvert(conv, '5', 'json', 'yaml').kind).toBe('ok');
  });
  it('JSON → XML invalid name (error mode) points at the key', () => {
    const r = runConvert(conv, '{\n  "ok": {\n    "a b": 1\n  }\n}', 'json', 'xml', { invalidNames: 'error' });
    expect(r.kind).toBe('error'); if (r.kind !== 'error') return;
    expect(r.diag.stage).toBe('convert'); expect([r.diag.line, r.diag.col]).toEqual([3, 5]);
  });
  it('YAML → XML of a scalar is a convert error, not "invalid YAML"', () => {
    const d = err('42', 'yaml', 'xml'); expect(d.stage).toBe('convert');
  });
  it('locate clamps out-of-range positions', () => {
    expect(locate('ab\ncd', 9, 9)).toEqual({ line: 2, col: 3, from: 4, to: 5 });
    expect(locate('ab', 1, 1)).toEqual({ line: 1, col: 1, from: 0, to: 1 });
    expect(locate('x', null, null).from).toBeNull();
  });
});
