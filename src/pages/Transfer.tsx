// Transfer: a phone manager. Browse and copy photos, videos, music, information (contacts,
// messages, calls), apps and any file between a phone and this computer.
import { useEffect, useMemo, useState } from 'react';
import type { PageProps } from '../App';
import { api, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, EmptyState, JobCard, PageHeader, StorageBar, latestJob, pickDevice } from '../components/Common';
import { groupIcon, Icon } from '../components/Icon';
import { formatBytes } from '../../shared/export';
import { transferItemsFor, type MediaView, type PhoneApp, type RemoteFile } from '../../shared/transfer';
import type { AppState, PhoneDevice, TransferItemId } from '../../shared/types';

type Tab = 'home' | 'music' | 'videos' | 'photos' | 'info' | 'apps' | 'explorer';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: 'phone' },
  { id: 'music', label: 'Music', icon: 'music' },
  { id: 'videos', label: 'Videos', icon: 'video' },
  { id: 'photos', label: 'Photos', icon: 'photo' },
  { id: 'info', label: 'Information', icon: 'contacts' },
  { id: 'apps', label: 'Apps', icon: 'app' },
  { id: 'explorer', label: 'Explorer', icon: 'folder' },
];

const PAGE = 300;
const clean = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

export function Transfer({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  const [tab, setTab] = useState<Tab>(() => (sessionStorage.getItem('mt.transferTab') as Tab) || 'home');
  const go = (t: Tab) => {
    sessionStorage.setItem('mt.transferTab', t);
    setTab(t);
  };
  const ready = device?.state === 'ready';

  return (
    <div className="page">
      <PageHeader title="Transfer" subtitle="Pick photos, videos, music, contacts, apps or any file and copy them between your phone and this computer.">
        {device && (
          <button className="btn" onClick={() => run(api.openTransferFolder(device.id))}>
            <Icon name="folder" size={15} /> Open folder
          </button>
        )}
      </PageHeader>
      <Card title="Phone" icon="phone">
        <DevicePicker state={state} value={device?.id ?? null} onChange={select} />
      </Card>
      {device && <DeviceNotReady device={device} />}
      {device && ready && (
        <>
          <div className="tabbar" role="tablist">
            {TABS.map((t) => (
              <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => go(t.id)}>
                <Icon name={t.icon} size={15} /> {t.label}
              </button>
            ))}
          </div>
          {tab === 'home' && <Home state={state} device={device} go={go} />}
          {(tab === 'photos' || tab === 'videos' || tab === 'music') && <Media key={`${device.id}-${tab}`} state={state} device={device} view={tab} />}
          {tab === 'info' && <Information state={state} device={device} />}
          {tab === 'apps' && <Apps key={device.id} state={state} device={device} />}
          {tab === 'explorer' && <Explorer key={device.id} state={state} device={device} />}
          <TransferJob state={state} device={device} />
        </>
      )}
    </div>
  );
}

function TransferJob({ state, device }: { state: AppState; device: PhoneDevice }) {
  const job = latestJob(state, ['transfer'], device.id);
  return job ? <JobCard job={job} /> : null;
}

function useTransferBusy(state: AppState, device: PhoneDevice) {
  return latestJob(state, ['transfer'], device.id)?.status === 'running';
}

