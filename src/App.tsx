import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import Viewer, { ViewerApi } from './Viewer';

const ConvertTab = lazy(() => import('./tabs/ConvertTab'));
const CompareTab = lazy(() => import('./tabs/CompareTab'));
const JavaTab = lazy(() => import('./tabs/JavaTab'));

export type TabId = 'viewer' | 'convert' | 'compare' | 'java';
const TABS: { id: TabId; label: string }[] = [{ id: 'viewer', label: 'Viewer' }, { id: 'convert', label: 'Convert' }, { id: 'compare', label: 'Compare' }, { id: 'java', label: 'JSON → Java' }];
const fromHash = (): TabId => { const h = location.hash.replace('#', ''); return h === 'convert' || h === 'compare' || h === 'java' ? h : 'viewer'; };

export default function App() {
  const [tab, setTab] = useState<TabId>(fromHash);
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set([fromHash()]));
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
