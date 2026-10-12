import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import Viewer, { ViewerApi } from './Viewer';
import { persist, oneOf } from './lib/storage';

const ConvertTab = lazy(() => import('./tabs/ConvertTab'));
const CompareTab = lazy(() => import('./tabs/CompareTab'));
const JavaTab = lazy(() => import('./tabs/JavaTab'));

export type TabId = 'viewer' | 'convert' | 'compare' | 'java';
const TABS: { id: TabId; label: string }[] = [{ id: 'viewer', label: 'Viewer' }, { id: 'convert', label: 'Convert' }, { id: 'compare', label: 'Compare' }, { id: 'java', label: 'JSON → Java' }];
const isTab = oneOf(['viewer', 'convert', 'compare', 'java'] as const);
const fromHash = (): TabId => { const h = location.hash.replace('#', ''); return isTab(h) ? h : 'viewer'; };
/** Initial tab: explicit URL hash wins, then the saved tab, then Viewer. */
const initialTab = (): TabId => { const h = location.hash.replace('#', ''); if (isTab(h)) return h; return persist.load('tab', x => (isTab(x) ? x : undefined)) ?? 'viewer'; };
const KEY_LABEL: Record<string, string> = { viewer: 'Viewer', convert: 'Convert', compare: 'Compare', java: 'JSON → Java' };

export default function App() {
  const [tab, setTab] = useState<TabId>(initialTab);
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([tab]));
  const [tooLarge, setTooLarge] = useState<string[]>([]);
  useEffect(() => { persist.save('tab', tab); }, [tab]);
  useEffect(() => persist.onStatus(() => setTooLarge([...persist.failed.keys()].filter(k => k !== 'tab'))), []);
  const clearSaved = () => {
    if (!window.confirm('Clear all data saved in this browser and reset every tab to the samples?')) return;
    persist.clearAll();
    location.replace(location.pathname);
  };
  const viewer = useRef<ViewerApi | null>(null);
  useEffect(() => {
    const h = () => setTab(fromHash());
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, []);
  useEffect(() => { setVisited(v => (v.has(tab) ? v : new Set(v).add(tab))); }, [tab]);
  const go = (t: TabId) => { if (t !== tab) { history.replaceState(null, '', t === 'viewer' ? location.pathname : '#' + t); setTab(t); } };
  const sendToViewer = (text: string) => { viewer.current?.loadText(text); go('viewer'); };
  return (
    <div className="app">
      <nav className="tabs" role="tablist">
        <strong className="brand">JSON&nbsp;World</strong>
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => go(t.id)}>{t.label}</button>
        ))}
        <span className="grow" />
        {tooLarge.length ? <span className="storenote warn" data-testid="store-warn" title="Your data is kept in memory for this session only">⚠ Too large to save locally: {tooLarge.map(k => KEY_LABEL[k] ?? k).join(', ')}</span> : null}
        <span className="storenote" data-testid="store-note">{persist.available ? 'Data stays in this browser only (localStorage)' : 'Local saving unavailable (private mode?) — data is not kept after reload'}</span>
        <button className="clearbtn" onClick={clearSaved} data-testid="clear-saved">Clear saved data</button>
      </nav>
      <Viewer apiRef={viewer} active={tab === 'viewer'} />
      <Suspense fallback={<div className="loading">Loading…</div>}>
        {visited.has('convert') ? <div className="tabpane" style={{ display: tab === 'convert' ? undefined : 'none' }}><ConvertTab onSendToViewer={sendToViewer} getViewerText={() => viewer.current?.getText() ?? ''} /></div> : null}
        {visited.has('compare') ? <div className="tabpane" style={{ display: tab === 'compare' ? undefined : 'none' }}><CompareTab getViewerText={() => viewer.current?.getText() ?? ''} /></div> : null}
        {visited.has('java') ? <div className="tabpane" style={{ display: tab === 'java' ? undefined : 'none' }}><JavaTab getViewerText={() => viewer.current?.getText() ?? ''} /></div> : null}
      </Suspense>
    </div>
  );
}