/** Calls `fn` whenever a transfer job for this phone finishes (to refresh lists after copy / delete). */
function useAfterJob(state: AppState, device: PhoneDevice, fn: () => void) {
  const job = latestJob(state, ['transfer'], device.id);
  const key = job && job.status !== 'running' ? `${job.id}:${job.status}` : '';
  useEffect(() => {
    if (key) fn();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}

function needsHelper(state: AppState, device: PhoneDevice) {
  return device.platform === 'ios' && !state.iosFiles;
}

function HelperMissing() {
  return (
    <Banner kind="warn">
      MinTransfer’s iPhone file helper is missing from this installation, so iPhone files can’t be browsed. Reinstall MinTransfer from the latest release.
    </Banner>
  );
}

// ------------------------------------------------------------------ Home

function Home({ state, device, go }: { state: AppState; device: PhoneDevice; go: (t: Tab) => void }) {
  const items = transferItemsFor(device.platform);
  const [chosen, setChosen] = useState<TransferItemId[]>(['photos', 'videos', 'contacts']);
  const busy = useTransferBusy(state, device);
  const slow = device.platform === 'ios' && chosen.some((c) => items.find((i) => i.id === c)?.ios === 'backup');
  const toggle = (id: TransferItemId, on: boolean) => setChosen((c) => (on ? [...c, id] : c.filter((x) => x !== id)));

  return (
    <>
      <div className="grid two">
        <Card title={device.name} icon="phone">
          <div className="muted device-line">
            {device.model} · {device.osName} {device.osVersion}
            {device.battery != null && ` · ${device.battery}% battery`}
          </div>
          <StorageBar total={device.storageTotal} free={device.storageFree} />
        </Card>
        <Card title="Browse" icon="folder">
          <div className="quick-links">
            {TABS.filter((t) => t.id !== 'home').map((t) => (
              <button key={t.id} className="quick-link" onClick={() => go(t.id)}>
                <Icon name={t.icon} size={20} />
                <span>{t.label}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card
        title="Quick transfer to this computer"
        icon="download"
        actions={
          <span className="select-links">
            <button className="link" disabled={busy} onClick={() => setChosen(items.map((i) => i.id))}>
              Select all
            </button>
            <button className="link" disabled={busy} onClick={() => setChosen([])}>
              Clear
            </button>
          </span>
        }
      >
        <div className="check-grid">
          {items.map((c) => (
            <Check
              key={c.id}
              icon={groupIcon(c.id)}
              label={c.label}
              description={c.description}
              checked={chosen.includes(c.id)}
              disabled={busy}
              onChange={(v) => toggle(c.id, v)}
            />
          ))}
          {device.platform === 'ios' && (
            <Check icon="music" label="Music" description="Not possible on iPhone: Apple keeps music in the Music app’s private library." checked={false} disabled onChange={() => {}} />
          )}
        </div>
        {slow && (
          <p className="muted small">
            Contacts, messages, calls, notes, voice memos and WhatsApp are kept in app storage Apple only hands out as a full backup, so they take as long as one. Photos and
            videos are copied directly and quickly.
          </p>
        )}
        <DestinationRow state={state} />
        <div className="cta-row">
          <button className="btn primary large" disabled={busy || !chosen.length} onClick={() => run(api.startTransfer({ deviceId: device.id, items: chosen }), 'Transfer started')}>
            <Icon name="download" size={17} /> {busy ? 'Transferring…' : 'Transfer to computer'}
          </button>
        </div>
      </Card>
    </>
  );
}

function DestinationRow({ state }: { state: AppState }) {
  return (
    <div className="dest-row">
      <div>
        <div className="muted small">Saved to</div>
        <div className="mono">{state.settings.transferDir}</div>
        <div className="muted small">Each phone gets its own folder. Files already copied are skipped, so the next transfer only copies what’s new.</div>
      </div>
      <button
        className="btn"
        onClick={async () => {
          const dir = await run(api.chooseFolder('Choose where to save transfers', state.settings.transferDir));
          if (dir) run(api.setSettings({ transferDir: dir }));
        }}
      >
        Change…
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ Photos / Videos / Music

function Media({ state, device, view }: { state: AppState; device: PhoneDevice; view: MediaView }) {
  const [files, setFiles] = useState<RemoteFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [album, setAlbum] = useState<string>('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [query, setQuery] = useState('');
  const busy = useTransferBusy(state, device);
  const ios = device.platform === 'ios';
  const noun = view === 'photos' ? 'photos' : view === 'videos' ? 'videos' : 'songs and audio files';

  const load = () => {
    setError(null);
    setFiles(null);
    api
      .listMedia(device.id, view)
      .then((f) => {
        setFiles(f);
        setPicked(new Set());
      })
      .catch((e: Error) => setError(clean(e)));
  };
  useEffect(() => {
    if (ios && view === 'music') return;
    if (needsHelper(state, device)) return;
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useAfterJob(state, device, () => files && load());

  const albums = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of files ?? []) m.set(albumOf(f), (m.get(albumOf(f)) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  }, [files]);
  const shown = useMemo(
    () => (files ?? []).filter((f) => (!album || albumOf(f) === album) && (!query || baseName(f.path).toLowerCase().includes(query.toLowerCase()))),
    [files, album, query],
  );

  if (ios && view === 'music')
    return (
      <EmptyState icon="music" title="iPhone music can’t be copied">
        Apple keeps songs in the Music app’s private library, which computers can’t read. Purchases come back from the iTunes Store or Apple Music; songs from your own
        computer stay in its Music app or iTunes.
      </EmptyState>
    );
  if (needsHelper(state, device)) return <HelperMissing />;

  const selectedFiles = shown.filter((f) => picked.has(f.path));
  const exportList = selectedFiles.length ? selectedFiles : shown;
  const selBytes = exportList.reduce((n, f) => n + f.size, 0);

  return (
    <Card
      title={view === 'photos' ? 'Photos' : view === 'videos' ? 'Videos' : 'Music & audio'}
      icon={groupIcon(view)}
      actions={
        <>
          {!ios && (
            <button className="btn small" disabled={busy} onClick={() => run(api.importFiles(device.id, view))}>
              <Icon name="backup" size={14} /> Add from computer
            </button>
          )}
          <button className="btn small" onClick={load}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}
      {!files && !error && <div className="muted loading-row">Looking for {noun} on {device.name}…</div>}
      {files && files.length === 0 && <EmptyState icon={groupIcon(view)} title={`No ${noun} found`}>{ios ? 'Photos kept only in iCloud aren’t on the iPhone itself.' : 'Nothing in the usual folders on this phone.'}</EmptyState>}
      {files && files.length > 0 && (
        <>
          <div className="list-toolbar">
            <select className="select" value={album} onChange={(e) => setAlbum(e.target.value)}>
              <option value="">All albums ({files.length.toLocaleString()})</option>
              {albums.map(([a, n]) => (
                <option key={a} value={a}>
                  {a} ({n.toLocaleString()})
                </option>
              ))}
            </select>
            <input className="search" placeholder="Search names" value={query} onChange={(e) => setQuery(e.target.value)} />
            <span className="muted small grow">
              {picked.size ? `${selectedFiles.length.toLocaleString()} selected` : `${shown.length.toLocaleString()} ${noun}`} · {formatBytes(selBytes)}
            </span>
            {!ios && picked.size > 0 && (
              <button
                className="btn small danger-outline"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Delete ${selectedFiles.length} file(s) from ${device.name}? This can’t be undone.`)) return;
                  await run(api.deleteFiles(device.id, selectedFiles.map((f) => f.path)), 'Deleted');
                  load();
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            )}
            <button className="btn primary small" disabled={busy || !exportList.length} onClick={() => run(api.exportFiles(device.id, view, exportList), 'Copying to this computer')}>
              <Icon name="download" size={14} /> {picked.size ? 'Copy selected to computer' : 'Copy all to computer'}
            </button>
          </div>
          <FileTable
            files={shown.slice(0, limit)}
            picked={picked}
            setPicked={setPicked}
            all={shown}
            columns={['name', 'album', 'date', 'size']}
          />
          {shown.length > limit && (
            <button className="btn small more" onClick={() => setLimit((l) => l + PAGE * 3)}>
              Show more ({(shown.length - limit).toLocaleString()} left)
            </button>
          )}
          {ios && <p className="muted small">Photos and videos can be removed from an iPhone in its Photos app only. To add photos, use iCloud Photos or Finder / Apple Devices sync.</p>}
        </>
      )}
    </Card>
  );
}

function FileTable({
  files,
  all,
  picked,
  setPicked,
  columns,
  onOpen,
}: {
  files: RemoteFile[];
  all: RemoteFile[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  columns: ('name' | 'album' | 'date' | 'size')[];
  onOpen?: (f: RemoteFile) => void;
}) {
  const allOn = all.length > 0 && all.every((f) => picked.has(f.path));
  const toggle = (p: string, on: boolean) => {
    const s = new Set(picked);
    if (on) s.add(p);
    else s.delete(p);
    setPicked(s);
  };
  return (
    <div className="file-table">
      <div className={`file-row head ${columns.includes('album') ? '' : 'no-album'}`}>
        <input type="checkbox" checked={allOn} onChange={(e) => setPicked(e.target.checked ? new Set(all.map((f) => f.path)) : new Set())} aria-label="Select all" />
        <span>Name</span>
        {columns.includes('album') && <span>Album</span>}
        <span>Date</span>
        <span className="num">Size</span>
      </div>
      <div className="file-body">
        {files.map((f) => (
          <label key={f.path} className={`file-row ${picked.has(f.path) ? 'on' : ''} ${columns.includes('album') ? '' : 'no-album'}`}>
            <input type="checkbox" checked={picked.has(f.path)} onChange={(e) => toggle(f.path, e.target.checked)} />
            <span className="file-name" title={f.path}>
              <Icon name={f.dir ? 'folder' : fileIcon(f.path)} size={14} />
              {f.dir && onOpen ? (
                <button
                  className="link-name"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(f);
                  }}
                >
                  {baseName(f.path)}
                </button>
              ) : (
                <span>{baseName(f.path)}</span>
              )}
            </span>
            {columns.includes('album') && <span className="muted">{albumOf(f)}</span>}
            <span className="muted">{f.mtime ? new Date(f.mtime).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : ''}</span>
            <span className="muted num">{f.dir ? '' : formatBytes(f.size)}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Information

function Information({ state, device }: { state: AppState; device: PhoneDevice }) {
  const ids: TransferItemId[] = device.platform === 'ios' ? ['contacts', 'messages', 'calls', 'notes', 'voicememos', 'whatsapp'] : ['contacts', 'messages', 'calls'];
  const items = transferItemsFor(device.platform).filter((i) => ids.includes(i.id));
  const [chosen, setChosen] = useState<TransferItemId[]>(['contacts']);
  const busy = useTransferBusy(state, device);
  return (
    <Card title="Contacts, messages and more" icon="contacts">
      <div className="check-grid">
        {items.map((c) => (
          <Check
            key={c.id}
            icon={groupIcon(c.id)}
            label={c.label}
            description={c.description}
            checked={chosen.includes(c.id)}
            disabled={busy}
            onChange={(v) => setChosen((x) => (v ? [...x, c.id] : x.filter((y) => y !== c.id)))}
          />
        ))}
      </div>
      {device.platform === 'ios' ? (
        <p className="muted small">
          Apple only hands this data to computers as a full backup, so MinTransfer reads the whole iPhone into a temporary folder, saves what you picked and deletes the
          rest. It takes as long as a backup and needs that much free space while it runs. Data synced with iCloud only (for example contacts) may not be on the phone.
        </p>
      ) : (
        <p className="muted small">Saved as a vCard (.vcf) and CSV files. Many phones block call log and SMS for USB tools; MinTransfer says so if that happens.</p>
      )}
      <DestinationRow state={state} />
      <div className="cta-row">
        <button className="btn primary large" disabled={busy || !chosen.length} onClick={() => run(api.startTransfer({ deviceId: device.id, items: chosen }), 'Export started')}>
          <Icon name="download" size={17} /> Export to computer
        </button>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ Apps

function Apps({ state, device }: { state: AppState; device: PhoneDevice }) {
  const [apps, setApps] = useState<PhoneApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const busy = useTransferBusy(state, device);
  const ios = device.platform === 'ios';
  const load = () => {
    setError(null);
    setApps(null);
    api
      .listApps(device.id)
      .then((a) => {
        setApps(a);
        setPicked(new Set());
      })
      .catch((e: Error) => setError(clean(e)));
  };
  useEffect(() => {
    if (!needsHelper(state, device)) load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useAfterJob(state, device, () => apps && load());
  if (needsHelper(state, device)) return <HelperMissing />;

  const shown = (apps ?? []).filter((a) => !query || `${a.name} ${a.id}`.toLowerCase().includes(query.toLowerCase()));
  const sel = shown.filter((a) => picked.has(a.id));
  const uninstall = async () => {
    if (!confirm(`Remove ${sel.length} app(s) from ${device.name}? ${ios ? 'Their data is deleted too.' : 'Their data is deleted too.'}`)) return;
    for (const a of sel) await run(api.uninstallApp(device.id, a.id));
    load();
  };

  return (
    <Card
      title="Apps"
      icon="app"
      actions={
        <>
          {!ios && (
            <button className="btn small" disabled={busy} onClick={() => run(api.installApps(device.id))}>
              <Icon name="backup" size={14} /> Install APK…
            </button>
          )}
          <button className="btn small" onClick={load}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </>
      }
    >
      {error && <Banner kind="error">{error}</Banner>}
      {!apps && !error && <div className="muted loading-row">Reading apps on {device.name}…</div>}
      {apps && (
        <>
          <div className="list-toolbar">
            <input className="search" placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} />
            <span className="muted small grow">{sel.length ? `${sel.length} selected` : `${shown.length} apps you installed`}</span>
            {sel.length > 0 && (
              <button className="btn small danger-outline" disabled={busy} onClick={uninstall}>
                <Icon name="trash" size={14} /> Uninstall
              </button>
            )}
            {!ios && (
              <button className="btn primary small" disabled={busy || !sel.length} onClick={() => run(api.exportApps(device.id, sel.map((a) => a.id)), 'Saving apps')}>
                <Icon name="download" size={14} /> Save APK to computer
              </button>
            )}
          </div>
          <div className="file-table">
            <div className="file-row head apps">
              <input
                type="checkbox"
                checked={shown.length > 0 && shown.every((a) => picked.has(a.id))}
                onChange={(e) => setPicked(e.target.checked ? new Set(shown.map((a) => a.id)) : new Set())}
                aria-label="Select all"
              />
              <span>App</span>
              <span>Version</span>
              <span className="num">Size</span>
            </div>
            <div className="file-body">
              {shown.map((a) => (
                <label key={a.id} className={`file-row apps ${picked.has(a.id) ? 'on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={picked.has(a.id)}
                    onChange={(e) => {
                      const s = new Set(picked);
                      if (e.target.checked) s.add(a.id);
                      else s.delete(a.id);
                      setPicked(s);
                    }}
                  />
                  <span className="file-name">
                    <Icon name="app" size={14} />
                    <span>
                      {a.name}
                      {a.name !== a.id && <small className="muted"> {a.id}</small>}
                    </span>
                  </span>
                  <span className="muted">{a.version}</span>
                  <span className="muted num">{a.size ? formatBytes(a.size + (a.dataSize ?? 0)) : ''}</span>
                </label>
              ))}
            </div>
          </div>
          {ios && <p className="muted small">Apple doesn’t let computers copy iPhone apps; they download again from the App Store. Size includes each app’s data.</p>}
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ Explorer

function Explorer({ state, device }: { state: AppState; device: PhoneDevice }) {
  const [dir, setDir] = useState<string | null>(null);
  const [root, setRoot] = useState<string>(device.platform === 'ios' ? '/' : '/sdcard');
  const [entries, setEntries] = useState<RemoteFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const busy = useTransferBusy(state, device);

  const open = (target?: string) => {
    setError(null);
    setEntries(null);
    api
      .listDir(device.id, target)
      .then((r) => {
        setDir(r.dir);
        setRoot(r.root);
        setEntries(r.entries);
        setPicked(new Set());
      })
      .catch((e: Error) => {
        setError(clean(e));
        setEntries([]);
      });
  };
  useEffect(() => {
    if (!needsHelper(state, device)) open();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useAfterJob(state, device, () => dir && open(dir));
  if (needsHelper(state, device)) return <HelperMissing />;

  const cur = dir ?? root;
  const crumbs = crumbsOf(cur, root);
  const sel = (entries ?? []).filter((e) => picked.has(e.path));

  return (
    <Card
      title="Explorer"
      icon="folder"
      actions={
        <>
          <button className="btn small" disabled={busy || !dir} onClick={() => run(api.importFiles(device.id, 'files', cur))}>
            <Icon name="backup" size={14} /> Copy files here…
          </button>
          <button className="btn small" onClick={() => open(cur)}>
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </>
      }
    >
      <div className="crumbs">
        {cur !== root && (
          <button className="btn small" onClick={() => open(parentOf(cur, root))} aria-label="Up one folder">
            ↑
          </button>
        )}
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="muted"> / </span>}
            <button className="link" onClick={() => open(c.path)}>
              {c.label}
            </button>
          </span>
        ))}
      </div>
      {device.platform === 'ios' && cur === root && (
        <p className="muted small">This is the part of the iPhone Apple lets computers open: the camera roll (DCIM), Downloads, Books, Recordings and similar folders.</p>
      )}
      {error && <Banner kind="error">{error}</Banner>}
      {!entries && !error && <div className="muted loading-row">Opening {cur}…</div>}
      {entries && (
        <>
          <div className="list-toolbar">
            <span className="muted small grow">{sel.length ? `${sel.length} selected` : `${entries.length} items`}</span>
            {sel.length > 0 && (
              <button
                className="btn small danger-outline"
                disabled={busy}
                onClick={async () => {
                  if (!confirm(`Delete ${sel.length} item(s) from ${device.name}? Folders are deleted with everything in them. This can’t be undone.`)) return;
                  await run(api.deleteFiles(device.id, sel.map((f) => f.path)), 'Deleted');
                  open(cur);
                }}
              >
                <Icon name="trash" size={14} /> Delete
              </button>
            )}
            <button className="btn primary small" disabled={busy || !sel.length} onClick={() => run(api.exportFiles(device.id, 'files', sel, cur), 'Copying to this computer')}>
              <Icon name="download" size={14} /> Copy to computer
            </button>
          </div>
          {entries.length === 0 && !error ? (
            <div className="muted loading-row">This folder is empty.</div>
          ) : (
            <FileTable files={entries.slice(0, 2000)} all={entries} picked={picked} setPicked={setPicked} columns={['name', 'date', 'size']} onOpen={(f) => open(f.path)} />
          )}
        </>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ helpers

function baseName(p: string) {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** The folder a file is in: DCIM/100APPLE → 100APPLE, Pictures/Screenshots → Screenshots. */
function albumOf(f: RemoteFile) {
  const parts = f.path.split('/');
  return parts[parts.length - 2] || '/';
}

function fileIcon(p: string) {
  if (/\.(jpe?g|heic|heif|png|gif|webp|dng|bmp|tiff?)$/i.test(p)) return 'photo';
  if (/\.(mov|mp4|m4v|3gp|mkv|webm|avi)$/i.test(p)) return 'video';
  if (/\.(mp3|m4a|aac|wav|flac|ogg|opus|amr)$/i.test(p)) return 'music';
  if (/\.apk$/i.test(p)) return 'app';
  return 'doc';
}

function parentOf(p: string, root: string) {
  const up = p.slice(0, p.lastIndexOf('/')) || '/';
  return up.length < root.length ? root : up;
}

function crumbsOf(p: string, root: string) {
  const crumbs = [{ label: root === '/' ? 'iPhone' : 'Phone storage', path: root }];
  const rest = p.slice(root.length).split('/').filter(Boolean);
  let acc = root === '/' ? '' : root;
  for (const r of rest) {
    acc = `${acc}/${r}`;
    crumbs.push({ label: r, path: acc });
  }
  return crumbs;
}
