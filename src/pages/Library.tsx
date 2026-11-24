import type { PageProps } from '../App';
import { api, navigate, run } from '../api';
import { Banner, Card, EmptyState, PageHeader, PlatformBadge } from '../components/Common';
import { groupIcon, Icon } from '../components/Icon';
import { formatBytes } from '../../shared/export';

export function LibraryPage({ state }: PageProps) {
  const total = state.backups.filter((b) => b.source === 'mintransfer').reduce((n, b) => n + b.sizeBytes, 0);
  const hasSystem = state.backups.some((b) => b.source === 'system');
  return (
    <div className="page">
      <PageHeader title="Backups" subtitle={`${state.backups.length} backup${state.backups.length === 1 ? '' : 's'} · ${formatBytes(total)} in ${state.settings.backupDir}`}>
        <button className="btn" onClick={() => run(api.refreshLibrary())}>
          <Icon name="refresh" size={15} /> Refresh
        </button>
        <button
          className="btn"
          onClick={async () => {
            const dir = await run(api.chooseFolder('Choose the folder that holds your MinTransfer backups', state.settings.backupDir));
            if (dir) run(api.setSettings({ backupDir: dir }));
          }}
        >
          <Icon name="folder" size={15} /> Change folder…
        </button>
      </PageHeader>

      {state.platform === 'darwin' && state.settings.showSystemBackups && !hasSystem && (
        <Banner
          kind="info"
          action={
            <button className="btn" onClick={() => run(api.openFullDiskAccess())}>
              Open Privacy settings
            </button>
          }
        >
          To list iPhone backups made by Finder, allow MinTransfer under <b>Full Disk Access</b> (macOS protects that folder), then press Refresh.
        </Banner>
      )}

      {state.backups.length === 0 ? (
        <EmptyState
          icon="library"
          title="No backups yet"
          action={
            <button className="btn primary" onClick={() => navigate('/backup')}>
              Make a backup
            </button>
          }
        >
          Backups you make appear here. Each one is a normal folder you can copy to an external drive.
        </EmptyState>
      ) : (
        <div className="library">
          {state.backups.map((b) => (
            <Card key={b.id} className="backup-card">
              <div className="backup-card-head">
                <div className={`device-art small ${b.platform}`}>
                  <Icon name="phone" size={24} strokeWidth={1.5} />
                </div>
                <div className="backup-main">
                  <div className="device-name">
                    <h3>{b.deviceName}</h3>
                    <PlatformBadge platform={b.platform} />
                    {b.encrypted && (
                      <span className="pill">
                        <Icon name="lock" size={11} /> Encrypted
                      </span>
                    )}
                    {b.source === 'system' && <span className="pill">Finder / iTunes</span>}
                    {!b.complete && <span className="pill failed">Incomplete</span>}
                  </div>
                  <div className="muted">
                    {b.deviceModel} · {b.platform === 'ios' ? 'iOS' : 'Android'} {b.osVersion} · {new Date(b.createdAt).toLocaleString()} · {formatBytes(b.sizeBytes)}
                  </div>
                  {b.note && <div className="note">“{b.note}”</div>}
                </div>
                <div className="card-actions">
                  <button
                    className="btn small"
                    onClick={() => {
                      sessionStorage.setItem('mt.recoverBackup', b.id);
                      navigate('/recover');
                    }}
                  >
                    <Icon name="recover" size={14} /> Browse
                  </button>
                  <button className="btn small" onClick={() => run(api.revealBackup(b.id))}>
                    <Icon name="folder" size={14} /> Show
                  </button>
                  {b.source === 'mintransfer' && (
                    <button className="btn small danger-outline" onClick={() => run(api.deleteBackup(b.id))}>
                      <Icon name="trash" size={14} />
                    </button>
                  )}
                </div>
              </div>
              {b.categories.length > 0 && b.platform === 'android' && (
                <div className="cat-tags">
                  {b.categories.map((c) => (
                    <span key={c.id} className={`cat-tag ${c.files ? '' : 'empty'}`} title={c.warning}>
                      <Icon name={groupIcon(c.id)} size={13} /> {c.label} · {c.files.toLocaleString()}
                      {c.warning && <Icon name="warning" size={12} />}
                    </span>
                  ))}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
