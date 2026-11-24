import { useEffect, useMemo, useState } from 'react';
import type { PageProps } from '../App';
import { api, navigate, run } from '../api';
import { Banner, Card, Check, DevicePicker, EmptyState, JobCard, PageHeader, PlatformBadge, latestJob, pickDevice } from '../components/Common';
import { groupIcon, Icon } from '../components/Icon';
import { formatBytes } from '../../shared/export';
import type { RecoverGroup, TrashItem } from '../../shared/types';

export function Recover(props: PageProps) {
  const [tab, setTab] = useState<'backup' | 'phone'>('backup');
  return (
    <div className="page">
      <PageHeader title="Recover" subtitle="Get photos, messages, contacts and deleted items back out of a backup or straight off an Android phone.">
        <div className="segmented">
          <button className={tab === 'backup' ? 'active' : ''} onClick={() => setTab('backup')}>
            From a backup
          </button>
          <button className={tab === 'phone' ? 'active' : ''} onClick={() => setTab('phone')}>
            From the phone
          </button>
        </div>
      </PageHeader>
      {tab === 'backup' ? <FromBackup {...props} /> : <FromPhone {...props} />}
    </div>
  );
}

function FromBackup({ state }: PageProps) {
  const [backupId, setBackupId] = useState<string | null>(() => sessionStorage.getItem('mt.recoverBackup'));
  const backup = state.backups.find((b) => b.id === backupId) ?? state.backups[0];
  const [groups, setGroups] = useState<RecoverGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const job = latestJob(state, ['extract']);

  useEffect(() => {
    if (!backup) return;
    let live = true;
    setGroups(null);
    setError(null);
    setLoading(true);
    api
      .backupGroups(backup.id)
      .then((g) => {
        if (!live) return;
        setGroups(g);
        setChosen(g.filter((x) => x.available && x.deleted).map((x) => x.id));
      })
      .catch((e: Error) => live && setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [backup?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const extract = async () => {
    if (!backup) return;
    const dest = await run(api.chooseFolder('Choose where to save the recovered items'));
    if (!dest) return;
    run(api.extract({ backupId: backup.id, groups: chosen, dest }), 'Extraction started');
  };

  if (!state.backups.length)
    return (
      <EmptyState
        icon="library"
        title="No backups to recover from"
        action={
          <button className="btn primary" onClick={() => navigate('/backup')}>
            Make a backup
          </button>
        }
      >
        For an iPhone, make a backup first, then come back here to browse it. Finder and iTunes backups on this computer appear automatically.
      </EmptyState>
    );

  return (
    <>
      <Card title="Backup" icon="library">
        <select className="select" value={backup?.id} onChange={(e) => setBackupId(e.target.value)}>
          {state.backups.map((b) => (
            <option key={b.id} value={b.id}>
              {b.deviceName} — {new Date(b.createdAt).toLocaleString()} ({formatBytes(b.sizeBytes)}){b.source === 'system' ? ' · Finder/iTunes' : ''}
              {b.encrypted ? ' · encrypted' : ''}
            </option>
          ))}
        </select>
      </Card>
      {loading && <Banner kind="info">Reading the backup…</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
      {groups && (
        <Card title="What’s inside" icon="recover" actions={<span className="muted small">{chosen.length} selected</span>}>
          <div className="group-grid">
            {groups.map((g) => (
              <label key={g.id} className={`group ${chosen.includes(g.id) ? 'on' : ''} ${!g.available ? 'disabled' : ''} ${g.deleted ? 'deleted' : ''}`}>
                <input
                  type="checkbox"
                  disabled={!g.available}
                  checked={chosen.includes(g.id)}
                  onChange={(e) => setChosen((l) => (e.target.checked ? [...l, g.id] : l.filter((x) => x !== g.id)))}
                />
                <div className="group-icon">
                  <Icon name={groupIcon(g.id)} size={20} />
                </div>
                <div className="group-text">
                  <b>
                    {g.label} {g.deleted && <span className="pill deleted">Deleted</span>}
                  </b>
                  <small>{g.description}</small>
                  <span className="group-count">
                    {g.available ? (
                      <>
                        {g.count.toLocaleString()} item{g.count === 1 ? '' : 's'}
                        {g.bytes > 0 && ` · ${formatBytes(g.bytes)}`} · {g.format}
                      </>
                    ) : (
                      g.reason
                    )}
                  </span>
                </div>
              </label>
            ))}
          </div>
          {backup?.platform === 'ios' && (
            <p className="muted small">
              Deleted items can be recovered only while they were still on the phone (in Recently Deleted) when the backup was made. Data that was permanently
              removed before the backup is gone; no software can bring it back from a modern encrypted iPhone.
            </p>
          )}
        </Card>
      )}
      <div className="cta-row">
        {job && <JobCard job={job} />}
        <button className="btn primary large" disabled={!chosen.length || job?.status === 'running'} onClick={extract}>
          <Icon name="download" size={17} /> Save selected to computer…
        </button>
      </div>
    </>
  );
}

function FromPhone({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const job = device ? latestJob(state, ['recover'], device.id) : undefined;

  useEffect(() => {
    setItems(null);
    setChosen(new Set());
  }, [device?.id]);

  const bySource = useMemo(() => {
    const m = new Map<string, TrashItem[]>();
    for (const it of items ?? []) m.set(it.source, [...(m.get(it.source) ?? []), it]);
    return [...m];
  }, [items]);

  const scan = async () => {
    if (!device) return;
    setScanning(true);
    const r = await run(api.scanTrash(device.id));
    setScanning(false);
    if (r) {
      setItems(r);
      setChosen(new Set(r.filter((i) => !i.source.startsWith('Thumbnail')).map((i) => i.path)));
    }
  };

  const recover = async () => {
    if (!device || !items) return;
    const dest = await run(api.chooseFolder('Choose where to save recovered files'));
    if (!dest) return;
    run(api.pullTrash(device.id, items.filter((i) => chosen.has(i.path)), dest), 'Recovery started');
  };

  return (
    <>
      <Card title="Phone" icon="phone">
        <DevicePicker state={state} value={device?.id ?? null} onChange={select} />
      </Card>
      {device?.platform === 'ios' && (
        <Banner
          kind="info"
          action={
            <button className="btn" onClick={() => navigate('/backup')}>
              Back up iPhone
            </button>
          }
        >
          iOS does not let computers read the iPhone’s storage directly. Make a backup, then open it under <b>From a backup</b> to recover photos (including
          Recently Deleted), messages, contacts, notes and more.
        </Banner>
      )}
      {device?.platform === 'android' && device.state === 'ready' && (
        <Card
          title="Deleted files still on the phone"
          icon="recover"
          actions={
            <button className="btn" disabled={scanning} onClick={scan}>
              <Icon name="refresh" size={14} /> {scanning ? 'Scanning…' : items ? 'Scan again' : 'Scan phone'}
            </button>
          }
        >
          <p className="muted">
            Looks in Android’s trash (files deleted in the last 30 days), gallery recycle bins (Samsung, Xiaomi, OPPO/OnePlus…), file-manager trash and thumbnail
            caches that often keep previews of photos after the original is gone. Nothing on the phone is changed.
          </p>
          {items && items.length === 0 && <EmptyState icon="check" title="Nothing recoverable found">The phone’s trash and recycle bins are empty.</EmptyState>}
          {items && items.length > 0 && (
            <>
              <div className="list-tools">
                <button className="btn small" onClick={() => setChosen(new Set(items.map((i) => i.path)))}>
                  Select all
                </button>
                <button className="btn small" onClick={() => setChosen(new Set())}>
                  Select none
                </button>
                <span className="muted small">
                  {chosen.size.toLocaleString()} of {items.length.toLocaleString()} selected · {formatBytes(items.filter((i) => chosen.has(i.path)).reduce((n, i) => n + i.size, 0))}
                </span>
              </div>
              {bySource.map(([source, list]) => (
                <details key={source} className="trash-group" open={list.length < 60}>
                  <summary>
                    <Check
                      label={`${source}`}
                      description={`${list.length.toLocaleString()} files · ${formatBytes(list.reduce((n, i) => n + i.size, 0))}`}
                      checked={list.every((i) => chosen.has(i.path))}
                      onChange={(v) =>
                        setChosen((s) => {
                          const n = new Set(s);
                          for (const i of list) v ? n.add(i.path) : n.delete(i.path);
                          return n;
                        })
                      }
                    />
                  </summary>
                  <div className="trash-list">
                    {list.slice(0, 500).map((i) => (
                      <label key={i.path} className="trash-row" title={i.path}>
                        <input
                          type="checkbox"
                          checked={chosen.has(i.path)}
                          onChange={(e) =>
                            setChosen((s) => {
                              const n = new Set(s);
                              e.target.checked ? n.add(i.path) : n.delete(i.path);
                              return n;
                            })
                          }
                        />
                        <span className="trash-name">{i.name}</span>
                        <span className="muted">{formatBytes(i.size)}</span>
                        <span className="muted">{new Date(i.mtime).toLocaleDateString()}</span>
                      </label>
                    ))}
                    {list.length > 500 && <div className="muted small">…and {list.length - 500} more (included when the group is selected)</div>}
                  </div>
                </details>
              ))}
            </>
          )}
        </Card>
      )}
      {device?.platform === 'android' && (
        <div className="cta-row">
          {job && <JobCard job={job} />}
          <button className="btn primary large" disabled={!chosen.size || job?.status === 'running'} onClick={recover}>
            <Icon name="download" size={17} /> Recover {chosen.size ? chosen.size.toLocaleString() : ''} file{chosen.size === 1 ? '' : 's'}…
          </button>
        </div>
      )}
      {!device && <PlatformHint />}
    </>
  );
}

function PlatformHint() {
  return (
    <div className="grid two">
      <Card title="Android" icon="phone">
        <p className="muted">Connect the phone with USB debugging on to scan it for deleted photos and files that are still recoverable.</p>
        <PlatformBadge platform="android" />
      </Card>
      <Card title="iPhone" icon="phone">
        <p className="muted">Recover from a backup: photos, Recently Deleted, messages with attachments, contacts, notes, call history, voice memos and WhatsApp.</p>
        <PlatformBadge platform="ios" />
      </Card>
    </div>
  );
}
