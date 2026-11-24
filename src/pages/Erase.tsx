import { useEffect, useState } from 'react';
import type { PageProps } from '../App';
import { api, navigate, run } from '../api';
import { Banner, Card, Check, DeviceNotReady, DevicePicker, JobCard, PageHeader, latestJob, pickDevice } from '../components/Common';
import { Icon } from '../components/Icon';
import { WIPEABLE_FOLDERS } from '../../shared/android';

const PHRASE = 'ERASE';

export function Erase({ state, selected, select }: PageProps) {
  const device = pickDevice(state, selected);
  const [folders, setFolders] = useState<string[]>(WIPEABLE_FOLDERS);
  const [apps, setApps] = useState(true);
  const [recovery, setRecovery] = useState(false);
  const [typed, setTyped] = useState('');
  const job = device ? latestJob(state, ['erase'], device.id) : undefined;
  const busy = job?.status === 'running';
  const lastBackup = device ? state.backups.find((b) => b.deviceId === device.id || b.deviceId === device.serial) : undefined;

  useEffect(() => setTyped(''), [device?.id]);

  const start = () => {
    if (!device) return;
    run(
      api.startErase({
        deviceId: device.id,
        confirmation: typed,
        android: device.platform === 'android' ? { wipeFolders: folders, uninstallApps: apps, rebootToRecovery: recovery } : undefined,
      }),
      'Erase started',
    ).then(() => setTyped(''));
  };

  const nothing = device?.platform === 'android' && !folders.length && !apps && !recovery;

  return (
    <div className="page">
      <PageHeader title="Erase" subtitle="Wipe a phone before selling, giving it away or sending it for repair." />
      <Card title="Phone" icon="phone">
        <DevicePicker state={state} value={device?.id ?? null} onChange={select} />
      </Card>
      {device && <DeviceNotReady device={device} />}

      {device && device.state === 'ready' && (
        <>
          {!lastBackup ? (
            <Banner
              kind="error"
              action={
                <button className="btn" onClick={() => navigate('/backup')}>
                  Back up first
                </button>
              }
            >
              <b>There is no backup of {device.name} in your library.</b> Erasing cannot be undone.
            </Banner>
          ) : (
            <Banner kind="ok">
              Latest backup of this phone: {new Date(lastBackup.createdAt).toLocaleString()}
              {!lastBackup.complete && ' (incomplete)'}.
            </Banner>
          )}

          {device.platform === 'ios' ? (
            <Card title="Erase an iPhone" icon="erase">
              <Banner kind="warn">
                Sign out of iCloud (Settings ▸ your name ▸ Sign Out) first. Otherwise the iPhone stays locked to your Apple Account (Activation Lock) after it is erased.
              </Banner>
              <h4>Option 1 · On the iPhone (recommended)</h4>
              <p>
                Open <b>Settings ▸ General ▸ Transfer or Reset iPhone ▸ Erase All Content and Settings</b>. The iPhone destroys its encryption keys, so the old data
                can’t be recovered by anyone, then restarts to the Hello screen. Apple doesn’t let computers start this erase over USB.
              </p>
              <h4>Option 2 · Factory restore from this computer</h4>
              <p>
                Use this if you can’t use the iPhone’s screen. MinTransfer restarts it into <b>recovery mode</b>; then{' '}
                {state.platform === 'darwin' ? 'Finder' : 'Apple Devices (or iTunes)'} shows a <b>Restore</b> button that erases the iPhone and installs a fresh copy of iOS.
              </p>
            </Card>
          ) : (
            <Card title="What to erase" icon="erase">
              <h4>Delete files in shared storage</h4>
              <div className="chip-grid">
                {WIPEABLE_FOLDERS.map((f) => (
                  <Check key={f} label={f} checked={folders.includes(f)} disabled={busy} onChange={(v) => setFolders((l) => (v ? [...l, f] : l.filter((x) => x !== f)))} />
                ))}
              </div>
              <h4>Apps</h4>
              <Check label="Uninstall every app you installed" description="System apps stay. App data is deleted with each app." checked={apps} disabled={busy} onChange={setApps} />
              <h4>Factory reset</h4>
              <Check
                label="Restart into recovery mode for a full factory reset"
                description="Android doesn’t let USB tools factory-reset a phone. MinTransfer restarts it into recovery, where you choose “Wipe data / factory reset” with the volume and power keys."
                checked={recovery}
                disabled={busy}
                onChange={setRecovery}
              />
              <Banner kind="info">
                For the most thorough wipe, also use <b>Settings ▸ System ▸ Reset options ▸ Erase all data</b> on the phone. Remove your Google account first so
                the next owner isn’t blocked by Factory Reset Protection.
              </Banner>
            </Card>
          )}

          <Card title="Confirm" icon="warning" className="danger-card">
            <label className="inline-label">
              Type <b className="mono">{PHRASE}</b> to {device.platform === 'ios' ? 'continue' : `erase ${device.name}`}
              <input value={typed} onChange={(e) => setTyped(e.target.value.toUpperCase())} placeholder={PHRASE} disabled={busy} spellCheck={false} />
            </label>
          </Card>

          <div className="cta-row">
            {job && <JobCard job={job} />}
            <button className="btn danger large" disabled={busy || typed !== PHRASE || nothing} onClick={start}>
              <Icon name="erase" size={17} /> {busy ? 'Working…' : device.platform === 'ios' ? `Put ${device.name} into recovery mode` : `Erase ${device.name}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
