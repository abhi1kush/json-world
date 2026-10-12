import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor from './components/Editor';
import { Tree, Row, flatten, isExpanded, ExpandMode, EditTarget } from './components/Tree';
import * as J from './lib/json';
import { SAMPLE } from './sample';
import { persist, pick, isStr, oneOf } from './lib/storage';

type Toast = { msg: string; kind: 'ok' | 'err'; n: number } | null;
type Ctx = { x: number; y: number; row: Row } | null;
const TYPES: J.JType[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

const initialText = JSON.stringify(SAMPLE, null, 2);

export interface ViewerApi { getText: () => string; loadText: (t: string) => void }

export default function Viewer({ apiRef, active }: { apiRef: React.MutableRefObject<ViewerApi | null>; active: boolean }) {
  // restore saved state synchronously (before first render)
  const [saved] = useState(() => persist.load('viewer', x => pick(x, { text: initialText, indent: 2, mode: 'auto' as ExpandMode, autoDepth: 3, overrides: [] as [string, boolean][] }, {
    text: isStr, indent: v => v === 2 || v === 4, mode: oneOf(['auto', 'all', 'none'] as const), autoDepth: v => v === 1 || v === 3,
    overrides: v => Array.isArray(v) && v.every(e => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'boolean'),
  })));
  const start = saved?.text ?? initialText;
  const [indent, setIndent] = useState(saved?.indent ?? 2);
  const [text, setText] = useState(start);
  const [root, setRoot] = useState<J.JNode>(() => { const r = J.parse(start); return r.ok ? r.node : { t: 'null' }; });
  const [error, setError] = useState<J.ParseError | null>(() => { const r = J.parse(start); return r.ok ? null : r.error; });
  const [selected, setSelected] = useState<J.Path | null>(null);
  const [mode, setMode] = useState<ExpandMode>(saved?.mode ?? 'auto');
  const [autoDepth, setAutoDepth] = useState(saved?.autoDepth ?? (start.length > 1_000_000 ? 1 : 3));
  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map(saved?.overrides ?? []));
  useEffect(() => {
    persist.save('viewer', { text, indent, mode, autoDepth, overrides: overrides.size <= 5000 ? [...overrides] : [] });
  }, [text, indent, mode, autoDepth, overrides]);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [q, setQ] = useState('');
  const [qd, setQd] = useState('');
  const [ctx, setCtx] = useState<Ctx>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [leftPct, setLeftPct] = useState(50);
  const [scrollTo, setScrollTo] = useState<{ pk: string; n: number } | null>(null);
  const [, force] = useState(0);

  const rootRef = useRef(root); rootRef.current = root;
  const indentRef = useRef(indent); indentRef.current = indent;
  const hist = useRef({ stack: [start], idx: 0 });
  const pending = useRef<{ timer: number; text: string } | null>(null);
  const clip = useRef<J.Clip | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => setToast(t => ({ msg, kind, n: (t?.n ?? 0) + 1 })), []);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 2500); return () => clearTimeout(id); }, [toast]);

  const pushHistory = (t: string) => {
    const h = hist.current;
    if (h.stack[h.idx] === t) return;
    h.stack = h.stack.slice(0, h.idx + 1); h.stack.push(t);
    if (h.stack.length > 300) h.stack.shift();
    h.idx = h.stack.length - 1; force(x => x + 1);
  };

  const parseInto = (t: string) => {
    const r = J.parse(t);
    if (r.ok) { setRoot(r.node); rootRef.current = r.node; setError(null); } else setError(r.error);
    return r.ok;
  };

  const flushPending = () => {
    const p = pending.current; if (!p) return;
    clearTimeout(p.timer); pending.current = null;
    parseInto(p.text); pushHistory(p.text);
  };

  const onTextChange = useCallback((t: string) => {
    setText(t);
    if (pending.current) clearTimeout(pending.current.timer);
    const timer = window.setTimeout(() => { pending.current = null; parseInto(t); pushHistory(t); }, 150);
    pending.current = { timer, text: t };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Load new text (file/sample/undo); optionally reset view. */
  const loadText = (t: string, opts: { push?: boolean; reset?: boolean } = {}) => {
    if (pending.current) { clearTimeout(pending.current.timer); pending.current = null; }
    setText(t); parseInto(t);
    if (opts.push !== false) pushHistory(t);
    if (opts.reset) { setOverrides(new Map()); setMode('auto'); setAutoDepth(t.length > 1_000_000 ? 1 : 3); setSelected(null); }
  };

  const textRef = useRef(text); textRef.current = text;
  const loadRef = useRef(loadText); loadRef.current = loadText;
  apiRef.current = { getText: () => textRef.current, loadText: t => loadRef.current(t, { reset: true }) };

  const expandTo = (p: J.Path) => setOverrides(m => {
    const n = new Map(m);
    for (let i = 0; i < p.length; i++) n.set(J.pathKey(p.slice(0, i)), true);
    return n;
  });

  const applyRoot = (nr: J.JNode, sel?: J.Path | null) => {
    if (pending.current) { clearTimeout(pending.current.timer); pending.current = null; }
    const t = J.stringify(nr, indentRef.current);
    setRoot(nr); rootRef.current = nr; setText(t); setError(null); pushHistory(t);
    if (sel !== undefined) {
      setSelected(sel);
      if (sel) { expandTo(sel); setScrollTo(s => ({ pk: J.pathKey(sel), n: (s?.n ?? 0) + 1 })); }
    }
  };
  const tryEdit = (fn: () => void) => { try { fn(); } catch (e: any) { notify(e.message ?? String(e), 'err'); } };

  const undo = useCallback(() => {
    flushPending();
    const h = hist.current; if (h.idx <= 0) return;
    h.idx--; loadText(h.stack[h.idx], { push: false }); force(x => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const redo = useCallback(() => {
    flushPending();
    const h = hist.current; if (h.idx >= h.stack.length - 1) return;
    h.idx++; loadText(h.stack[h.idx], { push: false }); force(x => x + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep selection valid
  useEffect(() => { if (selected && !J.getAt(root, selected)) setSelected(null); }, [root, selected]);
  useEffect(() => { const id = setTimeout(() => setQd(q.trim()), 200); return () => clearTimeout(id); }, [q]);

  const filter = useMemo(() => (qd ? J.search(root, qd) : undefined), [root, qd]);
  const rows = useMemo(
    () => flatten(root, (pk, d) => isExpanded(pk, d, mode, autoDepth, overrides), filter),
    [root, mode, autoDepth, overrides, filter],
  );
  const selectedPk = selected ? J.pathKey(selected) : null;

  // ---- tree callbacks ----
  const toggle = useCallback((r: Row) => setOverrides(m => new Map(m).set(r.pk, !r.expanded)), []);
  const select = useCallback((r: Row) => { setSelected(r.path); setCtx(null); }, []);
  const startEdit = useCallback((r: Row, field: 'key' | 'value') => setEditing({ pk: r.pk, field }), []);
  const cancelEdit = useCallback(() => { setEditing(null); treeRef.current?.focus(); }, []);
  const commitEdit = (r: Row, field: 'key' | 'value', input: string) => {
    setEditing(null); treeRef.current?.focus();
    tryEdit(() => {
      if (field === 'key') {
        if (typeof r.seg !== 'string' || input === r.seg) return;
        const p = [...r.path.slice(0, -1), input];
        applyRoot(J.renameKey(rootRef.current, r.path, input), p);
      } else {
        const v = J.parseLiteral(input);
        if (J.stringify(v, 0) === J.stringify(r.node, 0)) return;
        applyRoot(J.setAt(rootRef.current, r.path, v), r.path);
      }
    });
  };
  const commitRef = useRef(commitEdit); commitRef.current = commitEdit;
  const onCommit = useCallback((r: Row, f: 'key' | 'value', t: string) => commitRef.current(r, f, t), []);
  const onContext = useCallback((r: Row, e: React.MouseEvent) => setCtx({ x: e.clientX, y: e.clientY, row: r }), []);

  // ---- actions on selected ----
  const sel = () => (selected ? selected : null);
  const doDelete = () => { const p = sel(); if (!p) return; if (!p.length) return notify('Cannot delete root', 'err');
    tryEdit(() => {
      const r = J.deleteAt(rootRef.current, p);
      const par = J.getAt(r, p.slice(0, -1))!;
      const last = p[p.length - 1];
      let next: J.Path = p.slice(0, -1);
      if (par.t === 'array' && par.items.length) next = [...p.slice(0, -1), Math.min(last as number, par.items.length - 1)];
      applyRoot(r, next);
    }); };
  const doCopy = (useSystem: boolean) => {
    const p = sel(); if (!p) return null;
    const c = J.copyNode(rootRef.current, p, indentRef.current);
    clip.current = c;
    if (useSystem) navigator.clipboard?.writeText(c.text).catch(() => {});
    notify(`Copied ${J.pathToString(p)}`);
    return c;
  };
  const doPaste = (text: string | null, mode: J.PasteMode = 'auto', askKey = false) => {
    const p = sel(); if (!p) return notify('Select a node first', 'err');
    let t = text ?? clip.current?.text;
    if (!t) return notify('Clipboard is empty', 'err');
    let key: string | undefined = clip.current && clip.current.text === t ? clip.current.key : undefined;
    if (!J.parse(t.trim()).ok) { t = JSON.stringify(t); notify('Clipboard was not JSON — pasted as string'); }
    let explicit: string | undefined;
    if (askKey) {
      const ans = window.prompt('Key for pasted value:', key ?? 'pasted');
      if (ans === null) return;
      explicit = ans;
    }
    tryEdit(() => { const res = J.paste(rootRef.current, p, { text: t!, key }, mode, explicit); applyRoot(res.root, res.path); });
  };
  const pasteFromSystem = async (mode: J.PasteMode = 'auto', askKey = false) => {
    let t: string | null = null;
    try { t = await navigator.clipboard.readText(); } catch { t = null; }
    doPaste(t || null, mode, askKey);
  };
  const doMove = (d: number) => { const p = sel(); if (!p || typeof p[p.length - 1] !== 'number') return;
    tryEdit(() => { const [r, np] = J.moveItem(rootRef.current, p, d); if (r !== rootRef.current) applyRoot(r, np); }); };
  const doAddChild = () => { const p = sel(); if (!p) return; tryEdit(() => { const [r, np] = J.addChild(rootRef.current, p); applyRoot(r, np); setEditing({ pk: J.pathKey(np), field: typeof np[np.length - 1] === 'string' ? 'key' : 'value' }); }); };
  const doAddSibling = () => { const p = sel(); if (!p) return; tryEdit(() => { const [r, np] = J.addSibling(rootRef.current, p); applyRoot(r, np); setEditing({ pk: J.pathKey(np), field: typeof np[np.length - 1] === 'string' ? 'key' : 'value' }); }); };
  const doType = (t: J.JType) => { const p = sel(); if (!p) return; tryEdit(() => applyRoot(J.setAt(rootRef.current, p, J.convertType(J.getAt(rootRef.current, p)!, t)), p)); };
  const copyPath = () => { const p = sel(); if (!p) return; const s = J.pathToString(p); navigator.clipboard?.writeText(s).catch(() => {}); notify(`Copied path ${s}`); };

  const onTreeKey = (e: React.KeyboardEvent) => {
    if (editing) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const k = e.key;
    if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
    if (mod) return; // copy/paste handled via clipboard events
    const idx = rows.findIndex(r => r.pk === selectedPk);
    const cur = idx >= 0 ? rows[idx] : null;
    const go = (r?: Row) => { if (r) { setSelected(r.path); setScrollTo(s => ({ pk: r.pk, n: (s?.n ?? 0) + 1 })); } };
    switch (k) {
      case 'ArrowDown': e.preventDefault(); if (e.altKey) doMove(1); else go(rows[idx < 0 ? 0 : Math.min(idx + 1, rows.length - 1)]); break;
      case 'ArrowUp': e.preventDefault(); if (e.altKey) doMove(-1); else go(rows[Math.max(idx - 1, 0)]); break;
      case 'ArrowLeft': e.preventDefault(); if (!cur) break;
        if (cur.expanded) toggle(cur); else if (cur.path.length) go(rows.find(r => r.pk === J.pathKey(cur.path.slice(0, -1)))); break;
      case 'ArrowRight': e.preventDefault(); if (!cur || !J.isContainer(cur.node)) break;
        if (!cur.expanded) toggle(cur); else if (J.childCount(cur.node)) go(rows[idx + 1]); break;
      case 'Enter': e.preventDefault(); if (cur) startEdit(cur, 'value'); break;
      case 'F2': e.preventDefault(); if (cur && typeof cur.seg === 'string') startEdit(cur, 'key'); break;
      case 'Delete': case 'Backspace': e.preventDefault(); doDelete(); break;
      case 'Home': e.preventDefault(); go(rows[0]); break;
      case 'End': e.preventDefault(); go(rows[rows.length - 1]); break;
    }
  };
  const onTreeCopy = (e: React.ClipboardEvent) => {
    if (editing) return;
    const c = doCopy(false); if (!c) return;
    e.preventDefault(); e.clipboardData.setData('text/plain', c.text);
  };
  const onTreePaste = (e: React.ClipboardEvent) => {
    if (editing) return;
    e.preventDefault();
    doPaste(e.clipboardData.getData('text/plain') || null);
  };

  // ---- toolbar ----
  const fmt = () => { flushPending(); if (error) return notify('Fix JSON errors first', 'err'); loadText(J.stringify(rootRef.current, indent)); };
  const mini = () => { flushPending(); if (error) return notify('Fix JSON errors first', 'err'); loadText(J.minify(rootRef.current)); };
  const sortK = () => { flushPending(); if (error) return notify('Fix JSON errors first', 'err'); applyRoot(J.sortKeys(rootRef.current), selected && J.getAt(J.sortKeys(rootRef.current), selected) ? selected : null); };
  const changeIndent = (n: number) => { setIndent(n); indentRef.current = n; flushPending(); if (!J.parse(text).ok) return; loadText(J.stringify(rootRef.current, n)); };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'data.json'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const onFile = async (f?: File) => { if (!f) return; const t = await f.text(); loadText(t, { reset: true }); notify(`Loaded ${f.name} (${(t.length / 1024).toFixed(1)} KB)`); };

  const activeRef = useRef(active); activeRef.current = active;
  // global undo/redo when focus is not in editor / input
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement;
      if (!activeRef.current) return;
      if (tgt.closest('.cm-editor') || tgt.closest('.tree') || tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', h);
    const close = () => setCtx(null);
    window.addEventListener('click', close);
    return () => { window.removeEventListener('keydown', h); window.removeEventListener('click', close); };
  }, [undo, redo]);

  // splitter
  const mainRef = useRef<HTMLDivElement>(null);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = mainRef.current!; const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => setLeftPct(Math.min(85, Math.max(15, ((ev.clientX - rect.left) / rect.width) * 100)));
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const selNode = selected ? J.getAt(root, selected) : undefined;
  const parentNode = selected && selected.length ? J.getAt(root, selected.slice(0, -1)) : undefined;
  const inArray = parentNode?.t === 'array';
  const h = hist.current;
  const act = (fn: () => void) => () => { setCtx(null); fn(); treeRef.current?.focus(); };

  return (
    <div className="viewer" style={{ display: active ? undefined : 'none' }}>
      <header className="toolbar">
        <button onClick={fmt} title="Pretty-print">Format</button>
        <button onClick={mini}>Minify</button>
        <button onClick={sortK}>Sort keys</button>
        <label className="ind">Indent <select value={indent} onChange={e => changeIndent(Number(e.target.value))} aria-label="indent"><option value={2}>2</option><option value={4}>4</option></select></label>
        <span className="sep" />
        <button onClick={() => undo()} disabled={h.idx <= 0} title="Ctrl+Z">Undo</button>
        <button onClick={() => redo()} disabled={h.idx >= h.stack.length - 1} title="Ctrl+Shift+Z">Redo</button>
        <span className="sep" />
        <button onClick={() => fileRef.current?.click()}>Load file</button>
        <input ref={fileRef} type="file" accept=".json,application/json,text/plain" hidden onChange={e => { onFile(e.target.files?.[0]); e.target.value = ''; }} />
        <button onClick={download}>Download</button>
        <button onClick={() => loadText(JSON.stringify(SAMPLE, null, indent), { reset: true })}>Sample</button>
        <span className="sep" />
        <button onClick={() => { setMode('all'); setOverrides(new Map()); }}>Expand all</button>
        <button onClick={() => { setMode('none'); setOverrides(new Map()); }}>Collapse all</button>
        <input className="search" placeholder="Search keys / values…" value={q} onChange={e => setQ(e.target.value)} aria-label="search" />
        {filter ? <span className="matches">{filter.matches.size} match{filter.matches.size === 1 ? '' : 'es'}</span> : null}
      </header>
      <div className="pathbar">
        <code data-testid="path">{selected ? J.pathToString(selected) : 'No node selected'}</code>
        <button onClick={copyPath} disabled={!selected}>Copy path</button>
        {selNode ? <span className="hint">Double-click to edit · Enter edit · F2 rename · Del delete · {isMac ? '⌘' : 'Ctrl'}+C/V copy/paste · Alt+↑/↓ move · right-click for more</span> : null}
      </div>
      <main className="main" ref={mainRef} style={{ ['--left' as any]: leftPct + '%' }}>
        <section className="pane left">
          <Editor value={text} onChange={onTextChange} onUndo={undo} onRedo={redo} />
          <div className={'status' + (error ? ' err' : '')} data-testid="status">
            {error ? `✖ Line ${error.line}, Col ${error.col}: ${error.message} — tree shows last valid JSON` : `✔ Valid JSON · ${text.length.toLocaleString()} chars`}
          </div>
        </section>
        <div className="splitter" onPointerDown={startDrag} role="separator" aria-orientation="vertical" />
        <section className="pane right">
          <Tree rows={rows} selectedPk={selectedPk} q={qd} editing={editing} onToggle={toggle} onSelect={select} onEdit={startEdit}
            onCommit={onCommit} onCancel={cancelEdit} onContext={onContext} onKeyDown={onTreeKey} onCopy={onTreeCopy} onPaste={onTreePaste}
            scrollToPk={scrollTo} containerRef={treeRef} />
        </section>
      </main>
      {ctx && selNode ? (
        <div className="ctx" style={{ left: Math.min(ctx.x, window.innerWidth - 220), top: Math.min(ctx.y, window.innerHeight - 440) }} onClick={e => e.stopPropagation()} data-testid="ctx">
          <button onClick={act(() => startEdit(ctx.row, 'value'))}>Edit value<kbd>Enter</kbd></button>
          {typeof ctx.row.seg === 'string' ? <button onClick={act(() => startEdit(ctx.row, 'key'))}>Rename key<kbd>F2</kbd></button> : null}
          <div className="sub">Change type:
            <div className="types">{TYPES.map(t => <button key={t} className={selNode.t === t ? 'on' : ''} onClick={act(() => doType(t))}>{t}</button>)}</div>
          </div>
          <hr />
          {J.isContainer(selNode) ? <button onClick={act(doAddChild)}>Add child</button> : null}
          {selected!.length ? <button onClick={act(doAddSibling)}>Add sibling</button> : null}
          <hr />
          <button onClick={act(() => doCopy(true))}>Copy<kbd>{isMac ? '⌘' : 'Ctrl'}+C</kbd></button>
          <button onClick={act(() => pasteFromSystem('auto'))}>Paste<kbd>{isMac ? '⌘' : 'Ctrl'}+V</kbd></button>
          {selNode.t === 'object' || parentNode?.t === 'object' ? <button onClick={act(() => pasteFromSystem('auto', true))}>Paste as key…</button> : null}
          <button onClick={act(() => pasteFromSystem('replace'))}>Paste (replace value)</button>
          <button onClick={act(copyPath)}>Copy path</button>
          {inArray ? <><hr /><button onClick={act(() => doMove(-1))}>Move up<kbd>Alt+↑</kbd></button><button onClick={act(() => doMove(1))}>Move down<kbd>Alt+↓</kbd></button></> : null}
          {selected!.length ? <><hr /><button className="danger" onClick={act(doDelete)}>Delete<kbd>Del</kbd></button></> : null}
        </div>
      ) : null}
      {toast ? <div className={'toast ' + toast.kind} key={toast.n} data-testid="toast">{toast.msg}</div> : null}
    </div>
  );
}
