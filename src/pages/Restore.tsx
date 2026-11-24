import { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { api, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, EmptyState, JobCard, PageHeader, PlatformBadge, latestJob, pickDevice } from '../components/Common';
import { groupIcon, Icon } from '../components/Icon';
import { categoryById } from '../../shared/android';
import { formatBytes } from '../../shared/export';

export function Restore({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  // "Chosen items" iPhone backups are plain files, not device backups, so they can't be restored.
  const backups = state.backups.filter((b) => b.kind !== 'items' && (!device || b.platform === device.platform));
  const [backupId, setBackupId] = useState<string | null>(null);
  const backup = backups.find((b) => b.id === backupId) ?? backups.find((b) => b.deviceId === device?.id || b.deviceId === device?.serial) ?? backups[0];
  const [cats, setCats] = useState<string[]>([]);
  const [opts, setOpts] = useState({ settings: true, system: false, reboot: true, copy: true });
  const [password, setPassword] = useState('');
  const [confirmIos, setConfirmIos] = useState(false);
  const job = device ? latestJob(state, ['restore'], device.id) : undefined;
  const busy = job?.status === 'running';

  const restorable = (backup?.categories ?? []).filter((c) => c.files > 0 && (['files', 'all', 'apps'].includes(categoryById(c.id)?.kind ?? '') || c.id === 'contacts'));
  useEffect(() => setCats(restorable.map((c) => c.id)), [backup?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => {
    if (!device || !backup) return;
    run(
      api.startRestore({
        deviceId: device.id,
        backupId: backup.id,
        categories: cats,
        ios: device.platform === 'ios' ? { ...opts, password: backup.encrypted ? password : undefined } : undefined,
      }),
      'Restore started',
    );
  };

  return (
    <div className="page">
      <PageHeader title="Restore" subtitle="Put a backup back onto a phone: the same one, or a new one of the same kind." />
      <Card title="Restore to" icon="phone">
        <DevicePicker state={state} value={device?.id ?? null} onChange={select} />
      </Card>
      {device && <DeviceNotReady device={device} />}

      <Card title="Backup to restore" icon="library">
        {backups.length === 0 ? (
          <EmptyState icon="library" title={device ? `No ${device.platform === 'ios' ? 'iPhone' : 'Android'} backups yet` : 'No backups yet'}>
            Make a backup first, or choose the folder that holds your backups in Settings.
          </EmptyState>
        ) : (
          <div className="backup-list selectable">
            {backups.map((b) => (
              <button key={b.id} className={`backup-row ${backup?.id === b.id ? 'active' : ''}`} onClick={() => setBackupId(b.id)}>
                <PlatformBadge platform={b.platform} />
                <span className="backup-main">
                  <b>{b.deviceName}</b>
                  <small>
                    {b.deviceModel} · {b.platform === 'ios' ? 'iOS' : 'Android'} {b.osVersion} · {new Date(b.createdAt).toLocaleString()}
                  </small>
                </span>
                <span className="backup-tags">
                  {b.encrypted && (
                    <span className="pill">
                      <Icon name="lock" size={11} /> Encrypted
                    </span>
                  )}
                  {b.source === 'system' && <span className="pill">Finder / iTunes</span>}
                  {!b.complete && <span className="pill failed">Incomplete</span>}
                  <span className="muted">{formatBytes(b.sizeBytes)}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {device && device.state === 'ready' && backup && (
        <>
          {device.platform === 'android' ? (
            <Card title="What to restore" icon="restore">
              {restorable.length === 0 ? (
                <p className="muted">This backup has nothing that can be written back to a phone. Use Recover to extract its files instead.</p>
              ) : (
                <div className="check-grid">
                  {restorable.map((c) => (
                    <Check
                      key={c.id}
                      icon={groupIcon(c.id)}
                      label={c.label}
                      description={`${c.files.toLocaleString()} ${c.id === 'apps' ? 'APK files' : c.id === 'contacts' ? 'contacts' : 'files'} · ${formatBytes(c.bytes)}${c.id === 'apps' ? ' · confirm installs on the phone' : c.id === 'contacts' ? ' · confirm the import on the phone' : ''}`}
                      checked={cats.includes(c.id)}
                      disabled={busy}
                      onChange={(v) => setCats((l) => (v ? [...l, c.id] : l.filter((x) => x !== c.id)))}
                    />
                  ))}
                </div>
              )}
              <p className="muted small">Files that already exist on the phone and are newer are not overwritten. Call log and SMS exports stay on the computer: Android does not allow USB tools to write them.</p>
            </Card>
          ) : (
            <Card title="Restore options" icon="settings">
              <Banner kind="warn">
                <b>Restoring replaces what is on the iPhone now</b> with the content of this backup. Turn off <b>Find My</b> on the iPhone first (Settings ▸ your name ▸ Find My).
              </Banner>
              <div className="check-grid">
                <Check label="Restore settings" description="Wallpaper, home screen layout, preferences." checked={opts.settings} onChange={(v) => setOpts({ ...opts, settings: v })} disabled={busy} />
                <Check label="Restore system files" description="Needed for a full restore to a new or erased iPhone." checked={opts.system} onChange={(v) => setOpts({ ...opts, system: v })} disabled={busy} />
                <Check label="Restart when done" description="The iPhone finishes applying the backup after a restart." checked={opts.reboot} onChange={(v) => setOpts({ ...opts, reboot: v })} disabled={busy} />
                <Check label="Keep the backup untouched" description="Work on a temporary copy so the original backup can never change." checked={opts.copy} onChange={(v) => setOpts({ ...opts, copy: v })} disabled={busy} />
              </div>
              {backup.encrypted && (
                <label className="inline-label">
                  Backup password
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </label>
              )}
              <Check label={`I understand the content of ${device.name} will be replaced`} checked={confirmIos} onChange={setConfirmIos} disabled={busy} />
            </Card>
          )}
          <div className="cta-row">
            {job && <JobCard job={job} />}
            <button
              className="btn primary large"
              disabled={busy || (device.platform === 'android' ? !cats.length : !confirmIos || (backup.encrypted && !password)) || !backup.complete}
              onClick={start}
            >
              <Icon name="restore" size={17} /> {busy ? 'Restoring…' : `Restore to ${device.name}`}
            </button>
          </div>
          {!backup.complete && <Banner kind="error">This backup did not finish, so it can’t be restored. Use Recover to get files out of it.</Banner>}
        </>
      )}
    </div>
  );
}
