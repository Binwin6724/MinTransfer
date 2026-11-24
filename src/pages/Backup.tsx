import { useState } from 'react';
import type { PageProps } from '../App';
import { api, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, JobCard, PageHeader, latestJob, pickDevice } from '../components/Common';
import { groupIcon, Icon } from '../components/Icon';
import { ANDROID_CATEGORIES } from '../../shared/android';
import { formatBytes } from '../../shared/export';
import type { AndroidCategoryId } from '../../shared/types';

const DEFAULT: AndroidCategoryId[] = ['photos', 'videos', 'music', 'documents', 'downloads', 'contacts', 'apps'];

export function Backup({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  const [cats, setCats] = useState<AndroidCategoryId[]>(DEFAULT);
  const [encrypt, setEncrypt] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [label, setLabel] = useState('');
  const job = device ? latestJob(state, ['backup'], device.id) : undefined;
  const busy = job?.status === 'running';
  const whole = cats.includes('storage');

  const toggle = (id: AndroidCategoryId, on: boolean) => setCats((c) => (on ? [...c, id] : c.filter((x) => x !== id)));
  const pwOk = !encrypt || (pw.length >= 4 && pw === pw2);

  const start = () => {
    if (!device) return;
    run(
      api.startBackup({ deviceId: device.id, categories: cats, encryptPassword: encrypt ? pw : undefined, label: label.trim() || undefined }),
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
            <Card title="What to back up" icon="backup" actions={<span className="muted small">{cats.length} selected</span>}>
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
            <Card title="Full iPhone backup" icon="backup">
              <p>
                MinTransfer makes the same complete backup Finder and iTunes make: photos, messages, contacts, call history, notes, app data, settings, home
                screen and more. Restoring it puts everything back, on this iPhone or a new one.
              </p>
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
            <button className="btn primary large" disabled={busy || !pwOk || (device.platform === 'android' && !cats.length)} onClick={start}>
              <Icon name="backup" size={17} /> {busy ? 'Backing up…' : `Back up ${device.name}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
