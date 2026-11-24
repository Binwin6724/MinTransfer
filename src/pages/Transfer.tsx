// Transfer: a phone manager. Browse and copy photos, videos, music, information (contacts,
// messages, calls), apps and any file between a phone and this computer.
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PageProps } from '../App';
import { api, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, EmptyState, FreeSpace, JobCard, PageHeader, SpaceWarning, StorageBar, latestJob, pickDevice } from '../components/Common';
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
        <SpaceWarning free={state.space.transfer} need={slow ? phoneUsed(device) : null} estimate what="reading the iPhone for contacts and messages" />
        <div className="cta-row">
          <button className="btn primary large" disabled={busy || !chosen.length || lowSpace(state)} onClick={() => run(api.startTransfer({ deviceId: device.id, items: chosen }), 'Transfer started')}>
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
        <div className="small">
          <FreeSpace free={state.space.transfer} />
        </div>
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
  const [viewing, setViewing] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
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
        if (f.length && sessionStorage.getItem('mt.capturePreview')) setViewing(0); // screenshot mode
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
            {!ios && (
              <button className="btn small danger-outline" disabled={busy || !shown.length} onClick={() => setDeleting(true)}>
                <Icon name="trash" size={14} /> {picked.size ? 'Delete selected' : `Delete all ${shown.length.toLocaleString()}`}
              </button>
            )}
            <button
              className="btn primary small"
              disabled={busy || !exportList.length || tooBig(state, selBytes)}
              onClick={() => run(api.exportFiles(device.id, view, exportList), 'Copying to this computer')}
            >
              <Icon name="download" size={14} /> {picked.size ? 'Copy selected to computer' : 'Copy all to computer'}
            </button>
          </div>
          <SpaceWarning free={state.space.transfer} need={selBytes} what="copying these files" />
          {deleting && (
            <DeletePanel
              count={exportList.length}
              bytes={selBytes}
              noun={noun}
              device={device}
              whole={!picked.size && !album && !query}
              onCancel={() => setDeleting(false)}
              onCopyFirst={() => {
                setDeleting(false);
                run(api.exportFiles(device.id, view, exportList), 'Copying to this computer');
              }}
              onConfirm={() => {
                setDeleting(false);
                run(api.deleteFiles(device.id, exportList.map((f) => f.path)), 'Deleting…');
              }}
            />
          )}
          <p className="muted small hint">Click a name to view it.</p>
          <FileTable
            files={shown.slice(0, limit)}
            picked={picked}
            setPicked={setPicked}
            all={shown}
            columns={['name', 'album', 'date', 'size']}
            onPreview={(f) => setViewing(shown.indexOf(f))}
          />
          {shown.length > limit && (
            <button className="btn small more" onClick={() => setLimit((l) => l + PAGE * 3)}>
              Show more ({(shown.length - limit).toLocaleString()} left)
            </button>
          )}
          {ios && view !== 'music' && <IosDeleteHelp state={state} noun={noun} />}
        </>
      )}
      {viewing != null && shown[viewing] && (
        <PreviewModal
          device={device}
          files={shown}
          index={viewing}
          setIndex={setViewing}
          onCopy={(f) => run(api.exportFiles(device.id, view, [f]), 'Copying to this computer')}
        />
      )}
    </Card>
  );
}

/** Typed confirmation before deleting files from a phone. */
function DeletePanel({
  count,
  bytes,
  noun,
  device,
  whole,
  onCancel,
  onConfirm,
  onCopyFirst,
}: {
  count: number;
  bytes: number;
  noun: string;
  device: PhoneDevice;
  whole: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onCopyFirst: () => void;
}) {
  const [typed, setTyped] = useState('');
  return (
    <div className="delete-panel">
      <div className="delete-head">
        <Icon name="warning" size={18} />
        <b>
          Delete {whole ? 'all ' : ''}
          {count.toLocaleString()} {count === 1 ? noun.replace(/s$/, '') : noun} ({formatBytes(bytes)}) from {device.name}?
        </b>
      </div>
      <p className="small">
        They are deleted from the phone permanently, not moved to its trash, and can’t be recovered. Copy them to this computer first if you want to keep them.
      </p>
      <div className="delete-actions">
        <label className="inline-label">
          Type <b>DELETE</b> to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus spellCheck={false} />
        </label>
        <button className="btn" onClick={onCopyFirst}>
          <Icon name="download" size={14} /> Copy to computer first
        </button>
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn danger" disabled={typed.trim().toUpperCase() !== 'DELETE'} onClick={onConfirm}>
          <Icon name="trash" size={14} /> Delete {count.toLocaleString()}
        </button>
      </div>
    </div>
  );
}

/** iPhone photos can only be deleted through Apple's Photos library; explain how. */
function IosDeleteHelp({ state, noun }: { state: AppState; noun: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ios-delete">
      <button className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : `How do I delete ${noun} from this iPhone?`}
      </button>
      {open && (
        <div className="small">
          <p>
            Apple only lets the Photos library delete {noun}; removing the files directly would leave broken, blank items in Photos. Copy them to this computer first, then:
          </p>
          <ul>
            {state.platform === 'darwin' && (
              <li>
                <b>On this Mac:</b> open <b>Image Capture</b>, choose the iPhone, select all (⌘A) and click the delete button. It removes them through Photos.{' '}
                <button className="link" onClick={() => run(api.openImageCapture())}>
                  Open Image Capture
                </button>
              </li>
            )}
            {state.platform === 'win32' && (
              <li>
                <b>On this PC:</b> in the Windows <b>Photos</b> app choose Import ▸ the iPhone, and turn on “Delete original items after import”.
              </li>
            )}
            <li>
              <b>On the iPhone:</b> Photos ▸ Library ▸ All Photos ▸ Select, then drag across the photos (or tap and hold the first one and swipe) and tap the bin. Then
              empty Albums ▸ Recently Deleted.
            </li>
            <li>With iCloud Photos on, deleting removes them from iCloud and your other devices too.</li>
          </ul>
        </div>
      )}
    </div>
  );
}

