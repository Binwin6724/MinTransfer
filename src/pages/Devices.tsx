import type { PageProps } from '../App';
import { api, navigate, run } from '../api';
import { Banner, Card, DeviceNotReady, JobCard, PageHeader, PlatformBadge, StorageBar, deviceIcon, stateLabel } from '../components/Common';
import { Icon } from '../components/Icon';
import { formatBytes } from '../../shared/export';
import type { PhoneDevice } from '../../shared/types';

export function Devices({ state, select }: PageProps) {
  const adb = state.tools.find((t) => t.id === 'adb');
  const imd = state.tools.find((t) => t.id === 'libimobiledevice');
  const running = state.jobs.filter((j) => j.status === 'running');
  const settingUp = running.some((j) => j.kind === 'tools');
  const go = (d: PhoneDevice, route: string) => {
    select(d.id);
    navigate(route);
  };

  return (
    <div className="page">
      <PageHeader title="Devices" subtitle="Connect a phone with a USB cable to back it up, restore it, recover files or erase it.">
        <button className="btn" onClick={() => run(api.refreshDevices())}>
          <Icon name="refresh" size={15} /> Refresh
        </button>
      </PageHeader>

      {imd?.found && imd.warning && (
        <Banner
          kind="warn"
          action={
            <button className="btn" onClick={() => run(api.openAppleDevicesStore())}>
              Get Apple Devices
            </button>
          }
        >
          <b>iPhones need Apple’s USB driver.</b> {imd.warning}
        </Banner>
      )}

      {!settingUp && (!adb?.found || !imd?.found) && (
        <Banner
          kind="info"
          action={
            <button className="btn" onClick={() => navigate('/settings')}>
              Set up tools
            </button>
          }
        >
          {!adb?.found && !imd?.found ? (
            <>
              <b>Helper tools are missing.</b> Android phones need Google’s Platform-Tools and iPhones need libimobiledevice.
            </>
          ) : !adb?.found ? (
            <>
              <b>Android tools are missing.</b> MinTransfer downloads Google’s Platform-Tools automatically when you’re online, or from Settings.
            </>
          ) : (
            <>
              <b>iPhone tools are missing.</b> {imd?.installHint}
            </>
          )}
        </Banner>
      )}

      {running.map((j) => (
        <JobCard key={j.id} job={j} compact />
      ))}

      {state.devices.length === 0 ? (
        <div className="grid two">
          <Card title="Connect an Android phone" icon="phone">
            <ol className="steps">
              <li>
                Open <b>Settings ▸ About phone</b> and tap <b>Build number</b> seven times to unlock Developer options.
              </li>
              <li>
                In <b>Settings ▸ System ▸ Developer options</b>, turn on <b>USB debugging</b>.
              </li>
              <li>Connect the phone with a USB cable that supports data.</li>
              <li>
                Unlock the phone and tap <b>Allow</b> on “Allow USB debugging?”. Tick “Always allow from this computer”.
              </li>
            </ol>
            {state.platform === 'win32' && <p className="muted small">Windows: some phones (Samsung, Xiaomi…) need their maker’s USB driver.</p>}
          </Card>
          <Card title="Connect an iPhone or iPad" icon="phone">
            <ol className="steps">
              <li>Connect the iPhone with its USB / Lightning cable.</li>
              <li>
                Unlock it and tap <b>Trust</b> on “Trust This Computer?”, then enter the passcode.
              </li>
              {state.platform === 'win32' && (
                <li>
                  On Windows, install <b>Apple Devices</b> (or iTunes) from the Microsoft Store first. It provides the USB driver.
                </li>
              )}
              <li>Keep the iPhone unlocked while a backup or restore starts.</li>
            </ol>
          </Card>
        </div>
      ) : (
        <div className="device-grid">
          {state.devices.map((d) => (
            <section key={d.id} className={`device-card ${d.state}`}>
              <div className="device-top">
                <div className={`device-art ${d.platform}`}>
                  <Icon name={deviceIcon(d)} size={40} strokeWidth={1.4} />
                </div>
                <div className="device-meta">
                  <div className="device-name">
                    <h3>{d.name}</h3>
                    <PlatformBadge platform={d.platform} />
                  </div>
                  <div className="muted">
                    {d.model}
                    {d.osVersion && ` · ${d.osName} ${d.osVersion}`}
                  </div>
                  <div className="device-status">
                    <span className={`dot ${d.state === 'ready' ? 'ok' : 'warn'}`} />
                    {stateLabel(d)}
                    <span className="muted">
                      <Icon name={d.wireless ? 'wifi' : 'usb'} size={13} /> {d.wireless ? 'Wi-Fi' : 'USB'}
                    </span>
                    {d.battery != null && (
                      <span className="muted">
                        <Icon name={d.charging ? 'bolt' : 'battery'} size={13} /> {d.battery}%
                      </span>
                    )}
                  </div>
                </div>
              </div>
              <DeviceNotReady device={d} />
              {d.state === 'ready' && (
                <>
                  <StorageBar total={d.storageTotal} free={d.storageFree} />
                  <dl className="facts">
                    {d.serial && (
                      <>
                        <dt>Serial</dt>
                        <dd>{d.serial}</dd>
                      </>
                    )}
                    <dt>{d.platform === 'ios' ? 'UDID' : 'adb serial'}</dt>
                    <dd className="mono">{d.id}</dd>
                    {d.platform === 'ios' && (
                      <>
                        <dt>Backup encryption</dt>
                        <dd>{d.backupEncryption ? 'On (password protected)' : 'Off'}</dd>
                      </>
                    )}
                    {d.storageTotal != null && (
                      <>
                        <dt>Capacity</dt>
                        <dd>{formatBytes(d.storageTotal)}</dd>
                      </>
                    )}
                  </dl>
                  <div className="device-actions">
                    <button className="btn primary" onClick={() => go(d, '/backup')}>
                      <Icon name="backup" size={15} /> Back up
                    </button>
                    <button className="btn" onClick={() => go(d, '/restore')}>
                      <Icon name="restore" size={15} /> Restore
                    </button>
                    <button className="btn" onClick={() => go(d, '/recover')}>
                      <Icon name="recover" size={15} /> Recover
                    </button>
                    <button className="btn danger-outline" onClick={() => go(d, '/erase')}>
                      <Icon name="erase" size={15} /> Erase
                    </button>
                  </div>
                </>
              )}
            </section>
          ))}
        </div>
      )}

      <Card title="Recent backups" icon="library" actions={<a href="#/library">All backups</a>}>
        {state.backups.length === 0 ? (
          <p className="muted">No backups yet. Back up a phone to see it here.</p>
        ) : (
          <div className="mini-list">
            {state.backups.slice(0, 4).map((b) => (
              <div key={b.id} className="mini-row">
                <PlatformBadge platform={b.platform} />
                <b>{b.deviceName}</b>
                <span className="muted">{new Date(b.createdAt).toLocaleString()}</span>
                <span className="muted">{formatBytes(b.sizeBytes)}</span>
                {!b.complete && <span className="pill failed">Incomplete</span>}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
