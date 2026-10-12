import { useEffect, useMemo, useRef, useState } from 'react';
import { diffLines } from 'diff';
import CodeEditor from '../components/CodeEditor';
import * as J from '../lib/json';
import { sortArraysDeep, diff, summarize, DiffNode, DiffOptions, diffText, sideBySide, LineRow } from '../lib/diff';

const ROW_H = 22;
const LEFT = { service: 'api', version: '1.4.0', replicas: 3, env: { LOG_LEVEL: 'info', REGION: 'eu-west-1' }, users: [{ id: 1, name: 'Ada', role: 'admin' }, { id: 2, name: 'Alan', role: 'dev' }, { id: 3, name: 'Grace', role: 'dev' }], tags: ['web', 'public'], owner: null };
const RIGHT = { version: '1.5.0', service: 'api', replicas: 3, env: { LOG_LEVEL: 'debug', REGION: 'eu-west-1', TRACE: true }, users: [{ id: 3, name: 'Grace', role: 'lead' }, { id: 1, name: 'Ada', role: 'admin' }, { id: 4, name: 'Linus', role: 'dev' }], tags: ['web'], owner: 'ops' };

interface DRow { pk: string; depth: number; node: DiffNode; leftSeg?: J.Seg; rightSeg?: J.Seg; expanded: boolean; container: boolean; isDiff: boolean }

function useParsed(text: string) {
  const [res, setRes] = useState<J.ParseResult>(() => J.parse(text));
  useEffect(() => { const id = setTimeout(() => setRes(J.parse(text)), 200); return () => clearTimeout(id); }, [text]);
  return res;
}
const isLeafDiff = (n: DiffNode) => n.kind === 'added' || n.kind === 'removed' || n.kind === 'changed' || !!n.orderChanged;
const childPk = (pk: string, c: { leftSeg?: J.Seg; rightSeg?: J.Seg }) => pk + '\u0001' + (c.leftSeg !== undefined ? 'L' + c.leftSeg : 'R' + c.rightSeg);
const isCont = (n: DiffNode) => !!n.children && n.kind !== 'changed';

function flattenDiff(root: DiffNode, exp: (pk: string, n: DiffNode) => boolean, onlyDiffs: boolean): DRow[] {
  const rows: DRow[] = [];
  const walk = (n: DiffNode, pk: string, depth: number, leftSeg?: J.Seg, rightSeg?: J.Seg) => {
    const container = isCont(n);
    const expanded = container && exp(pk, n);
    rows.push({ pk, depth, node: n, leftSeg, rightSeg, expanded, container, isDiff: isLeafDiff(n) });
    if (!expanded) return;
    for (const c of n.children!) {
      if (onlyDiffs && c.node.count === 0) continue;
      walk(c.node, childPk(pk, c), depth + 1, c.leftSeg, c.rightSeg);
    }
  };
  walk(root, '$', 0, undefined, undefined);
  return rows;
}
/** All diff locations in document order, with their ancestor pks. */
function diffTargets(root: DiffNode): { pk: string; ancestors: string[] }[] {
  const out: { pk: string; ancestors: string[] }[] = [];
  const walk = (n: DiffNode, pk: string, anc: string[]) => {
    if (isLeafDiff(n)) out.push({ pk, ancestors: anc });
    if (n.kind === 'nested' || (n.kind === 'same' && n.children)) for (const c of n.children ?? []) if (c.node.count) walk(c.node, childPk(pk, c), [...anc, pk]);
  };
  walk(root, '$', []);
  return out;
}

