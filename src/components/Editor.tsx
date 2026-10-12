import { useEffect, useRef } from 'react';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection } from '@codemirror/view';
import { EditorState, Annotation } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import { linter, lintGutter, Diagnostic } from '@codemirror/lint';
import { bracketMatching, foldGutter, syntaxHighlighting, defaultHighlightStyle, indentOnInput } from '@codemirror/language';
import { parse } from '../lib/json';

const External = Annotation.define<boolean>();

interface Props { value: string; onChange: (v: string) => void; onUndo: () => void; onRedo: () => void }

export default function Editor({ value, onChange, onUndo, onRedo }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cbs = useRef({ onChange, onUndo, onRedo });
  cbs.current = { onChange, onUndo, onRedo };

  useEffect(() => {
    const jsonLint = linter(v => {
      const text = v.state.doc.toString();
      if (!text.trim()) return [];
      const r = parse(text);
      if (r.ok) return [];
      const from = Math.min(r.error.offset, text.length);
      const d: Diagnostic = { from, to: Math.min(from + 1, text.length), severity: 'error', message: `${r.error.message} (line ${r.error.line}, col ${r.error.col})` };
      return [d];
    }, { delay: 200 });
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), foldGutter(), drawSelection(), highlightActiveLine(),
          bracketMatching(), indentOnInput(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          json(), jsonLint, lintGutter(),
          keymap.of([
            { key: 'Mod-z', run: () => { cbs.current.onUndo(); return true; }, preventDefault: true },
            { key: 'Mod-Shift-z', run: () => { cbs.current.onRedo(); return true; }, preventDefault: true },
            { key: 'Mod-y', run: () => { cbs.current.onRedo(); return true; }, preventDefault: true },
            indentWithTab, ...defaultKeymap,
          ]),
          EditorView.updateListener.of(u => {
            if (u.docChanged && !u.transactions.some(t => t.annotation(External))) cbs.current.onChange(u.state.doc.toString());
          }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '13px' } }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) {
      const head = Math.min(v.state.selection.main.head, value.length);
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, selection: { anchor: head }, annotations: External.of(true) });
    }
  }, [value]);

  return <div className="editor" ref={host} data-testid="editor" />;
}
