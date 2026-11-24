import { useState } from 'react';
import type { PageProps } from '../App';
import { api, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, JobCard, PageHeader, latestJob, pickDevice } from '../components/Common';
import { groupIcon, Icon } from '../components/Icon';
import { ANDROID_CATEGORIES } from '../../shared/android';
import { formatBytes } from '../../shared/export';
import { IOS_ITEMS } from '../../shared/ios';
import type { AndroidCategoryId, IosItemId } from '../../shared/types';

const DEFAULT: AndroidCategoryId[] = ['photos', 'videos', 'music', 'documents', 'downloads', 'contacts', 'apps'];
const IOS_DEFAULT: IosItemId[] = ['images', 'videos', 'contacts', 'messages', 'notes'];
const IOS_ICON: Record<IosItemId, string> = { images: 'photos', videos: 'videos', contacts: 'contacts', messages: 'messages', calls: 'calls', notes: 'notes', voicememos: 'voicememos', whatsapp: 'whatsapp' };

function SelectLinks({ onAll, onNone, disabled }: { onAll: () => void; onNone: () => void; disabled?: boolean }) {
  return (
    <span className="select-links">
      <button className="link" disabled={disabled} onClick={onAll}>
        Select all
      </button>
      <button className="link" disabled={disabled} onClick={onNone}>
        Clear
      </button>
    </span>
  );
}

