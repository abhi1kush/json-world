import { useEffect, useRef } from 'react';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { EditorView, Decoration, keymap, lineNumbers, highlightActiveLine, drawSelection } from '@codemirror/view';
import { EditorState, Compartment, Annotation, StateEffect, StateField } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { java } from '@codemirror/lang-java';

const External = Annotation.define<boolean>();
/** Whole-line highlight for the error line (the lint underline alone is easy to miss). */
const setErrLine = StateEffect.define<number | null>();
const errLineField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setErrLine)) deco = e.value == null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-error-line' }).range(e.value)]);
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});
export interface EditorDiag { from: number; to: number; message: string }
const langOf = (l: string) => (l === 'yaml' ? yaml() : l === 'xml' ? xml() : l === 'java' ? java() : json());

interface Props { value: string; onChange?: (v: string) => void; lang: 'json' | 'yaml' | 'xml' | 'java'; readOnly?: boolean; testId?: string; diagnostics?: EditorDiag[] | null }

/** Generic CodeMirror editor (own undo history) used by the Convert and Compare tabs. */
export default function CodeEditor({ value, onChange, lang, readOnly, testId, diagnostics }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const langC = useRef(new Compartment());
  const cb = useRef(onChange); cb.current = onChange;
  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(), foldGutter(), drawSelection(), highlightActiveLine(), bracketMatching(), history(), lintGutter(), errLineField,
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }), langC.current.of(langOf(lang)),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          EditorState.readOnly.of(!!readOnly),
          EditorView.updateListener.of(u => { if (u.docChanged && !u.transactions.some(t => t.annotation(External))) cb.current?.(u.state.doc.toString()); }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: '13px' } }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { view.current?.dispatch({ effects: langC.current.reconfigure(langOf(lang)) }); }, [lang]);
  useEffect(() => {
    const v = view.current; if (!v) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, annotations: External.of(true) });
  }, [value]);
  useEffect(() => {
    const v = view.current; if (!v) return;
    const len = v.state.doc.length;
    const ds = (diagnostics ?? []).map(d => ({ from: Math.min(d.from, len), to: Math.min(d.to, len), severity: 'error' as const, message: d.message }));
    const first = ds[0];
    v.dispatch(setDiagnostics(v.state, ds), {
      effects: [setErrLine.of(first ? v.state.doc.lineAt(first.from).from : null), ...(first ? [EditorView.scrollIntoView(first.from, { y: 'nearest' })] : [])],
    });
  }, [diagnostics]);
  return <div className="editor" ref={host} data-testid={testId} />;
}
