import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { JNode, Path, Seg, pathKey, childCount, isContainer, literalText } from '../lib/json';

export interface Row { path: Path; seg: Seg | null; node: JNode; depth: number; pk: string; expanded: boolean }
export const ROW_H = 24;

export type ExpandMode = 'auto' | 'all' | 'none';
export function isExpanded(pk: string, depth: number, mode: ExpandMode, autoDepth: number, overrides: Map<string, boolean>) {
  const o = overrides.get(pk);
  if (o !== undefined) return o;
  if (mode === 'all') return true;
  if (mode === 'none') return depth === 0;
  return depth < autoDepth;
}

export function flatten(root: JNode, exp: (pk: string, depth: number) => boolean, filter?: { matches: Set<string>; ancestors: Set<string> }): Row[] {
  const rows: Row[] = [];
  const walk = (node: JNode, path: Path, seg: Seg | null, depth: number, inMatch: boolean) => {
    const pk = pathKey(path);
    const isMatch = filter ? filter.matches.has(pk) : false;
    const isAnc = filter ? filter.ancestors.has(pk) : false;
    if (filter && !inMatch && !isMatch && !isAnc) return;
    const cont = isContainer(node);
    // When filtering, ancestors of matches are forced open.
    const expanded = cont && ((filter && isAnc && !inMatch && !isMatch) ? true : exp(pk, depth));
    rows.push({ path, seg, node, depth, pk, expanded });
    if (!expanded) return;
    const nextIn = inMatch || isMatch;
    if (node.t === 'object') for (const [k, v] of node.entries) walk(v, [...path, k], k, depth + 1, nextIn);
    else if (node.t === 'array') node.items.forEach((v, i) => walk(v, [...path, i], i, depth + 1, nextIn));
  };
  walk(root, [], null, 0, false);
  return rows;
}

function Hl({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

const trunc = (s: string, n = 300) => (s.length > n ? s.slice(0, n) + '…' : s);

export type EditTarget = { pk: string; field: 'key' | 'value' } | null;

interface RowProps {
  row: Row; selected: boolean; q: string; editing: 'key' | 'value' | null;
  onToggle: (r: Row) => void; onSelect: (r: Row) => void; onEdit: (r: Row, f: 'key' | 'value') => void;
  onCommit: (r: Row, f: 'key' | 'value', text: string) => void; onCancel: () => void; onContext: (r: Row, e: React.MouseEvent) => void;
}

const TreeRow = memo(function TreeRow({ row, selected, q, editing, onToggle, onSelect, onEdit, onCommit, onCancel, onContext }: RowProps) {
  const { node, seg, depth } = row;
  const cont = isContainer(node);
  const n = childCount(node);
  const keyLabel = seg === null ? '$' : typeof seg === 'number' ? String(seg) : seg;
  const editor = (field: 'key' | 'value', initial: string) => (
    <InlineInput initial={initial} onDone={t => (t === null ? onCancel() : onCommit(row, field, t))} />
  );
  return (
    <div
      className={'row' + (selected ? ' selected' : '')}
      style={{ paddingLeft: 6 + depth * 16, height: ROW_H }}
      data-path={row.pk}
      onMouseDown={() => onSelect(row)}
      onContextMenu={e => { e.preventDefault(); onSelect(row); onContext(row, e); }}
    >
      <span className={'toggle' + (cont ? '' : ' leaf')} onMouseDown={e => { e.stopPropagation(); onSelect(row); if (cont) onToggle(row); }}>
        {cont ? (row.expanded ? '▾' : '▸') : ''}
      </span>
      {editing === 'key' ? editor('key', String(seg)) : (
        <span className={'key' + (typeof seg === 'number' ? ' idx' : '') + (seg === null ? ' rootkey' : '')}
          onDoubleClick={() => typeof seg === 'string' && onEdit(row, 'key')}>
          {typeof seg === 'string' ? <>"<Hl text={keyLabel} q={q} />"</> : keyLabel}
        </span>
      )}
      <span className="colon">:</span>
      {editing === 'value' ? editor('value', literalText(node)) : cont ? (
        <span className="summary" onDoubleClick={() => onEdit(row, 'value')}>
          {node.t === 'object' ? '{' : '['}
          {!row.expanded && n > 0 ? <span className="ellipsis">…</span> : null}
          {node.t === 'object' ? '}' : ']'}
          <span className="count">{n} {node.t === 'object' ? (n === 1 ? 'key' : 'keys') : (n === 1 ? 'item' : 'items')}</span>
        </span>
      ) : (
        <span className={'val v-' + node.t} onDoubleClick={() => onEdit(row, 'value')} title={node.t === 'string' && node.v.length > 300 ? 'long string' : undefined}>
          {node.t === 'string' ? <>"<Hl text={trunc(node.v)} q={q} />"</> : <Hl text={literalText(node)} q={q} />}
        </span>
      )}
      <span className={'badge b-' + node.t}>{node.t}</span>
    </div>
  );
});

function InlineInput({ initial, onDone }: { initial: string; onDone: (t: string | null) => void }) {
  const [v, setV] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const finish = (t: string | null) => { if (done.current) return; done.current = true; onDone(t); };
  return (
    <input ref={ref} className="inline-edit" value={v} onChange={e => setV(e.target.value)}
      onMouseDown={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(v); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      }}
      onBlur={() => finish(v)} />
  );
}

interface TreeProps {
  rows: Row[]; selectedPk: string | null; q: string; editing: EditTarget;
  onToggle: (r: Row) => void; onSelect: (r: Row) => void; onEdit: (r: Row, f: 'key' | 'value') => void;
  onCommit: (r: Row, f: 'key' | 'value', text: string) => void; onCancel: () => void; onContext: (r: Row, e: React.MouseEvent) => void;
  onKeyDown: (e: React.KeyboardEvent) => void; onCopy: (e: React.ClipboardEvent) => void; onPaste: (e: React.ClipboardEvent) => void;
  scrollToPk: { pk: string; n: number } | null; containerRef: React.RefObject<HTMLDivElement>;
}

export function Tree(p: TreeProps) {
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const ref = p.containerRef;
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el); setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [ref]);
  useEffect(() => {
    const el = ref.current; if (!el || !p.scrollToPk) return;
    const idx = p.rows.findIndex(r => r.pk === p.scrollToPk!.pk);
    if (idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.scrollToPk]);
  const overscan = 20;
  const start = Math.max(0, Math.floor(scroll / ROW_H) - overscan);
  const end = Math.min(p.rows.length, Math.ceil((scroll + height) / ROW_H) + overscan);
  const visible = useMemo(() => p.rows.slice(start, end), [p.rows, start, end]);
  return (
    <div className="tree" ref={ref} tabIndex={0} data-testid="tree" onScroll={e => setScroll((e.target as HTMLDivElement).scrollTop)}
      onKeyDown={p.onKeyDown} onCopy={p.onCopy} onPaste={p.onPaste}>
      <div style={{ height: p.rows.length * ROW_H, position: 'relative' }}>
        <div style={{ position: 'absolute', top: start * ROW_H, left: 0, right: 0 }}>
          {visible.map(r => (
            <TreeRow key={r.pk} row={r} selected={r.pk === p.selectedPk} q={p.q}
              editing={p.editing && p.editing.pk === r.pk ? p.editing.field : null}
              onToggle={p.onToggle} onSelect={p.onSelect} onEdit={p.onEdit} onCommit={p.onCommit} onCancel={p.onCancel} onContext={p.onContext} />
          ))}
        </div>
      </div>
    </div>
  );
}
