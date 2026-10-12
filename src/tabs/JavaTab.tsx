import { locate } from '../lib/convert';
import { useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from '../components/CodeEditor';
import { persist, pick, isStr, isBool, oneOf } from '../lib/storage';
import { generateJava, DEFAULT_JAVA_OPTIONS, JavaOptions } from '../lib/java';

const SAMPLE = JSON.stringify({
  request_id: 'req-42', created_at: '2026-10-13T10:00:00Z', dry_run: false, amount: 1999.99, retry_count: 3, trace_id: 12345678901,
  customer: { customer_id: 77, full_name: 'Ada Lovelace', 'e-mail': 'ada@example.com', address: { street: '1 Main St', city: 'London', zip_code: 'NW1' } },
  items: [{ sku: 'A-1', qty: 2, unit_price: 9.5, tags: ['red'] }, { sku: 'B-2', qty: 1, discount: { code: 'SAVE10', pct: 10 } }],
  class: 'premium', metadata: null,
}, null, 2);

export default function JavaTab({ getViewerText }: { getViewerText: () => string }) {
  const [saved] = useState(() => persist.load('java', x => {
    if (!x || typeof x !== 'object') return undefined;
    const r = x as { input?: unknown; options?: unknown };
    const D = DEFAULT_JAVA_OPTIONS;
    const options = pick(r.options, D, {
      className: isStr, packageName: isStr, mode: oneOf(['class', 'lombok', 'record'] as const), gettersSetters: isBool, constructors: isBool,
      toStringEqualsHashCode: isBool, lombokBuilder: isBool, primitives: isBool, bigDecimal: isBool, ignoreUnknown: isBool, includeNonNull: isBool, reuseClasses: isBool,
    }) ?? D;
    return { input: isStr(r.input) ? r.input : SAMPLE, options };
  }));
  const [input, setInput] = useState(saved?.input ?? SAMPLE);
  const [debounced, setDebounced] = useState(saved?.input ?? SAMPLE);
  const [o, setO] = useState<JavaOptions>(saved?.options ?? DEFAULT_JAVA_OPTIONS);
  useEffect(() => { persist.save('java', { input, options: o }); }, [input, o]);
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const id = setTimeout(() => setDebounced(input), 150); return () => clearTimeout(id); }, [input]);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(''), 2500); return () => clearTimeout(id); }, [note]);
  const res = useMemo(() => generateJava(debounced, o), [debounced, o]);
  const [lastCode, setLastCode] = useState('');
  useEffect(() => { if (res.ok) setLastCode(res.code); }, [res]);
  const javaDiag = useMemo(() => {
    if (res.ok || res.line == null || debounced !== input) return null;
    const l = locate(input, res.line, res.col ?? 1);
    return [{ from: l.from!, to: l.to!, message: res.message }];
  }, [res, debounced, input]);
  const fileName = (res.ok ? res.classes[0] : o.className || 'Request') + '.java';
  const set = (p: Partial<JavaOptions>) => setO(x => ({ ...x, ...p }));
  const chk = (k: keyof JavaOptions, label: string, disabled = false) => (
    <label className={disabled ? 'dis' : ''}><input type="checkbox" checked={o[k] as boolean} disabled={disabled} onChange={e => set({ [k]: e.target.checked } as Partial<JavaOptions>)} aria-label={label} /> {label}</label>
  );
  const download = () => {
    const url = URL.createObjectURL(new Blob([lastCode], { type: 'text/x-java-source' }));
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const isClass = o.mode === 'class';
  return (
    <div className="javatab">
      <header className="toolbar">
        <label>Class <input aria-label="class name" value={o.className} onChange={e => set({ className: e.target.value })} size={12} /></label>
        <label>Package <input aria-label="package name" value={o.packageName} onChange={e => set({ packageName: e.target.value })} placeholder="com.example.dto" size={16} /></label>
        <label>Style <select aria-label="mode" value={o.mode} onChange={e => set({ mode: e.target.value as JavaOptions['mode'] })}>
          <option value="class">Class (getters/setters)</option><option value="lombok">Lombok</option><option value="record">Java record</option>
        </select></label>
        <span className="sep" />
        <button onClick={() => setInput(getViewerText())}>Use viewer JSON</button>
        <button onClick={() => fileRef.current?.click()}>Upload</button>
        <input ref={fileRef} type="file" hidden accept=".json,application/json" onChange={async e => { const f = e.target.files?.[0]; if (f) setInput(await f.text()); e.target.value = ''; }} />
        <button onClick={() => setInput(SAMPLE)}>Sample</button>
        <span className="sep" />
        <button disabled={!lastCode} onClick={() => navigator.clipboard?.writeText(lastCode).then(() => setNote('Copied Java'), () => setNote('Copy failed'))}>Copy</button>
        <button disabled={!lastCode} onClick={download} data-testid="java-download">Download {fileName}</button>
        {note ? <span className="note">{note}</span> : null}
      </header>
      <div className="optbar">
        {chk('gettersSetters', 'Getters/setters', !isClass)}
        {chk('constructors', 'Constructors', !isClass)}
        {chk('toStringEqualsHashCode', 'toString/equals/hashCode', !isClass)}
        {chk('lombokBuilder', '@Builder', o.mode !== 'lombok')}
        {chk('primitives', 'Primitives')}
        {chk('bigDecimal', 'BigDecimal for decimals')}
        {chk('ignoreUnknown', '@JsonIgnoreProperties(ignoreUnknown)')}
        {chk('includeNonNull', '@JsonInclude(NON_NULL)')}
        {chk('reuseClasses', 'Reuse identical classes')}
      </div>
      <main className="split2">
        <section className="pane">
          <div className="panehead">JSON request</div>
          <CodeEditor value={input} onChange={setInput} lang="json" testId="java-input" diagnostics={javaDiag} />
          <div className={'status' + (res.ok ? '' : ' err')} data-testid="java-status">
            {res.ok ? `✔ ${res.classes.length} class${res.classes.length > 1 ? 'es' : ''}: ${res.classes.join(', ')}` : `✖ ${res.line ? `Line ${res.line}, Col ${res.col}: ` : ''}${res.message}${lastCode ? ' — showing last generated code' : ''}`}
          </div>
        </section>
        <section className="pane">
          <div className="panehead">{fileName}</div>
          <CodeEditor value={lastCode} lang="java" readOnly testId="java-output" />
        </section>
      </main>
    </div>
  );
}