/** Shows a phone file in the app: photos, videos and audio play here; anything else opens in its usual app. */
function PreviewModal({
  device,
  files,
  index,
  setIndex,
  onCopy,
}: {
  device: PhoneDevice;
  files: RemoteFile[];
  index: number;
  setIndex: (i: number | null) => void;
  onCopy?: (f: RemoteFile) => void;
}) {
  const file = files[index];
  const [p, setP] = useState<{ url: string | null; kind: string; localPath: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setP(null);
    setError(null);
    api
      .preview(device.id, file)
      .then((r) => live && setP(r))
      .catch((e: Error) => live && setError(clean(e)));
    return () => {
      live = false;
    };
  }, [file.path]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft' && index > 0) setIndex(index - 1);
      else if (e.key === 'ArrowRight' && index < files.length - 1) setIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const close = () => {
    api.cancelPreview().catch(() => {});
    setIndex(null);
  };
  // Rendered into <body>: cards use backdrop-filter, which would trap a fixed overlay inside them.
  return createPortal(
    <div className="modal-backdrop" onClick={close}>
      <div className="preview" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={baseName(file.path)}>
        <div className="preview-head">
          <div className="preview-title">
            <b>{baseName(file.path)}</b>
            <span className="muted small">
              {formatBytes(file.size)}
              {file.mtime ? ` · ${new Date(file.mtime).toLocaleString()}` : ''} · {index + 1} of {files.length.toLocaleString()}
            </span>
          </div>
          {p && (
            <button className="btn small" onClick={() => run(api.openPreview(p.localPath))}>
              <Icon name="external" size={14} /> Open in another app
            </button>
          )}
          {onCopy && (
            <button className="btn small" onClick={() => onCopy(file)}>
              <Icon name="download" size={14} /> Copy to computer
            </button>
          )}
          <button className="btn small" onClick={close} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="preview-body">
          {index > 0 && (
            <button className="preview-nav prev" onClick={() => setIndex(index - 1)} aria-label="Previous">
              ‹
            </button>
          )}
          {error ? (
            <div className="preview-msg error-text">{error}</div>
          ) : !p ? (
            <div className="preview-msg muted">Getting {baseName(file.path)} from {device.name}…</div>
          ) : p.url && p.kind === 'image' ? (
            <img src={p.url} alt={baseName(file.path)} />
          ) : p.url && p.kind === 'video' ? (
            <video src={p.url} controls autoPlay />
          ) : p.url && p.kind === 'audio' ? (
            <audio src={p.url} controls autoPlay />
          ) : (
            <div className="preview-msg">
              <p className="muted">This file can’t be shown here.</p>
              <button className="btn primary" onClick={() => run(api.openPreview(p.localPath))}>
                <Icon name="external" size={14} /> Open in another app
              </button>
            </div>
          )}
          {index < files.length - 1 && (
            <button className="preview-nav next" onClick={() => setIndex(index + 1)} aria-label="Next">
              ›
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FileTable({
  files,
  all,
  picked,
  setPicked,
  columns,
  onOpen,
  onPreview,
}: {
  files: RemoteFile[];
  all: RemoteFile[];
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  columns: ('name' | 'album' | 'date' | 'size')[];
  /** Folders: open them. */
  onOpen?: (f: RemoteFile) => void;
  /** Files: view them. */
  onPreview?: (f: RemoteFile) => void;
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
              {(f.dir ? onOpen : onPreview) ? (
                <button
                  className="link-name"
                  title={f.dir ? 'Open folder' : 'View'}
                  onClick={(e) => {
                    e.preventDefault();
                    (f.dir ? onOpen : onPreview)?.(f);
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
      <SpaceWarning free={state.space.transfer} need={device.platform === 'ios' ? phoneUsed(device) : null} estimate what="reading the iPhone for this information" />
      <div className="cta-row">
        <button className="btn primary large" disabled={busy || !chosen.length || lowSpace(state)} onClick={() => run(api.startTransfer({ deviceId: device.id, items: chosen }), 'Export started')}>
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
  const [viewing, setViewing] = useState<number | null>(null);
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
  const fileList = (entries ?? []).filter((e) => !e.dir);

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
                  run(api.deleteFiles(device.id, sel.map((f) => f.path)), 'Deleting…');
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
            <FileTable files={entries.slice(0, 2000)} all={entries} picked={picked} setPicked={setPicked} columns={['name', 'date', 'size']} onOpen={(f) => open(f.path)} onPreview={(f) => setViewing(fileList.indexOf(f))} />
          )}
        </>
      )}
      {viewing != null && fileList[viewing] && (
        <PreviewModal
          device={device}
          files={fileList}
          index={viewing}
          setIndex={setViewing}
          onCopy={(f) => run(api.exportFiles(device.id, 'files', [f], cur), 'Copying to this computer')}
        />
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ helpers

const GB = 1024 ** 3;

function phoneUsed(d: PhoneDevice) {
  return d.storageTotal && d.storageFree != null ? d.storageTotal - d.storageFree : null;
}

/** The transfer drive is nearly full. */
function lowSpace(state: AppState) {
  return state.space.transfer != null && state.space.transfer < 2 * GB;
}

/** Copying `bytes` would leave less than 1 GB free. */
function tooBig(state: AppState, bytes: number) {
  return state.space.transfer != null && bytes + GB > state.space.transfer;
}

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
