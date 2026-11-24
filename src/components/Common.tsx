import { ReactNode } from 'react';
import { api, navigate, run } from '../api';
import { Icon } from './Icon';
import { formatBytes, formatDuration } from '../../shared/export';
import type { AppState, Job, PhoneDevice } from '../../shared/types';

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {children && <div className="header-actions">{children}</div>}
    </header>
  );
}

export function Card({ title, icon, actions, children, className }: { title?: string; icon?: string; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="card-title">
            {icon && <Icon name={icon} size={16} />}
            <span>{title}</span>
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Banner({ kind, icon, children, action }: { kind: 'info' | 'warn' | 'error' | 'ok'; icon?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner ${kind}`}>
      <Icon name={icon ?? (kind === 'error' || kind === 'warn' ? 'warning' : kind === 'ok' ? 'check' : 'info')} />
      <div className="banner-body">{children}</div>
      {action}
    </div>
  );
}

export function ProgressBar({ value, danger }: { value: number | null; danger?: boolean }) {
  return (
    <div className={`progress ${value == null ? 'indeterminate' : ''} ${danger ? 'danger' : ''}`}>
      <div className="progress-fill" style={value == null ? undefined : { width: `${Math.round(value * 100)}%` }} />
    </div>
  );
}

export function Check({ checked, onChange, label, description, disabled, icon }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean; icon?: string }) {
  return (
    <label className={`check ${checked ? 'on' : ''} ${disabled ? 'disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="check-box">{checked && <Icon name="check" size={12} strokeWidth={3} />}</span>
      {icon && <Icon name={icon} size={18} className="check-icon" />}
      <span className="check-text">
        <b>{label}</b>
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return <button className={`toggle ${on ? 'on' : ''}`} disabled={disabled} onClick={() => onChange(!on)} role="switch" aria-checked={on} />;
}

export function StorageBar({ total, free }: { total?: number; free?: number }) {
  if (!total || free == null) return <div className="muted small">Storage: unknown</div>;
  const used = total - free;
  const pct = Math.max(0, Math.min(1, used / total));
  return (
    <div className="storage">
      <div className="storage-bar">
        <div style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="storage-text">
        <span>{formatBytes(used)} used</span>
        <span>{formatBytes(free)} free of {formatBytes(total)}</span>
      </div>
    </div>
  );
}

export function deviceIcon(d: PhoneDevice) {
  return d.osName === 'iPadOS' ? 'tablet' : 'phone';
}

export function PlatformBadge({ platform }: { platform: 'ios' | 'android' }) {
  return <span className={`badge ${platform}`}>{platform === 'ios' ? 'iOS' : 'Android'}</span>;
}

export function stateLabel(d: PhoneDevice): string {
  switch (d.state) {
    case 'ready':
      return 'Connected';
    case 'unauthorized':
      return 'Waiting for permission';
    case 'untrusted':
      return 'Not trusted yet';
    case 'locked':
      return 'Locked';
    case 'offline':
      return 'Offline';
    case 'recovery':
      return 'Recovery mode';
    default:
      return 'Unknown';
  }
}

/** Device chooser used by Backup / Restore / Recover / Erase. */
export function DevicePicker({ state, value, onChange, filter }: { state: AppState; value: string | null; onChange: (id: string) => void; filter?: (d: PhoneDevice) => boolean }) {
  const list = state.devices.filter((d) => !filter || filter(d));
  if (!list.length) {
    return (
      <div className="empty small">
        <Icon name="usb" size={28} />
        <div>
          <b>No phone connected</b>
          <p>Connect an iPhone or Android phone with a USB cable.</p>
        </div>
        <button className="btn" onClick={() => navigate('/')}>
          Connection help
        </button>
      </div>
    );
  }
  return (
    <div className="device-picker">
      {list.map((d) => (
        <button key={d.id} className={`device-chip ${value === d.id ? 'active' : ''} ${d.state !== 'ready' ? 'not-ready' : ''}`} onClick={() => onChange(d.id)}>
          <Icon name={deviceIcon(d)} size={22} />
          <span className="device-chip-text">
            <b>{d.name}</b>
            <small>
              {d.model} · {d.osName} {d.osVersion} {d.state !== 'ready' && `· ${stateLabel(d)}`}
            </small>
          </span>
          <PlatformBadge platform={d.platform} />
        </button>
      ))}
    </div>
  );
}

/** Picks a sensible device automatically: the selected one, else the first ready one. */
export function pickDevice(state: AppState, selected: string | null, filter?: (d: PhoneDevice) => boolean): PhoneDevice | null {
  const list = state.devices.filter((d) => !filter || filter(d));
  return list.find((d) => d.id === selected) ?? list.find((d) => d.state === 'ready') ?? list[0] ?? null;
}

export function DeviceNotReady({ device }: { device: PhoneDevice }) {
  if (device.state === 'ready') return null;
  return (
    <Banner
      kind="warn"
      action={
        device.platform === 'ios' && device.state !== 'offline' ? (
          <button className="btn" onClick={() => run(api.pairIos(device.id).then((m) => m), 'Trust request sent to the iPhone')}>
            Ask to trust
          </button>
        ) : undefined
      }
    >
      <b>{stateLabel(device)}.</b> {device.stateDetail}
    </Banner>
  );
}

export function JobCard({ job, compact }: { job: Job; compact?: boolean }) {
  const running = job.status === 'running';
  const elapsed = (job.endedAt ?? Date.now()) - job.startedAt;
  return (
    <div className={`job ${job.status}`}>
      <div className="job-head">
        <div className="job-title">
          <Icon name={job.kind === 'backup' ? 'backup' : job.kind === 'restore' ? 'restore' : job.kind === 'erase' ? 'erase' : job.kind === 'tools' ? 'download' : 'recover'} size={16} />
          <b>{job.title}</b>
          <span className={`pill ${job.status}`}>{job.status === 'running' ? (job.progress != null ? `${Math.round(job.progress * 100)}%` : 'Working') : job.status === 'done' ? 'Done' : job.status === 'failed' ? 'Failed' : 'Cancelled'}</span>
        </div>
        <div className="job-actions">
          <span className="muted small">{formatDuration(elapsed)}</span>
          {running && (
            <button className="btn small" onClick={() => run(api.cancelJob(job.id))}>
              Cancel
            </button>
          )}
          {job.resultPath && job.status === 'done' && (
            <button className="btn small" onClick={() => run(api.reveal(job.resultPath!))}>
              <Icon name="folder" size={14} /> Show
            </button>
          )}
        </div>
      </div>
      {running && <ProgressBar value={job.progress} danger={job.kind === 'erase'} />}
      <div className={`job-detail ${job.status === 'failed' ? 'error-text' : ''}`}>{job.detail}</div>
      {!compact && job.log.length > 0 && (
        <details className="job-log">
          <summary>Log ({job.log.length})</summary>
          <pre>{job.log.slice(-200).join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

/** Latest job of a kind for a device (to show inline on the page that started it). */
export function latestJob(state: AppState, kinds: Job['kind'][], deviceId?: string | null): Job | undefined {
  return state.jobs.find((j) => kinds.includes(j.kind) && (!deviceId || j.deviceId === deviceId || !j.deviceId));
}

export function EmptyState({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={34} />
      <div>
        <b>{title}</b>
        {children && <div className="empty-text">{children}</div>}
      </div>
      {action}
    </div>
  );
}