export function Backup({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  const [cats, setCats] = useState<AndroidCategoryId[]>(DEFAULT);
  const [iosMode, setIosMode] = useState<'items' | 'full'>('items');
  const [items, setItems] = useState<IosItemId[]>(IOS_DEFAULT);
  const [keepFull, setKeepFull] = useState(false);
  const [encrypt, setEncrypt] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [label, setLabel] = useState('');
  const job = device ? latestJob(state, ['backup'], device.id) : undefined;
  const busy = job?.status === 'running';
  const whole = cats.includes('storage');

  const toggle = (id: AndroidCategoryId, on: boolean) => setCats((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  const toggleItem = (id: IosItemId, on: boolean) => setItems((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  const pwOk = !encrypt || (pw.length >= 4 && pw === pw2);
  // An encrypted iPhone backup can't be read, so "choose items" needs encryption off.
  const mode = device?.platform === 'ios' && device.backupEncryption ? 'full' : iosMode;
  const nothing = device?.platform === 'android' ? !cats.length : mode === 'items' && !items.length;

  const start = () => {
    if (!device) return;
    run(
      api.startBackup({
        deviceId: device.id,
        categories: cats,
        label: label.trim() || undefined,
        ...(device.platform === 'ios' && mode === 'items' ? { iosItems: items, keepFull } : { encryptPassword: encrypt ? pw : undefined }),
      }),
      'Backup started',
    ).then(() => {
      setPw('');
      setPw2('');
    });
  };

  return (
    <div className="page">
      <PageHeader title="Backup" subtitle="Copy a phone’s content to this computer." />
      <Card title="Phone" icon="phone">
        <DevicePicker state={state} value={device?.id ?? null} onChange={select} />
      </Card>

      {device && <DeviceNotReady device={device} />}

      {device && device.state === 'ready' && (
        <>
          {device.platform === 'android' ? (
            <Card
              title="What to back up"
              icon="backup"
              actions={
                <>
                  <span className="muted small">{cats.length} selected</span>
                  <SelectLinks disabled={busy} onAll={() => setCats(ANDROID_CATEGORIES.filter((c) => c.kind !== 'all').map((c) => c.id))} onNone={() => setCats([])} />
                </>
              }
            >
              <div className="check-grid">
                {ANDROID_CATEGORIES.map((c) => (
                  <Check
                    key={c.id}
                    icon={groupIcon(c.id)}
                    label={c.label}
                    description={c.description}
                    checked={cats.includes(c.id) || (whole && c.kind === 'files')}
                    disabled={busy || (whole && c.kind === 'files')}
                    onChange={(v) => toggle(c.id, v)}
                  />
                ))}
              </div>
              <p className="muted small">
                App data, passwords and settings are not included: Android only allows that for system backup tools (Google One, Smart Switch). Photos already in
                Google Photos are only copied if they are stored on the phone.
              </p>
            </Card>
          ) : (
            <>
              <Card
                title="What to back up"
                icon="backup"
                actions={
                  <div className="segmented">
                    <button className={mode === 'items' ? 'active' : ''} disabled={busy || !!device.backupEncryption} onClick={() => setIosMode('items')}>
                      Choose items
                    </button>
                    <button className={mode === 'full' ? 'active' : ''} disabled={busy} onClick={() => setIosMode('full')}>
                      Full backup
                    </button>
                  </div>
                }
              >
                {mode === 'items' ? (
                  <>
                    <div className="row-between">
                      <p className="muted small">Saved as ordinary files you can open on any computer: photos, a contacts .vcf, message transcripts and more.</p>
                      <span className="muted small nowrap">
                        {items.length} selected
                        <SelectLinks disabled={busy} onAll={() => setItems(IOS_ITEMS.map((i) => i.id))} onNone={() => setItems([])} />
                      </span>
                    </div>
                    <div className="check-grid">
                      {IOS_ITEMS.map((c) => (
                        <Check
                          key={c.id}
                          icon={groupIcon(IOS_ICON[c.id])}
                          label={c.label}
                          description={c.description}
                          checked={items.includes(c.id)}
                          disabled={busy}
                          onChange={(v) => toggleItem(c.id, v)}
                        />
                      ))}
                      <Check icon={groupIcon('music')} label="Music" description="Not possible on iPhone: Apple leaves music out of backups. It comes back from Apple Music or your computer’s Music library." checked={false} disabled onChange={() => {}} />
                    </div>
                    <div className="option-row">
                      <Check
                        icon="restore"
                        label="Also keep a full backup"
                        description="Keeps a complete copy you can restore onto an iPhone later. Takes as much space as the iPhone’s data."
                        checked={keepFull}
                        disabled={busy}
                        onChange={setKeepFull}
                      />
                    </div>
                    <p className="muted small">
                      iPhones only let computers read everything at once, so MinTransfer reads the whole iPhone first, saves the items you chose and then deletes the rest.
                      The backup drive needs room for the whole iPhone while it runs. Photos kept only in iCloud aren’t included.
                    </p>
                  </>
                ) : (
                  <p>
                    The same complete backup Finder and iTunes make: photos, messages, contacts, call history, notes, app data, settings, home screen and more.
                    Restoring it puts everything back, on this iPhone or a new one. Its contents can be browsed and saved later in Recover.
                  </p>
                )}
                {device.backupEncryption && (
                  <Banner kind="info">
                    Backup encryption is on for this iPhone, so only a full backup is possible. To choose items, turn encryption off in Settings ▸ iPhone backup
                    encryption.
                  </Banner>
                )}
              </Card>
              {mode === 'full' && (
            <Card title="Encryption" icon="lock">
              <div className="option-row">
                <Check
                  label="Encrypt this backup"
                  description={
                    device.backupEncryption
                      ? 'Encryption is already on for this iPhone; the backup will use its existing password.'
                      : 'Also saves passwords, Health, Wi-Fi and website data. You will need the password to restore it.'
                  }
                  checked={encrypt || !!device.backupEncryption}
                  disabled={busy || !!device.backupEncryption}
                  onChange={setEncrypt}
                  icon="lock"
                />
              </div>
              {encrypt && !device.backupEncryption && (
                <div className="form-grid">
                  <label>
                    Backup password
                    <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
                  </label>
                  <label>
                    Confirm password
                    <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
                  </label>
                  {pw2 && pw !== pw2 && <span className="error-text small">The passwords don’t match.</span>}
                  <span className="muted small">There is no way to recover a forgotten backup password. MinTransfer never stores it.</span>
                </div>
              )}
              {(encrypt || device.backupEncryption) && (
                <Banner kind="info">Encrypted backups can be restored, but their contents can’t be browsed in Recover.</Banner>
              )}
            </Card>
              )}
            </>
          )}

          <Card title="Destination" icon="folder">
            <div className="dest-row">
              <div>
                <div className="mono">{state.settings.backupDir}</div>
                <div className="muted small">
                  Phone uses {device.storageTotal && device.storageFree != null ? formatBytes(device.storageTotal - device.storageFree) : 'unknown space'}. Make sure
                  this drive has room.
                </div>
              </div>
              <button
                className="btn"
                onClick={async () => {
                  const dir = await run(api.chooseFolder('Choose where to keep backups', state.settings.backupDir));
                  if (dir) run(api.setSettings({ backupDir: dir }));
                }}
              >
                Change…
              </button>
            </div>
            <label className="inline-label">
              Note (optional)
              <input value={label} placeholder="e.g. Before upgrading" onChange={(e) => setLabel(e.target.value)} maxLength={80} />
            </label>
          </Card>

          <div className="cta-row">
            {job && <JobCard job={job} />}
            <button className="btn primary large" disabled={busy || (mode === 'full' && !pwOk) || nothing} onClick={start}>
              <Icon name="backup" size={17} /> {busy ? 'Backing up…' : `Back up ${device.name}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
