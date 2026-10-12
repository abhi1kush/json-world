// JSON -> Java value object generator (Jackson annotations). Pure, UI-free.
import { JNode, parse } from './json';

export interface JavaOptions {
  className: string;
  packageName: string;
  mode: 'class' | 'lombok' | 'record';
  gettersSetters: boolean;
  constructors: boolean;
  toStringEqualsHashCode: boolean;
  lombokBuilder: boolean;
  primitives: boolean;
  bigDecimal: boolean;
  ignoreUnknown: boolean;
  includeNonNull: boolean;
  reuseClasses: boolean;
}
export const DEFAULT_JAVA_OPTIONS: JavaOptions = {
  className: 'Request', packageName: '', mode: 'lombok', gettersSetters: false, constructors: true,
  toStringEqualsHashCode: false, lombokBuilder: false, primitives: false, bigDecimal: false,
  ignoreUnknown: false, includeNonNull: false, reuseClasses: true,
};

// ------------------------------------------------------------------ type inference
export type JType =
  | { k: 'string' } | { k: 'bool' } | { k: 'int' } | { k: 'long' } | { k: 'bigint' } | { k: 'double' } | { k: 'bigdec' }
  | { k: 'null' } | { k: 'empty' } | { k: 'any' } | { k: 'list'; of: JType } | { k: 'obj'; shape: Shape };
export interface Field { type: JType; seen: number; nullSeen: boolean }
export interface Shape { fields: Map<string, Field>; samples: number }

const INT_MIN = -(2n ** 31n), INT_MAX = 2n ** 31n - 1n, LONG_MIN = -(2n ** 63n), LONG_MAX = 2n ** 63n - 1n;
export function numberType(raw: string): JType {
  if (/^-?\d+$/.test(raw)) {
    const v = BigInt(raw);
    if (v >= INT_MIN && v <= INT_MAX) return { k: 'int' };
    if (v >= LONG_MIN && v <= LONG_MAX) return { k: 'long' };
    return { k: 'bigint' };
  }
  return { k: 'double' };
}

export function infer(n: JNode): JType {
  switch (n.t) {
    case 'string': return { k: 'string' };
    case 'boolean': return { k: 'bool' };
    case 'null': return { k: 'null' };
    case 'number': return numberType(n.raw);
    case 'array': return { k: 'list', of: n.items.reduce<JType>((acc, x) => merge(acc, infer(x)), { k: 'empty' }) };
    case 'object': {
      const fields = new Map<string, Field>();
      for (const [k, v] of n.entries) {
        const t = infer(v);
        const prev = fields.get(k); // duplicate keys: merge
        fields.set(k, prev ? { type: merge(prev.type, t), seen: 1, nullSeen: prev.nullSeen || t.k === 'null' } : { type: t, seen: 1, nullSeen: t.k === 'null' });
      }
      return { k: 'obj', shape: { fields, samples: 1 } };
    }
  }
}

const NUM_RANK: Record<string, number> = { int: 0, long: 1, bigint: 2, double: 3, bigdec: 4 };
export function merge(a: JType, b: JType): JType {
  if (a.k === 'empty') return b;
  if (b.k === 'empty') return a;
  if (a.k === 'null') return b;
  if (b.k === 'null') return a;
  if (a.k === 'any' || b.k === 'any') return { k: 'any' };
  if (a.k in NUM_RANK && b.k in NUM_RANK) {
    const ks = new Set([a.k, b.k]);
    if (ks.has('bigdec') || (ks.has('bigint') && ks.has('double'))) return { k: 'bigdec' };
    return NUM_RANK[a.k] >= NUM_RANK[b.k] ? a : b;
  }
  if (a.k !== b.k) return { k: 'any' };
  if (a.k === 'list' && b.k === 'list') return { k: 'list', of: merge(a.of, b.of) };
  if (a.k === 'obj' && b.k === 'obj') return { k: 'obj', shape: mergeShapes(a.shape, b.shape) };
  return a;
}
function mergeShapes(a: Shape, b: Shape): Shape {
  const fields = new Map<string, Field>();
  for (const [k, f] of a.fields) {
    const g = b.fields.get(k);
    fields.set(k, g ? { type: merge(f.type, g.type), seen: f.seen + g.seen, nullSeen: f.nullSeen || g.nullSeen } : { ...f });
  }
  for (const [k, g] of b.fields) if (!a.fields.has(k)) fields.set(k, { ...g });
  return { fields, samples: a.samples + b.samples };
}

