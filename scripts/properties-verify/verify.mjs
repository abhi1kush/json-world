// Verifies the WASM JSON -> .properties output loads in java.util.Properties with exactly the expected values,
// and that files written by Properties.store parse back (properties -> JSON) to the same values.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { initSync, convert } from '../../converter/pkg/converter.js';
const OUT = process.argv[2] ?? '/tmp/json-world-props';
const CLS = process.argv[3];
mkdirSync(OUT, { recursive: true });
initSync({ module: readFileSync(new URL('../../converter/pkg/converter_bg.wasm', import.meta.url)) });
const run = (i, f, t, o) => { const r = JSON.parse(convert(i, f, t, JSON.stringify(o))); if (!r.ok) throw new Error(r.message); return r.output; };

// Independent reference flattening (what Spring-style keys + string values should be).
const flat = (v, p, out) => {
  if (v && typeof v === 'object' && Object.keys(v).length) {
    if (Array.isArray(v)) v.forEach((x, i) => flat(x, `${p}[${i}]`, out));
    else for (const [k, x] of Object.entries(v)) flat(x, p ? `${p}.${k}` : k, out);
  } else out[p] = v === null || typeof v === 'object' ? '' : String(v);
  return out;
};
const CASES = {
  nested: { server: { port: 8080, ssl: true, address: '0.0.0.0', hosts: ['a.example', 'b.example'], users: [{ name: 'x', roles: ['admin', 'dev'] }, { name: 'y', roles: [] }] }, ratio: 0.25, nothing: null, emptyObj: {} },
  escaping: { 'key with spaces': '  two leading spaces', 'eq=colon:hash#bang!': 'v=1:2#3!4', backslash: 'C:\\temp\\new', multi: 'line1\nline2\r\n\ttabbed\f', unicode: 'é ü € 中文 😀', ctrl: '\u0001\u007f', trailing: 'ends with space ', empty: '', '#notcomment': '!notcomment' },
  matrix: { m: [[1, 2], [3, [4, 5]]], deep: { a: { b: { c: { d: [{ e: 'f' }] } } } } },
};
let fails = 0;
const javaLoad = (file, enc) => Object.fromEntries(execFileSync('java', ['-cp', CLS, 'LoadProps', 'load', file, enc], { encoding: 'utf8' }).split('\n').filter(Boolean).map(l => l.split('\t').map(s => JSON.parse(s))));
for (const [name, obj] of Object.entries(CASES)) {
  const expected = flat(obj, '', {});
  for (const [escapeUnicode, enc] of [[true, 'latin1'], [false, 'utf8']]) {
    const props = run(JSON.stringify(obj), 'json', 'properties', { escapeUnicode });
    const file = `${OUT}/${name}-${enc}.properties`; writeFileSync(file, props, 'utf8');
    if (escapeUnicode && /[^\x00-\x7f]/.test(props)) { console.log(`FAIL ${name}: non-ASCII byte in escaped output`); fails++; }
    const got = javaLoad(file, enc);
    const ok = JSON.stringify(Object.entries(got).sort()) === JSON.stringify(Object.entries(expected).sort());
    console.log(`${ok ? 'PASS' : 'FAIL'} JSON->properties loads in java.util.Properties (${name}, ${enc}, ${Object.keys(got).length} keys)`);
    if (!ok) { fails++; console.log(' expected', expected, '\n got', got); }
  }
  // reverse: Java's own store() output -> our parser -> same values
  const esc = s => s.split('').map(c => c.charCodeAt(0) > 0x7e || c.charCodeAt(0) < 0x20 || c === '\\' ? '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('');
  const tsv = `${OUT}/${name}.tsv`, stored = `${OUT}/${name}-stored.properties`;
  writeFileSync(tsv, Object.entries(expected).map(([k, v]) => `${esc(k)}\t${esc(v)}`).join('\n') + '\n');
  execFileSync('java', ['-cp', CLS, 'LoadProps', 'store', tsv, stored]);
  const back = JSON.parse(run(readFileSync(stored, 'latin1'), 'properties', 'json', {}));
  const ok2 = JSON.stringify(Object.entries(flat(back, '', {})).sort()) === JSON.stringify(Object.entries(expected).sort());
  console.log(`${ok2 ? 'PASS' : 'FAIL'} Properties.store output parses back to the same values (${name})`);
  if (!ok2) fails++;
}
console.log(fails ? `${fails} FAILED` : 'ALL PASSED'); process.exit(fails ? 1 : 0);
