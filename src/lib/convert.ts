import { parse as parseJson } from './json';

// Thin typed wrapper around the Rust/WASM converter. The WASM module is loaded lazily.
export type Format = 'json' | 'yaml' | 'xml' | 'properties';
export interface ConvertOptions { rootName?: string; invalidNames?: 'sanitize' | 'error'; inferTypes?: boolean; indent?: number; multiDoc?: 'array' | 'error'; escapeUnicode?: boolean }
export type ConvertResult = { ok: true; output: string } | { ok: false; message: string; line: number | null; col: number | null };
export type ConvertFn = (input: string, from: Format, to: Format, opts?: ConvertOptions) => ConvertResult;

export const EXT: Record<Format, string> = { json: 'json', yaml: 'yaml', xml: 'xml', properties: 'properties' };
export const MIME: Record<Format, string> = { json: 'application/json', yaml: 'application/yaml', xml: 'application/xml', properties: 'text/x-java-properties' };

export function wrap(raw: (i: string, f: string, t: string, o: string) => string): ConvertFn {
  return (input, from, to, opts = {}) => JSON.parse(raw(input, from, to, JSON.stringify(opts))) as ConvertResult;
}

let loading: Promise<ConvertFn> | null = null;
/** Dynamically imports and instantiates the WASM module (only once). */
export function loadConverter(): Promise<ConvertFn> {
  if (!loading) {
    loading = import('../../converter/pkg/converter.js').then(async m => {
      await m.default();
      return wrap(m.convert);
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

export function detectFormat(text: string, filename?: string): Format | null {
  const ext = filename?.split('.').pop()?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  if (ext === 'xml') return 'xml';
  if (ext === 'properties') return 'properties';
  const t = text.trimStart();
  if (t.startsWith('<')) return 'xml';
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  return t ? 'yaml' : null;
}

// ---------------------------------------------------------------- error surfacing
export const FORMAT_LABEL: Record<Format, string> = { json: 'JSON', yaml: 'YAML', xml: 'XML', properties: 'Properties' };

/** A located problem. line/col are 1-based; from/to are document offsets for an editor mark (null when unknown). */
export interface ConvDiag { title: string; message: string; line: number | null; col: number | null; from: number | null; to: number | null; stage: 'parse' | 'convert' }
export type ConvState = { kind: 'empty' } | { kind: 'ok'; output: string } | { kind: 'error'; diag: ConvDiag };

const lineStarts = (s: string) => { const r = [0]; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) r.push(i + 1); return r; };

/** Clamp a (possibly off) parser position into the document and derive an offset range for an editor mark. */
export function locate(input: string, line: number | null, col: number | null): Pick<ConvDiag, 'line' | 'col' | 'from' | 'to'> {
  if (line == null) return { line: null, col: null, from: null, to: null };
  const starts = lineStarts(input);
  let l = Math.max(1, line), c = Math.max(1, col ?? 1);
  if (l > starts.length) { l = starts.length; c = Infinity; }
  const ls = starts[l - 1];
  const le = l < starts.length ? starts[l] - 1 : input.length;
  c = Math.min(c, le - ls + 1); // never past the end of the line
  const at = ls + c - 1;
  // mark the offending char; at end of line mark the previous char (or nothing on an empty line)
  return at < le ? { line: l, col: c, from: at, to: at + 1 } : { line: l, col: c, from: Math.max(ls, at - 1), to: at };
}

/** Parser-specific position fixes so the reported column points at the offending character. */
function refine(input: string, from: Format, message: string, line: number | null, col: number | null): [number | null, number | null] {
  if (line == null || from !== 'yaml') return [line, col];
  const text = input.split('\n')[line - 1];
  if (text == null) return [line, col];
  if (/tab/i.test(message) && text.includes('\t')) return [line, text.indexOf('\t') + 1];
  if (/did not find expected (key|'-' indicator)|mapping values are not allowed/.test(message)) {
    const i = text.search(/\S/); if (i >= 0 && /did not find/.test(message)) return [line, i + 1];
  }
  return [line, col];
}

/** For path-only conversion errors (e.g. "Invalid XML name 'a b' at $.x"), find the key in the JSON source. */
function findKey(input: string, message: string): [number, number] | null {
  const m = /(?:name|Key) '([^']*)'/.exec(message); if (!m) return null;
  const i = input.indexOf(JSON.stringify(m[1]));
  if (i < 0) return null;
  const before = input.slice(0, i).split('\n');
  return [before.length, before[before.length - 1].length + 1];
}

/**
 * Run a conversion and classify the outcome. Empty input is neutral; JSON input is validated with our own
 * parser first (its positions are exact, serde's can be 0-based or past EOF); YAML/XML errors are split into
 * "input is invalid" vs "valid input can't be converted to the target".
 */
export function runConvert(conv: ConvertFn, input: string, from: Format, to: Format, opts: ConvertOptions = {}): ConvState {
  if (!input.trim()) return { kind: 'empty' };
  const F = FORMAT_LABEL[from], T = FORMAT_LABEL[to];
  if (from === 'json') {
    const p = parseJson(input);
    if (!p.ok) {
      const atEnd = !input.slice(lineStarts(input)[p.error.line - 1] + p.error.col - 1).trim();
      const message = atEnd && !/end of input|unterminated/i.test(p.error.message) ? `Unexpected end of input (unclosed bracket or brace?): ${p.error.message}` : p.error.message;
      return { kind: 'error', diag: { title: `Invalid JSON`, message, stage: 'parse', ...locate(input, p.error.line, p.error.col) } };
    }
  }
  const r = conv(input, from, to, opts);
  if (r.ok) return { kind: 'ok', output: r.output };
  let stage: ConvDiag['stage'] = 'parse';
  if (from === 'json') stage = 'convert';
  else if (to !== 'json') { const pj = conv(input, from, 'json', opts); if (pj.ok) stage = 'convert'; }
  let line = r.line, col = r.col;
  if (stage === 'parse') [line, col] = refine(input, from, r.message, line, col);
  else if (line == null && from === 'json') {
    if (/top-level/.test(r.message)) { const i = input.search(/\S/); const b = input.slice(0, i).split('\n'); line = b.length; col = b[b.length - 1].length + 1; }
    else { const k = findKey(input, r.message); if (k) [line, col] = k; }
  }
  const message = r.message.replace(/^JSON → (XML|Properties): /, '');
  return { kind: 'error', diag: { title: stage === 'parse' ? `Invalid ${F}` : `Can't convert ${F} → ${T}`, message, stage, ...locate(input, line, col) } };
}

/** Human text for the banner, e.g. "Invalid JSON at line 3, column 5: Trailing comma". */
export const diagText = (d: ConvDiag) => `${d.title}${d.line != null ? ` at line ${d.line}, column ${d.col}` : ''}: ${d.message}`;
