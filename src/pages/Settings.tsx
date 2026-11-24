import type { PageProps } from '../App';
import { api, run } from '../api';
import { Card, JobCard, PageHeader, Toggle, latestJob } from '../components/Common';
import { Icon } from '../components/Icon';
import type { ThemePref } from '../../shared/types';

const TERMS = 'https://developer.android.com/studio/releases/platform-tools';
const LIBIMOBILEDEVICE = 'https://libimobiledevice.org/';

export function Settings({ state }: PageProps) {
  const s = state.settings;
  const toolJob = latestJob(state, ['tools']);
  return (
    <div className="page">
      <PageHeader title="Settings" />

      <Card title="Helper tools" icon="usb" actions={<button className="btn small" onClick={() => run(api.refreshTools(), 'Tools re-checked')}>Re-check</button>}>
        {state.tools.map((t) => (
          <div key={t.id} className="tool-row">
            <span className={`dot ${t.found ? 'ok' : 'missing'}`} />
            <div className="tool-text">
              <b>{t.label}</b>
              {t.found ? (
                <>
                  <small className="mono">
                    {t.version ? `v${t.version} · ` : ''}
                    {t.source === 'bundled' ? 'included with MinTransfer' : t.source} · {t.path}
                  </small>
                  {t.warning && <small className="warn-text">{t.warning}</small>}
                </>
              ) : (
                <small>
                  {t.missing.length > 0 && t.id === 'libimobiledevice' && `Missing: ${t.missing.join(', ')}. `}
                  {t.installHint}
                </small>
              )}
            </div>
            {t.id === 'adb' && (
              <div className="tool-actions">
                <button className="btn small" disabled={toolJob?.status === 'running'} onClick={() => run(api.downloadAdb(), 'Downloading Platform-Tools…')}>
                  <Icon name="download" size={14} /> {t.found ? 'Update' : 'Download'}
                </button>
                <a className="small" href={TERMS} target="_blank" rel="noreferrer">
                  License
                </a>
              </div>
            )}
            {t.id === 'libimobiledevice' && (
              <div className="tool-actions">
                {t.warning && state.platform === 'win32' && (
                  <button className="btn small" onClick={() => run(api.openAppleDevicesStore())}>
                    Get Apple Devices
                  </button>
                )}
                <a className="btn small" href={LIBIMOBILEDEVICE} target="_blank" rel="noreferrer">
                  Website <Icon name="external" size={12} />
                </a>
              </div>
            )}
          </div>
        ))}
        <div className="setting-row">
          <div>
            <b>Set up Android tools automatically</b>
            <small>When Platform-Tools are missing, MinTransfer downloads them from Google on launch (you accepted Google’s Android SDK license in the installer).</small>
          </div>
          <Toggle on={s.autoSetupAndroid} onChange={(v) => run(api.setSettings({ autoSetupAndroid: v }))} />
        </div>
        {toolJob && <JobCard job={toolJob} compact />}
        <div className="setting-row">
          <div>
            <b>Custom tools folder</b>
            <small>{s.customToolDir || 'Not set. Use this for a portable libimobiledevice build on Windows or your own adb.'}</small>
          </div>
          <div className="row-actions">
            {s.customToolDir && (
              <button className="btn small" onClick={() => run(api.setSettings({ customToolDir: '' }))}>
                Clear
              </button>
            )}
            <button
              className="btn small"
              onClick={async () => {
                const dir = await run(api.chooseFolder('Choose the folder containing adb or idevicebackup2'));
                if (dir) run(api.setSettings({ customToolDir: dir }));
              }}
            >
              Choose…
            </button>
          </div>
        </div>
      </Card>

      <Card title="Backups" icon="library">
        <div className="setting-row">
          <div>
            <b>Backup folder</b>
            <small className="mono">{s.backupDir}</small>
          </div>
          <button
            className="btn small"
            onClick={async () => {
              const dir = await run(api.chooseFolder('Choose where to keep backups', s.backupDir));
              if (dir) run(api.setSettings({ backupDir: dir }));
            }}
          >
            Change…
          </button>
        </div>
        <div className="setting-row">
          <div>
            <b>Show Finder / iTunes iPhone backups</b>
            <small>Lists backups made by Apple’s tools so you can browse and restore them. They are never modified.</small>
          </div>
          <Toggle on={s.showSystemBackups} onChange={(v) => run(api.setSettings({ showSystemBackups: v }))} />
        </div>
      </Card>

      <Card title="Appearance" icon="settings">
        <div className="setting-row">
          <div>
            <b>Theme</b>
          </div>
          <div className="segmented">
            {(['system', 'dark', 'light'] as ThemePref[]).map((t) => (
              <button key={t} className={s.theme === t ? 'active' : ''} onClick={() => run(api.setSettings({ theme: t }))}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </Card>

      <Card title="Privacy" icon="shield">
        <ul className="plain">
          <li>Everything stays on this computer. MinTransfer has no account, no cloud and no analytics.</li>
          <li>The only network request is the optional Platform-Tools download from Google.</li>
          <li>Backup passwords are passed straight to the iPhone and never saved.</li>
        </ul>
        <button className="btn small" onClick={() => run(api.openLogs())}>
          <Icon name="logs" size={14} /> Open logs
        </button>
      </Card>
    </div>
  );
}