// ------------------------------------------------------------------ naming
export const JAVA_KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null _').split(' '));
/** Keywords plus contextual/restricted identifiers (avoided for generated names). */
export const JAVA_RESERVED = new Set([...JAVA_KEYWORDS, ...'var record yield sealed permits when module open exports requires'.split(' ')]);
/** Type names a generated class must not shadow. */
const RESERVED_TYPES = new Set(['String', 'Object', 'List', 'Integer', 'Long', 'Double', 'Boolean', 'BigInteger', 'BigDecimal', 'Objects', 'Override', 'JsonProperty', 'JsonIgnoreProperties', 'JsonInclude', 'JsonAutoDetect', 'Record', 'Class', 'Math', 'System', 'Number', 'Character', 'Void', 'Short', 'Byte', 'Float', 'Enum', 'Thread', 'Runtime', 'Exception', 'Error', 'Iterable', 'Comparable']);

function words(key: string): string[] {
  return key.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
function lowerFirstWord(w: string): string {
  const m = /^(\p{Lu}+)(.*)$/u.exec(w);
  if (!m) return w;
  const [, up, rest] = m;
  if (up.length === 1 || !rest) return up.toLowerCase() + rest;
  // "HTTPStatus" -> "httpStatus": keep the last capital as the start of the next word if followed by lowercase
  return /^\p{Ll}/u.test(rest) ? up.slice(0, -1).toLowerCase() + up.slice(-1) + rest : up.toLowerCase() + rest;
}
const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/** camelCase Java identifier for a JSON key (not yet deduplicated). */
export function toFieldName(key: string): string {
  const ws = words(key);
  if (!ws.length) return 'field';
  let name = lowerFirstWord(ws[0]) + ws.slice(1).map(cap).join('');
  if (/^\p{N}/u.test(name)) name = 'field' + name;
  if (JAVA_RESERVED.has(name)) name += 'Value';
  return name;
}
/** PascalCase Java class name for a key (not yet deduplicated). */
export function toClassName(key: string): string {
  const ws = words(key);
  let name = ws.map(w => cap(lowerFirstWord(w))).join('');
  if (!name) name = 'Item';
  if (/^\p{N}/u.test(name)) name = 'Type' + name;
  return name;
}
const IRREGULAR: Record<string, string> = { people: 'person', children: 'child', men: 'man', women: 'woman', mice: 'mouse', geese: 'goose', feet: 'foot', teeth: 'tooth', criteria: 'criterion', indices: 'index', matrices: 'matrix', vertices: 'vertex', analyses: 'analysis', statuses: 'status', aliases: 'alias', addresses: 'address', buses: 'bus' };
/** Singularize the last word of a name; returns null if it doesn't look plural. */
export function singularize(word: string): string | null {
  const lower = word.toLowerCase();
  for (const [pl, sg] of Object.entries(IRREGULAR)) {
    if (lower.endsWith(pl)) { const tail = word.slice(-pl.length); return word.slice(0, -pl.length) + (tail[0] !== tail[0].toLowerCase() ? cap(sg) : sg); }
  }
  if (/[^aeiou]ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ss|x|z|ch|sh)es$/i.test(word)) return word.slice(0, -2);
  if (/[^su]s$/i.test(word) && !/(is|us|ss)$/i.test(word)) return word.slice(0, -1);
  return null;
}
/** Class name for the elements of an array stored under `key`. */
export function itemClassName(key: string): string {
  const base = toClassName(key);
  const m = /^(.*?)(\p{Lu}[\p{Ll}\p{N}]*|[\p{Ll}\p{N}]+)$/u.exec(base);
  if (m) {
    const s = singularize(m[2]);
    if (s) { const r = m[1] + cap(s); if (r) return r; }
  }
  return base + 'Item';
}

// ------------------------------------------------------------------ class model
interface JField { key: string; name: string; type: JType; nullable: boolean }
interface JClass { name: string; fields: JField[]; sig: string }

