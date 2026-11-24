import { useEffect, useState } from 'react';
import { api, onToast, Toast, useAppState } from './api';
import { Icon } from './components/Icon';
import { Activity } from './pages/Activity';
import { Backup } from './pages/Backup';
import { Devices } from './pages/Devices';
import { Erase } from './pages/Erase';
import { LibraryPage } from './pages/Library';
import { Recover } from './pages/Recover';
import { Restore } from './pages/Restore';
import { Settings } from './pages/Settings';
import { Transfer } from './pages/Transfer';
import type { AppState } from '../shared/types';

const NAV = [
  { route: '/', label: 'Devices', icon: 'phone' },
  { route: '/transfer', label: 'Transfer', icon: 'transfer' },
  { route: '/backup', label: 'Backup', icon: 'backup' },
  { route: '/restore', label: 'Restore', icon: 'restore' },
  { route: '/recover', label: 'Recover', icon: 'recover' },
  { route: '/erase', label: 'Erase', icon: 'erase' },
  { route: '/library', label: 'Backups', icon: 'library' },
  { route: '/activity', label: 'Activity', icon: 'activity' },
  { route: '/settings', label: 'Settings', icon: 'settings' },
];

export interface PageProps {
  state: AppState;
  selected: string | null;
  select: (id: string) => void;
}

function useRoute() {
  const [route, setRoute] = useState(() => location.hash.replace(/^#/, '') || '/');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setRoute(location.hash.replace(/^#/, '') || '/');
    window.addEventListener('hashchange', on);
    // Screenshot mode: "/transfer#photos" opens the Transfer page on its Photos tab.
    const off = api.onCapture((p) => {
      const [r, tab] = p.route.split('#');
      sessionStorage.setItem('mt.transferTab', (tab || 'home').replace(/-preview$/, ''));
      if (tab?.endsWith('-preview')) sessionStorage.setItem('mt.capturePreview', '1');
      else sessionStorage.removeItem('mt.capturePreview');
      location.hash = r;
      setTick((t) => t + 1);
    });
    return () => {
      window.removeEventListener('hashchange', on);
      off();
    };
  }, []);
  return { route, tick };
}

function useTheme(state: AppState | null) {
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const pref = state?.settings.theme ?? 'system';
      const dark = pref === 'dark' || (pref === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [state?.settings.theme]);
}

function Toasts() {
  const [items, setItems] = useState<Toast[]>([]);
  useEffect(
    () =>
      onToast((t) => {
        setItems((l) => [...l.slice(-3), t]);
        setTimeout(() => setItems((l) => l.filter((x) => x.id !== t.id)), t.kind === 'error' ? 7000 : 3500);
      }),
    [],
  );
  return (
    <div className="toasts">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'error' ? 'warning' : t.kind === 'success' ? 'check' : 'info'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const state = useAppState();
  const { route, tick } = useRoute();
  const [selected, setSelected] = useState<string | null>(null);
  useTheme(state);
  document.documentElement.dataset.platform = api.platform;

  if (!state) return <div className="boot">Starting MinTransfer…</div>;

  const props: PageProps = { state, selected, select: setSelected };
  const page = (() => {
    switch (route) {
      case '/transfer':
        return <Transfer {...props} />;
      case '/backup':
        return <Backup {...props} />;
      case '/restore':
        return <Restore {...props} />;
      case '/recover':
        return <Recover {...props} />;
      case '/erase':
        return <Erase {...props} />;
      case '/library':
        return <LibraryPage {...props} />;
      case '/activity':
        return <Activity {...props} />;
      case '/settings':
        return <Settings {...props} />;
      default:
        return <Devices {...props} />;
    }
  })();
  const running = state.jobs.filter((j) => j.status === 'running').length;

  return (
    <div className="app">
      <div className="drag-region" />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Icon name="backup" size={18} strokeWidth={2.2} />
          </div>
          <div>
            <div className="brand-name">MinTransfer</div>
            <div className="brand-sub">Phone ⇄ computer</div>
          </div>
        </div>
        <nav>
          {NAV.map((n) => (
            <a key={n.route} href={`#${n.route}`} className={`nav-item ${route === n.route ? 'active' : ''}`}>
              <Icon name={n.icon} size={17} />
              <span>{n.label}</span>
              {n.route === '/' && state.devices.length > 0 && <span className="nav-count">{state.devices.length}</span>}
              {n.route === '/activity' && running > 0 && <span className="nav-count live">{running}</span>}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {state.tools.map((t) => (
            <a key={t.id} href="#/settings" className="tool-status" title={t.found ? t.path : t.installHint}>
              <span className={`dot ${t.found ? 'ok' : 'missing'}`} />
              {t.id === 'adb' ? 'Android tools' : 'iPhone tools'}
              <span className="muted">{t.found ? (t.version?.split('-')[0] ?? 'ready') : 'missing'}</span>
            </a>
          ))}
          <div className="version">v{state.version}</div>
        </div>
      </aside>
      <main className="content" key={tick}>
        {page}
      </main>
      <Toasts />
    </div>
  );
}
