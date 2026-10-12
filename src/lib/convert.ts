// Thin typed wrapper around the Rust/WASM converter. The WASM module is loaded lazily.
export type Format = 'json' | 'yaml' | 'xml';
export interface ConvertOptions { rootName?: string; invalidNames?: 'sanitize' | 'error'; inferTypes?: boolean; indent?: number; multiDoc?: 'array' | 'error' }
export type ConvertResult = { ok: true; output: string } | { ok: false; message: string; line: number | null; col: number | null };
export type ConvertFn = (input: string, from: Format, to: Format, opts?: ConvertOptions) => ConvertResult;

export const EXT: Record<Format, string> = { json: 'json', yaml: 'yaml', xml: 'xml' };
export const MIME: Record<Format, string> = { json: 'application/json', yaml: 'application/yaml', xml: 'application/xml' };

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
  const t = text.trimStart();
  if (t.startsWith('<')) return 'xml';
  if (t.startsWith('{') || t.startsWith('[')) return 'json';
  return t ? 'yaml' : null;
}