function sigOf(t: JType, o: JavaOptions): string {
  switch (t.k) {
    case 'list': return `L<${sigOf(t.of, o)}>`;
    case 'obj': return `{${[...t.shape.fields].map(([k, f]) => `${JSON.stringify(k)}:${sigOf(f.type, o)}${isNullable(f, t.shape) ? '?' : ''}`).join(',')}}`;
    default: return t.k;
  }
}
const isNullable = (f: Field, s: Shape) => f.nullSeen || f.seen < s.samples || f.type.k === 'null';

export interface GenResult { ok: true; code: string; classes: string[] }
export interface GenError { ok: false; message: string; line?: number; col?: number }

export function generateJava(input: string | JNode, opts: Partial<JavaOptions> = {}): GenResult | GenError {
  const o: JavaOptions = { ...DEFAULT_JAVA_OPTIONS, ...opts };
  let root: JNode;
  if (typeof input === 'string') {
    const r = parse(input);
    if (!r.ok) return { ok: false, message: r.error.message, line: r.error.line, col: r.error.col };
    root = r.node;
  } else root = input;

  const topName = sanitizeTypeName(o.className.trim() || 'Request');
  if (o.packageName.trim() && !/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(o.packageName.trim()))
    return { ok: false, message: `Invalid package name '${o.packageName}'` };
  if (o.packageName.trim() && o.packageName.trim().split('.').some(p => JAVA_KEYWORDS.has(p)))
    return { ok: false, message: `Package name '${o.packageName}' contains a Java keyword` };

  let t = infer(root);
  if (t.k === 'list') {
    let inner: JType = t;
    while (inner.k === 'list') inner = inner.of;
    if (inner.k !== 'obj') return { ok: false, message: 'Top-level array must contain objects to generate a class (found ' + describe(inner) + ')' };
    t = inner;
  }
  if (t.k !== 'obj') return { ok: false, message: `Top-level JSON must be an object or an array of objects (found ${describe(t)})` };

  const classes: JClass[] = [];
  const used = new Set<string>([topName]);
  const bySig = new Map<string, string>();
  const reservedTypes = o.mode === 'lombok' ? new Set([...RESERVED_TYPES, 'Data', 'Builder', 'NoArgsConstructor', 'AllArgsConstructor']) : RESERVED_TYPES;
  const uniqueClass = (base: string) => {
    let n = sanitizeTypeName(base);
    if (n === topName || reservedTypes.has(n) || used.has(n)) { let i = 2; while (used.has(n + i) || reservedTypes.has(n + i)) i++; n = n + i; }
    used.add(n);
    return n;
  };
  const typeNames = new Map<Shape, string>();
  // depth-first: build fields for a shape, registering nested classes
  const build = (shape: Shape, name: string, isTop: boolean): JClass => {
    const cls: JClass = { name, fields: [], sig: '' };
    if (!isTop) classes.push(cls);
    const usedFields = new Set<string>();
    for (const [key, f] of shape.fields) {
      let fname = toFieldName(key);
      if (usedFields.has(fname)) { let i = 2; while (usedFields.has(fname + i)) i++; fname = fname + i; }
      usedFields.add(fname);
      cls.fields.push({ key, name: fname, type: f.type, nullable: isNullable(f, shape) });
      registerNested(f.type, key, false);
    }
    return cls;
  };
  const registerNested = (t: JType, key: string, asItem: boolean) => {
    if (t.k === 'list') return registerNested(t.of, key, true);
    if (t.k !== 'obj' || !t.shape.fields.size) return; // {} -> Map<String, Object>
    const sig = sigOf(t, o);
    if (o.reuseClasses && bySig.has(sig)) { typeNames.set(t.shape, bySig.get(sig)!); return; }
    const name = uniqueClass(asItem ? itemClassName(key) : toClassName(key));
    typeNames.set(t.shape, name);
    bySig.set(sig, name);
    build(t.shape, name, false);
  };
  const top = build(t.shape, topName, true);

  const imports = new Set<string>(['com.fasterxml.jackson.annotation.JsonProperty']);
  const javaType = (t: JType, boxed: boolean): string => {
    switch (t.k) {
      case 'string': return 'String';
      case 'bool': return boxed ? 'Boolean' : 'boolean';
      case 'int': return boxed ? 'Integer' : 'int';
      case 'long': return boxed ? 'Long' : 'long';
      case 'bigint': imports.add('java.math.BigInteger'); return 'BigInteger';
      case 'double': if (o.bigDecimal) { imports.add('java.math.BigDecimal'); return 'BigDecimal'; } return boxed ? 'Double' : 'double';
      case 'bigdec': imports.add('java.math.BigDecimal'); return 'BigDecimal';
      case 'list': imports.add('java.util.List'); return `List<${javaType(t.of, true)}>`;
      case 'obj':
        if (!t.shape.fields.size) { imports.add('java.util.Map'); return 'Map<String, Object>'; } // unknown shape
        return typeNames.get(t.shape)!;
      default: return 'Object';
    }
  };
  const fieldType = (f: JField) => javaType(f.type, !(o.primitives && !f.nullable));

  // ---------------------------------------------------------------- emit
  const out: string[] = [];
  const ind = (n: number) => '    '.repeat(n);
  const classAnnotations = (cls: JClass, level: number): string[] => {
    const a: string[] = [];
    if (o.ignoreUnknown) { imports.add('com.fasterxml.jackson.annotation.JsonIgnoreProperties'); a.push('@JsonIgnoreProperties(ignoreUnknown = true)'); }
    if (o.includeNonNull) { imports.add('com.fasterxml.jackson.annotation.JsonInclude'); a.push('@JsonInclude(JsonInclude.Include.NON_NULL)'); }
    if (o.mode === 'lombok') {
      imports.add('lombok.Data'); imports.add('lombok.NoArgsConstructor');
      a.push('@Data', '@NoArgsConstructor');
      // with no fields @AllArgsConstructor would duplicate the no-arg constructor
      if (cls.fields.length) { imports.add('lombok.AllArgsConstructor'); a.push('@AllArgsConstructor'); }
      if (o.lombokBuilder) { imports.add('lombok.Builder'); a.push('@Builder'); }
      // Lombok accessor names can imply different Jackson property names (e.g. getAB() -> "ab"); use fields only then.
      if (cls.fields.some(f => accessorMismatch(f, fieldType(f), true))) {
        imports.add('com.fasterxml.jackson.annotation.JsonAutoDetect');
        a.push('@JsonAutoDetect(fieldVisibility = JsonAutoDetect.Visibility.ANY, getterVisibility = JsonAutoDetect.Visibility.NONE, isGetterVisibility = JsonAutoDetect.Visibility.NONE, setterVisibility = JsonAutoDetect.Visibility.NONE)');
      }
    }
    return a.map(x => ind(level) + x);
  };

  const emitClass = (cls: JClass, level: number, nested: JClass[]) => {
    const kw = level === 0 ? 'public' : 'public static';
    out.push(...classAnnotations(cls, level));
    if (o.mode === 'record') {
      const comps = cls.fields.map(f => `${ind(level + 2)}@JsonProperty(${JSON.stringify(f.key)}) ${fieldType(f)} ${f.name}`);
      if (!comps.length) out.push(`${ind(level)}public record ${cls.name}() {`);
      else { out.push(`${ind(level)}public record ${cls.name}(`); out.push(comps.join(',\n')); out.push(`${ind(level)}) {`); }
    } else {
      out.push(`${ind(level)}${kw} class ${cls.name} {`);
      if (cls.fields.length) out.push('');
      for (const f of cls.fields) {
        out.push(`${ind(level + 1)}@JsonProperty(${JSON.stringify(f.key)})`);
        out.push(`${ind(level + 1)}private ${fieldType(f)} ${f.name};`);
      }
      if (o.mode === 'class') emitBoilerplate(cls, level + 1);
    }
    for (const n of nested) { out.push(''); emitClass(n, level + 1, []); }
    if (o.mode === 'record' && !nested.length && out[out.length - 1].endsWith('{')) out[out.length - 1] += '}';
    else out.push(`${ind(level)}}`);
  };
  const emitBoilerplate = (cls: JClass, l: number) => {
    const fs = cls.fields;
    if (o.constructors) {
      out.push('', `${ind(l)}public ${cls.name}() {`, `${ind(l)}}`);
      if (fs.length) {
        out.push('', `${ind(l)}public ${cls.name}(${fs.map(f => `${fieldType(f)} ${f.name}`).join(', ')}) {`);
        for (const f of fs) out.push(`${ind(l + 1)}this.${f.name} = ${f.name};`);
        out.push(`${ind(l)}}`);
      }
    }
    if (o.gettersSetters) for (const f of fs) {
      const T = fieldType(f), P = cap(f.name);
      const ann = accessorMismatch(f, T, false) ? [`${ind(l)}@JsonProperty(${JSON.stringify(f.key)})`] : [];
      out.push('', ...ann, `${ind(l)}public ${T} get${P}() {`, `${ind(l + 1)}return ${f.name};`, `${ind(l)}}`);
      out.push('', ...ann, `${ind(l)}public void set${P}(${T} ${f.name}) {`, `${ind(l + 1)}this.${f.name} = ${f.name};`, `${ind(l)}}`);
    }
    if (o.toStringEqualsHashCode) {
      imports.add('java.util.Objects');
      const prim = (f: JField) => /^(int|long|double|boolean)$/.test(fieldType(f));
      out.push('', `${ind(l)}@Override`, `${ind(l)}public boolean equals(Object o) {`, `${ind(l + 1)}if (this == o) return true;`, `${ind(l + 1)}if (o == null || getClass() != o.getClass()) return false;`);
      if (fs.length) {
        out.push(`${ind(l + 1)}${cls.name} that = (${cls.name}) o;`);
        out.push(`${ind(l + 1)}return ${fs.map(f => (prim(f) ? (fieldType(f) === 'double' ? `Double.compare(${f.name}, that.${f.name}) == 0` : `${f.name} == that.${f.name}`) : `Objects.equals(${f.name}, that.${f.name})`)).join(`\n${ind(l + 2)}&& `)};`);
      } else out.push(`${ind(l + 1)}return true;`);
      out.push(`${ind(l)}}`);
      out.push('', `${ind(l)}@Override`, `${ind(l)}public int hashCode() {`, `${ind(l + 1)}return Objects.hash(${fs.map(f => f.name).join(', ')});`, `${ind(l)}}`);
      out.push('', `${ind(l)}@Override`, `${ind(l)}public String toString() {`);
      out.push(`${ind(l + 1)}return "${cls.name}{" +`);
      fs.forEach((f, i) => out.push(`${ind(l + 3)}"${i ? ', ' : ''}${f.name}=" + ${f.name} +`));
      out.push(`${ind(l + 3)}"}";`, `${ind(l)}}`);
    }
  };

  const body: string[] = [];
  emitClass(top, 0, classes);
  body.push(...out);
  const header: string[] = [];
  if (o.packageName.trim()) header.push(`package ${o.packageName.trim()};`, '');
  const imps = [...imports].sort((a, b) => importRank(a) - importRank(b) || (a < b ? -1 : 1));
  let lastGroup = -1;
  for (const i of imps) { const g = importRank(i); if (lastGroup !== -1 && g !== lastGroup) header.push(''); header.push(`import ${i};`); lastGroup = g; }
  header.push('');
  return { ok: true, code: header.join('\n') + '\n' + body.join('\n') + '\n', classes: [topName, ...classes.map(c => c.name)] };
}
const importRank = (i: string) => (i.startsWith('com.') ? 0 : i.startsWith('lombok.') ? 1 : 2);