function Cell({ row, side }: { row: DRow; side: 'left' | 'right' }) {
  const n = side === 'left' ? row.node.left : row.node.right;
  const seg = side === 'left' ? row.leftSeg : row.rightSeg;
  if (!n) return <div className="dcell empty" />;
  const label = row.depth === 0 ? '$' : typeof seg === 'string' ? JSON.stringify(seg) : String(seg);
  const cnt = J.childCount(n);
  return (
    <div className="dcell" style={{ paddingLeft: 4 + row.depth * 14 }}>
      <span className="toggle">{row.container && (n.t === 'object' || n.t === 'array') ? (row.expanded ? '▾' : '▸') : ''}</span>
      <span className={'key' + (typeof seg === 'number' ? ' idx' : '')}>{label}</span><span className="colon">:</span>
      {n.t === 'object' || n.t === 'array'
        ? <span className="summary">{n.t === 'object' ? '{' : '['}{row.expanded ? '' : cnt ? '…' : ''}{row.expanded ? '' : n.t === 'object' ? '}' : ']'}<span className="count">{cnt} {n.t === 'object' ? 'keys' : 'items'}</span></span>
        : <span className={'val v-' + n.t}>{n.t === 'string' ? JSON.stringify(n.v.length > 200 ? n.v.slice(0, 200) + '…' : n.v) : J.literalText(n)}</span>}
      {side === 'right' && row.node.count > 0 && !row.expanded && (row.node.kind === 'nested' || row.container) ? <span className="dbadge" data-testid="diff-badge">{row.node.count} diff{row.node.count > 1 ? 's' : ''}</span> : null}
      {side === 'right' && row.node.orderChanged ? <span className="dbadge">key order</span> : null}
    </div>
  );
}

