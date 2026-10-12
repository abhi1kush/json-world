import { useEffect, useMemo, useRef, useState } from 'react';
import CodeEditor from '../components/CodeEditor';
import { persist, pick, isStr, isBool, oneOf } from '../lib/storage';
import { ConvertFn, ConvertOptions, ConvState, Format, EXT, MIME, detectFormat, loadConverter, runConvert, diagText } from '../lib/convert';

const SAMPLES: Record<Format, string> = {
  json: JSON.stringify({ library: { '@name': 'City', book: [{ '@id': '1', title: 'Dune', year: 1965 }, { '@id': '2', title: 'Emma', year: 1815 }], open: true } }, null, 2),
  yaml: 'defaults: &d\n  retries: 3\n  timeout: 30\nservices:\n  api:\n    <<: *d\n    port: 8080\n  worker:\n    <<: *d\n    retries: 5\nbig: 123456789012345678901234567890\n',
  properties: '# Spring Boot style keys\nserver.port=8080\nserver.ssl.enabled=true\nspring.datasource.url=jdbc:postgresql://localhost/app\napp.name = My App\napp.servers[0].host=a.example\napp.servers[0].port=80\napp.servers[1].host=b.example\napp.servers[1].port=81\napp.greeting: Hello, \\\n    world\n',
  xml: '<?xml version="1.0"?>\n<library name="City" xmlns:x="urn:x">\n  <book id="1"><title>Dune</title><year>1965</year></book>\n  <book id="2"><title>Emma</title><year>1815</year></book>\n  <x:note><![CDATA[<b>raw</b> & more]]></x:note>\n  <empty/>\n</library>\n',
};
const FORMATS: Format[] = ['json', 'yaml', 'xml', 'properties'];
const LABEL: Record<Format, string> = { json: 'JSON', yaml: 'YAML', xml: 'XML', properties: 'Properties' };

