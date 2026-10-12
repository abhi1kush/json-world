// Generates Java sources for every sample x mode into OUT_DIR, plus a cases.txt manifest.
// Run via: npx vite-node scripts/java-verify/gen.ts <outDir>
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { generateJava, JavaOptions } from '../../src/lib/java';

const out = process.argv[2] ?? '/tmp/json-world-java';
const here = new URL('.', import.meta.url).pathname;
const variants: Record<string, Partial<JavaOptions>> = {
  plain: { mode: 'class', toStringEqualsHashCode: true },
  plainFields: { mode: 'class', gettersSetters: false, constructors: false, ignoreUnknown: true, includeNonNull: true },
  plainPrimBigDec: { mode: 'class', primitives: true, bigDecimal: true, reuseClasses: false },
  lombok: { mode: 'lombok', lombokBuilder: true, ignoreUnknown: true },
  lombokPrim: { mode: 'lombok', primitives: true, includeNonNull: true },
  record: { mode: 'record', ignoreUnknown: true },
  recordBigDec: { mode: 'record', bigDecimal: true, primitives: true, includeNonNull: true },
};
const cases: string[] = [];
for (const file of readdirSync(join(here, 'samples')).filter(f => f.endsWith('.json')).sort()) {
  const json = readFileSync(join(here, 'samples', file), 'utf8');
  const sample = basename(file, '.json').replace(/-/g, '_');
  for (const [v, o] of Object.entries(variants)) {
    const pkg = `verify.${sample}.${v.toLowerCase()}`;
    const r = generateJava(json, { ...o, packageName: pkg, className: 'Request' });
    if (!r.ok) throw new Error(`${file}/${v}: ${r.message}`);
    const dir = join(out, 'src', ...pkg.split('.'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Request.java'), r.code);
    cases.push([`${pkg}.Request`, join(here, 'samples', file), json.trim().startsWith('[') ? 'array' : 'object', o.ignoreUnknown ? 'ignoreUnknown' : '-', o.mode].join('\t'));
  }
}
writeFileSync(join(out, 'cases.txt'), cases.join('\n') + '\n');
console.log(`generated ${cases.length} cases in ${out}`);
