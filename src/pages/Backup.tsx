import { useState } from 'react';
import type { PageProps } from '../App';
import { api, navigate, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, JobCard, PageHeader, latestJob, pickDevice } from '../components/Common';
import { Icon } from '../components/Icon';
import { formatBytes } from '../../shared/export';
import type { AndroidCategoryId } from '../../shared/types';

/** A whole-phone Android backup: all of shared storage, the apps and what Android lets USB tools export. */
const ANDROID_WHOLE: AndroidCategoryId[] = ['storage', 'apps', 'contacts', 'calls', 'messages'];

const INCLUDED = {
  ios: ['Photos & videos', 'Messages & attachments', 'Contacts', 'Call history', 'Notes', 'App data', 'Settings & home screen', 'Voice Memos'],
  android: ['Photos & videos', 'Music & audio', 'Documents & downloads', 'WhatsApp media', 'Every other file in storage', 'Apps (APK)', 'Contacts', 'Call log & SMS*'],
};

export function Backup({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  const [encrypt, setEncrypt] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [label, setLabel] = useState('');
  const job = device ? latestJob(state, ['backup'], device.id) : undefined;
  const busy = job?.status === 'running';
  const pwOk = !encrypt || (pw.length >= 4 && pw === pw2);

  const start = () => {
    if (!device) return;
    run(
      api.startBackup({ deviceId: device.id, categories: ANDROID_WHOLE, encryptPassword: encrypt ? pw : undefined, label: label.trim() || undefined }),
      'Backup started',
    ).then(() => {
      setPw('');
      setPw2('');
    });
  };

  return (
    <div className="page">
      <PageHeader title="Backup" subtitle="Save a complete copy of a phone on this computer." />
      <Card title="Phone" icon="phone">
        <DevicePicker state={state} value={device?.id ?? null} onChange={select} />
      </Card>

      {device && <DeviceNotReady device={device} />}

      {device && device.state === 'ready' && (
        <>
          <Card title="Whole-phone backup" icon="backup">
            <p>
              {device.platform === 'ios'
                ? 'The same complete backup Finder and iTunes make. Restoring it puts everything back, on this iPhone or a new one.'
                : 'Everything in the phone’s storage plus your apps and contacts, kept as a normal folder you can restore or browse.'}
            </p>
            <div className="cat-tags">
              {INCLUDED[device.platform].map((x) => (
                <span key={x} className="cat-tag">
                  <Icon name="check" size={12} /> {x}
                </span>
              ))}
            </div>
            {device.platform === 'android' && (
              <p className="muted small">
                *Many phones block call log and SMS for USB tools. App data, passwords and settings aren’t included: Android only allows that for system backup tools (Google
                One, Smart Switch).
              </p>
            )}
            <Banner
              kind="info"
              action={
                <button className="btn" onClick={() => navigate('/transfer')}>
                  Open Transfer
                </button>
              }
            >
              Only want some photos, videos, music or contacts? Pick them in <b>Transfer</b>.
            </Banner>
          </Card>

          {device.platform === 'ios' && (
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
              {(encrypt || device.backupEncryption) && <Banner kind="info">Encrypted backups can be restored, but their contents can’t be browsed in Recover.</Banner>}
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
            <button className="btn primary large" disabled={busy || (device.platform === 'ios' && !pwOk)} onClick={start}>
              <Icon name="backup" size={17} /> {busy ? 'Backing up…' : `Back up ${device.name}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