export default function ConvertTab({ onSendToViewer, getViewerText }: { onSendToViewer: (t: string) => void; getViewerText: () => string }) {
  const [conv, setConv] = useState<ConvertFn | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saved] = useState(() => {
    const fmt = oneOf(FORMATS);
    const s = persist.load('convert', x => pick(x, { from: 'json' as Format, to: 'yaml' as Format, input: SAMPLES.json, opts: {} as Record<string, unknown> }, { from: fmt, to: fmt, input: isStr, opts: v => !!v && typeof v === 'object' }));
    if (s && s.from === s.to) s.to = s.from === 'json' ? 'yaml' : 'json';
    return s;
  });
  const [from, setFrom] = useState<Format>(saved?.from ?? 'json');
  const [to, setTo] = useState<Format>(saved?.to ?? 'yaml');
  const [input, setInput] = useState(saved?.input ?? SAMPLES.json);
  const [result, setResult] = useState<ConvState | null>(null);
  const [lastOutput, setLastOutput] = useState('');
  const [opts, setOpts] = useState<ConvertOptions>(() => pick(saved?.opts, { rootName: 'root', invalidNames: 'sanitize', inferTypes: false, indent: 2, multiDoc: 'array', escapeUnicode: true } as Required<ConvertOptions>, {
    rootName: isStr, escapeUnicode: isBool, invalidNames: oneOf(['sanitize', 'error'] as const), inferTypes: isBool, indent: v => v === 0 || v === 2 || v === 4, multiDoc: oneOf(['array', 'error'] as const),
  }) ?? { rootName: 'root', invalidNames: 'sanitize', inferTypes: false, indent: 2, multiDoc: 'array', escapeUnicode: true });
  useEffect(() => { persist.save('convert', { from, to, input, opts }); }, [from, to, input, opts]);
  const [note, setNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadConverter().then(f => setConv(() => f)).catch(e => setLoadErr(String(e))); }, []);
  useEffect(() => {
    if (!conv) return;
    const id = setTimeout(() => setResult(runConvert(conv, input, from, to, opts)), 150);
    return () => clearTimeout(id);
  }, [conv, input, from, to, opts]);
  useEffect(() => { if (result?.kind === 'ok') setLastOutput(result.output); else if (result?.kind === 'empty') setLastOutput(''); }, [result]);
  // when the target format changes, the last valid output is in the wrong format: drop it
  useEffect(() => { setLastOutput(''); }, [to]);
  useEffect(() => { if (!note) return; const id = setTimeout(() => setNote(''), 2500); return () => clearTimeout(id); }, [note]);

  const ok = result?.kind === 'ok';
  const err = result?.kind === 'error' ? result.diag : null;
  const stale = !!err && !!lastOutput;
  const output = ok ? result.output : err ? lastOutput : '';
  const diags = useMemo(() => err && err.from != null && result?.kind === 'error' ? [{ from: err.from, to: err.to!, message: diagText(err) }] : null, [result]);
  const swap = () => { if (ok && output) setInput(output); setFrom(to); setTo(from); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([output], { type: MIME[to] }));
    const a = document.createElement('a'); a.href = url; a.download = `converted.${EXT[to]}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copy = () => navigator.clipboard?.writeText(output).then(() => setNote('Copied output'), () => setNote('Copy failed'));
  const onFile = async (f?: File) => { if (!f) return; const t = await f.text(); const fmt = detectFormat(t, f.name); if (fmt) { setFrom(fmt); if (fmt === to) setTo(fmt === 'json' ? 'yaml' : 'json'); } setInput(t); setNote(`Loaded ${f.name}`); };
  const send = () => {
    if (!conv) return;
    const r = to === 'json' ? (ok ? { ok: true as const, output } : null) : conv(input, from, 'json', { ...opts, indent: 2 });
    if (r?.ok) onSendToViewer(r.output); else setNote('Fix conversion errors first');
  };
  const set = (p: Partial<ConvertOptions>) => setOpts(o => ({ ...o, ...p }));

  return (
    <div className="convert">
      <header className="toolbar">
        <label>From <select aria-label="from" value={from} onChange={e => { const f = e.target.value as Format; setFrom(f); if (f === to) setTo(from); }}>{FORMATS.map(f => <option key={f} value={f}>{LABEL[f]}</option>)}</select></label>
        <button onClick={swap} title="Swap input/output" aria-label="swap">⇄ Swap</button>
        <label>To <select aria-label="to" value={to} onChange={e => { const t = e.target.value as Format; setTo(t); if (t === from) setFrom(to); }}>{FORMATS.map(f => <option key={f} value={f}>{LABEL[f]}</option>)}</select></label>
        <span className="sep" />
        <button onClick={() => fileRef.current?.click()}>Upload</button>
        <input ref={fileRef} type="file" hidden accept=".json,.yaml,.yml,.xml,.properties,text/*" onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button onClick={() => setInput(SAMPLES[from])}>Sample</button>
        <button onClick={() => { setFrom('json'); if (to === 'json') setTo('yaml'); setInput(getViewerText()); }}>Use viewer JSON</button>
        <span className="sep" />
        <button onClick={copy} disabled={!ok || !output}>Copy</button>
        <button onClick={download} disabled={!ok || !output}>Download .{EXT[to]}</button>
        <button onClick={send} disabled={!ok || !output} data-testid="send-to-viewer">Send to Viewer</button>
        {note ? <span className="note">{note}</span> : null}
      </header>
      <div className="optbar">
        {to === 'xml' ? <>
          <label>Root name <input aria-label="root name" value={opts.rootName} onChange={e => set({ rootName: e.target.value })} size={8} /></label>
          <label>Invalid names <select value={opts.invalidNames} onChange={e => set({ invalidNames: e.target.value as any })}><option value="sanitize">sanitize</option><option value="error">error</option></select></label>
        </> : null}
        {to === 'properties' ? <label title="java.util.Properties.store style; leave off for UTF-8 files"><input type="checkbox" aria-label="escape unicode" checked={opts.escapeUnicode !== false} onChange={e => set({ escapeUnicode: e.target.checked })} /> Escape non-ASCII as \uXXXX</label> : null}
        {from === 'xml' || from === 'properties' ? <label><input type="checkbox" aria-label="infer types" checked={!!opts.inferTypes} onChange={e => set({ inferTypes: e.target.checked })} /> Infer numbers/booleans</label> : null}
        {from === 'yaml' ? <label>Multiple documents <select value={opts.multiDoc} onChange={e => set({ multiDoc: e.target.value as any })}><option value="array">→ array</option><option value="error">error</option></select></label> : null}
        {to === 'json' || to === 'xml' ? <label>Indent <select value={opts.indent} onChange={e => set({ indent: Number(e.target.value) })}><option value={0}>0</option><option value={2}>2</option><option value={4}>4</option></select></label> : null}
        <span className="muted">Rust → WebAssembly{conv ? '' : ' (loading…)'}</span>
      </div>
      <main className="split2">
        <section className="pane">
          <div className="panehead">Input ({LABEL[from]})</div>
          {err ? <div className="convbanner" role="alert" data-testid="convert-error"><span>✖</span><span><b>{err.title}{err.line != null ? ` at line ${err.line}, column ${err.col}` : ''}:</b> {err.message}</span></div> : null}
          <CodeEditor value={input} onChange={setInput} lang={from} testId="convert-input" diagnostics={diags} />
          <div className={'status' + (err ? ' err' : result?.kind === 'empty' ? ' hint' : '')} data-testid="convert-status">
            {loadErr ? `Failed to load converter: ${loadErr}` : !result ? 'Loading converter…' : result.kind === 'empty' ? `Paste or type ${LABEL[from]} on the left (or click Sample) to convert it to ${LABEL[to]}.` : ok ? `✔ Converted ${LABEL[from]} → ${LABEL[to]}` : `✖ ${diagText(err!)}`}
          </div>
        </section>
        <section className={'pane' + (stale ? ' stale' : '')} data-testid="convert-output-pane">
          <div className="panehead">Output ({LABEL[to]}){stale ? <span className="stalelabel" data-testid="stale-label">showing last valid output</span> : null}</div>
          <CodeEditor value={output} lang={to} readOnly testId="convert-output" />
        </section>
      </main>
    </div>
  );
}