function useVirtual(ref: React.RefObject<HTMLDivElement>, count: number) {
  const [scroll, setScroll] = useState(0);
  const [h, setH] = useState(500);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setH(el.clientHeight)); ro.observe(el); setH(el.clientHeight);
    return () => ro.disconnect();
  }, [ref]);
  const start = Math.max(0, Math.floor(scroll / ROW_H) - 15);
  const end = Math.min(count, Math.ceil((scroll + h) / ROW_H) + 15);
  return { start, end, setScroll };
}
const scrollIntoRow = (el: HTMLElement | null, idx: number) => {
  if (!el || idx < 0) return;
  const top = idx * ROW_H;
  if (top < el.scrollTop || top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
};

export default function CompareTab({ getViewerText }: { getViewerText: () => string }) {
  const [leftText, setLeftText] = useState(() => JSON.stringify(LEFT, null, 2));
  const [rightText, setRightText] = useState(() => JSON.stringify(RIGHT, null, 2));
  const [ignoreOrder, setIgnoreOrder] = useState(true);
  const [checkOrder, setCheckOrder] = useState(false);
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [view, setView] = useState<'tree' | 'text'>('tree');
  const [overrides, setOverrides] = useState<Map<string, boolean>>(new Map());
  const [cur, setCur] = useState(-1);
  const [showInputs, setShowInputs] = useState(true);
  const L = useParsed(leftText), R = useParsed(rightText);
  // By default arrays are sorted bottom-up before comparing (then compared by index);
  // 'Check order differences' skips sorting so array order changes are reported.
  const opts: DiffOptions = useMemo(() => ({ ignoreKeyOrder: ignoreOrder }), [ignoreOrder]);
  const [lastGood, setLastGood] = useState<{ a: J.JNode; b: J.JNode } | null>(null);
  const [rawGood, setRawGood] = useState<{ a: J.JNode; b: J.JNode } | null>(null);
  useEffect(() => { if (L.ok && R.ok) setRawGood({ a: L.node, b: R.node }); }, [L, R]);
  useEffect(() => { setLastGood(rawGood && (checkOrder ? rawGood : { a: sortArraysDeep(rawGood.a), b: sortArraysDeep(rawGood.b) })); }, [rawGood, checkOrder]);
  const d = useMemo(() => (lastGood ? diff(lastGood.a, lastGood.b, opts) : null), [lastGood, opts]);
  const summary = useMemo(() => (d ? summarize(d) : null), [d]);
  useEffect(() => { setOverrides(new Map()); setCur(-1); }, [d]);

  const rows = useMemo(() => (d ? flattenDiff(d, (pk, n) => overrides.get(pk) ?? (n.kind === 'nested'), onlyDiffs) : []), [d, overrides, onlyDiffs]);
  const targets = useMemo(() => (d ? diffTargets(d) : []), [d]);

  // text diff
  const lineRows: LineRow[] = useMemo(() => (view === 'text' && lastGood ? sideBySide(diffLines(diffText(lastGood.a, opts), diffText(lastGood.b, opts))) : []), [view, lastGood, opts]);
  const blocks = useMemo(() => lineRows.map((r, i) => (r.kind !== 'same' && (i === 0 || lineRows[i - 1].kind === 'same') ? i : -1)).filter(i => i >= 0), [lineRows]);

  const treeRef = useRef<HTMLDivElement>(null);
  const tv = useVirtual(treeRef, rows.length);
  const lRef = useRef<HTMLDivElement>(null), rRef = useRef<HTMLDivElement>(null);
  const lv = useVirtual(lRef, lineRows.length);
  const syncing = useRef(false);
  const onTextScroll = (src: 'l' | 'r') => {
    const a = src === 'l' ? lRef.current! : rRef.current!, b = src === 'l' ? rRef.current! : lRef.current!;
    lv.setScroll(a.scrollTop);
    if (syncing.current) { syncing.current = false; return; }
    if (b.scrollTop !== a.scrollTop) { syncing.current = true; b.scrollTop = a.scrollTop; }
  };

  const total = view === 'tree' ? targets.length : blocks.length;
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  const goDiff = (dir: 1 | -1) => {
    if (!total) return;
    const i = cur < 0 ? (dir === 1 ? 0 : total - 1) : (cur + dir + total) % total;
    setCur(i);
    if (view === 'tree') {
      const t = targets[i];
      setOverrides(m => { const n = new Map(m); t.ancestors.forEach(a => n.set(a, true)); return n; });
      setPendingScroll(t.pk);
    } else {
      scrollIntoRow(lRef.current, blocks[i]); if (lRef.current && rRef.current) rRef.current.scrollTop = lRef.current.scrollTop;
    }
  };
  useEffect(() => { if (pendingScroll) { scrollIntoRow(treeRef.current, rows.findIndex(r => r.pk === pendingScroll)); } }, [pendingScroll, rows]);
  const curPk = view === 'tree' && cur >= 0 ? targets[cur]?.pk : null;
  const curLine = view === 'text' && cur >= 0 ? blocks[cur] : -1;

  const toggle = (r: DRow) => r.container && setOverrides(m => new Map(m).set(r.pk, !r.expanded));
  const expandAll = (v: boolean) => { const m = new Map<string, boolean>(); if (d) { const walk = (n: DiffNode, pk: string) => { if (isCont(n)) { m.set(pk, v); n.children!.forEach(c => walk(c.node, childPk(pk, c))); } }; walk(d, '$'); } setOverrides(m); };
  const upload = (side: 'l' | 'r') => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json,text/plain';
    inp.onchange = async () => { const f = inp.files?.[0]; if (f) (side === 'l' ? setLeftText : setRightText)(await f.text()); };
    inp.click();
  };
  const err = (r: J.ParseResult) => (r.ok ? null : `✖ Line ${r.error.line}, Col ${r.error.col}: ${r.error.message}`);

  return (
    <div className="compare">
      <header className="toolbar">
        <button onClick={() => setShowInputs(s => !s)}>{showInputs ? 'Hide inputs' : 'Show inputs'}</button>
        <span className="sep" />
        <button className={view === 'tree' ? 'on' : ''} onClick={() => { setView('tree'); setCur(-1); }}>Tree diff</button>
        <button className={view === 'text' ? 'on' : ''} onClick={() => { setView('text'); setCur(-1); }}>Text diff</button>
        <span className="sep" />
        <label><input type="checkbox" checked={ignoreOrder} onChange={e => setIgnoreOrder(e.target.checked)} aria-label="ignore key order" /> Ignore key order</label>
        <label title="Off (default): every array is sorted bottom-up by canonical JSON before comparing, so element order is ignored. On: arrays are compared by index and order changes are differences."><input type="checkbox" checked={checkOrder} onChange={e => setCheckOrder(e.target.checked)} aria-label="check order differences" /> Check order differences</label>
        {view === 'tree' ? <label><input type="checkbox" checked={onlyDiffs} onChange={e => setOnlyDiffs(e.target.checked)} aria-label="only differences" /> Only differences</label> : null}
        {view === 'tree' ? <><button onClick={() => expandAll(true)}>Expand all</button><button onClick={() => expandAll(false)}>Collapse all</button></> : null}
        <span className="sep" />
        <button onClick={() => goDiff(-1)} disabled={!total} aria-label="previous difference">◀ Prev</button>
        <span className="navpos" data-testid="diff-pos">{total ? `${cur >= 0 ? cur + 1 : '–'} / ${total}` : '0 / 0'}</span>
        <button onClick={() => goDiff(1)} disabled={!total} aria-label="next difference">Next ▶</button>
        {summary ? <span className="summarybar" data-testid="diff-summary"><b className="s-add">+{summary.added} added</b> <b className="s-rem">−{summary.removed} removed</b> <b className="s-chg">~{summary.changed} changed</b>{checkOrder ? null : <span className="sortnote" data-testid="sort-note" title="Every array is sorted (deepest first) by the canonical JSON of its elements before comparing"> · Arrays sorted</span>}</span> : null}
      </header>
      {showInputs ? (
        <div className="cmp-inputs">
          {(['l', 'r'] as const).map(s => (
            <section className="pane" key={s}>
              <div className="panehead">
                {s === 'l' ? 'Left (original)' : 'Right (modified)'}
                <span className="grow" />
                <button onClick={() => upload(s)}>Upload</button>
                <button onClick={() => (s === 'l' ? setLeftText : setRightText)(getViewerText())}>Use viewer JSON</button>
                <button onClick={() => { const t = s === 'l' ? leftText : rightText; const r = J.parse(t); if (r.ok) (s === 'l' ? setLeftText : setRightText)(J.stringify(r.node, 2)); }}>Format</button>
              </div>
              <CodeEditor value={s === 'l' ? leftText : rightText} onChange={s === 'l' ? setLeftText : setRightText} lang="json" testId={s === 'l' ? 'cmp-left' : 'cmp-right'} />
              {err(s === 'l' ? L : R) ? <div className="status err" data-testid={`cmp-err-${s}`}>{err(s === 'l' ? L : R)} — showing last valid diff</div> : null}
            </section>
          ))}
        </div>
      ) : null}
      {view === 'tree' ? (
        <div className="dtree" ref={treeRef} onScroll={e => tv.setScroll((e.target as HTMLDivElement).scrollTop)} data-testid="diff-tree">
          <div style={{ height: rows.length * ROW_H, position: 'relative' }}>
            <div style={{ position: 'absolute', top: tv.start * ROW_H, left: 0, right: 0 }}>
              {rows.slice(tv.start, tv.end).map(r => (
                <div key={r.pk} data-pk={r.pk} className={`drow k-${r.node.kind}${r.pk === curPk ? ' current' : ''}`} style={{ height: ROW_H }} onClick={() => toggle(r)}>
                  <Cell row={r} side="left" /><Cell row={r} side="right" />
                </div>
              ))}
            </div>
          </div>
          {summary && summary.total === 0 ? <div className="nodiff">✔ No differences</div> : null}
        </div>
      ) : (
        <>{!checkOrder || ignoreOrder ? <div className="textnote" data-testid="text-note">Showing pretty-printed JSON with {[!checkOrder && 'arrays sorted', ignoreOrder && 'object keys sorted'].filter(Boolean).join(' and ')} (as compared).</div> : null}
        <div className="dtext" data-testid="diff-text">
          {(['l', 'r'] as const).map(s => (
            <div key={s} className="dtext-pane" ref={s === 'l' ? lRef : rRef} onScroll={() => onTextScroll(s)}>
              <div style={{ height: lineRows.length * ROW_H, position: 'relative' }}>
                <div style={{ position: 'absolute', top: lv.start * ROW_H, left: 0, minWidth: '100%' }}>
                  {lineRows.slice(lv.start, lv.end).map((r, k) => {
                    const c = s === 'l' ? r.left : r.right; const i = lv.start + k;
                    const cls = !c ? 'pad' : r.kind === 'same' ? '' : r.kind === 'changed' ? 'chg' : s === 'l' ? 'rem' : 'add';
                    return <div key={i} className={'tline ' + cls + (i === curLine ? ' current' : '')} style={{ height: ROW_H }}><span className="ln">{c?.n ?? ''}</span><span className="lt">{c?.text ?? ''}</span></div>;
                  })}
                </div>
              </div>
            </div>
          ))}
        </div></>
      )}
    </div>
  );
}