/** Jackson's default implicit property name from an accessor suffix (legacy mangling: lowercase the leading uppercase run). */
export function jacksonImplicitName(suffix: string): string {
  let i = 0;
  while (i < suffix.length && suffix[i] !== suffix[i].toLowerCase()) i++;
  return suffix.slice(0, i).toLowerCase() + suffix.slice(i);
}
/** True when the accessor generated for a field would make Jackson see a different property name than the field's. */
function accessorMismatch(f: JField, javaT: string, lombok: boolean): boolean {
  const suffix = cap(f.name);
  if (lombok && javaT === 'boolean' && /^is\p{Lu}/u.test(f.name)) return true; // Lombok: isActive field -> isActive() getter -> "active"
  return jacksonImplicitName(suffix) !== f.name;
}
function sanitizeTypeName(n: string): string {
  let s = n.replace(/[^\p{L}\p{N}_$]/gu, '');
  if (!s) s = 'Request';
  if (/^\p{N}/u.test(s)) s = '_' + s;
  if (JAVA_RESERVED.has(s)) s = cap(s) === s ? s + 'Type' : cap(s);
  return s;
}
function describe(t: JType): string {
  return t.k === 'empty' ? 'an empty array' : t.k === 'list' ? 'nested arrays' : t.k === 'any' ? 'mixed values' : t.k;
}
