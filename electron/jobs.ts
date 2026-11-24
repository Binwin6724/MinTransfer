// Long-running operations (backup, restore, erase…) with progress, logs and cancellation.
import { randomUUID } from 'node:crypto';
import { CancelledError } from './exec';
import { log } from './logger';
import { explainDiskError } from '../shared/export';
import type { Job, JobKind } from '../shared/types';

const MAX_LOG = 400;
const MAX_JOBS = 40;

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number | null, detail?: string): void;
  /** Updates the status line without changing progress. */
  detail(text: string): void;
  log(line: string): void;
  /** Throws if the job was cancelled. */
  check(): void;
}

export class JobRunner {
  readonly jobs: Job[] = [];
  private controllers = new Map<string, AbortController>();
  private emitTimer: NodeJS.Timeout | null = null;

  constructor(private readonly onChange: () => void) {}

  busyFor(deviceId: string): Job | undefined {
    return this.jobs.find((j) => j.deviceId === deviceId && j.status === 'running');
  }

  start(kind: JobKind, title: string, deviceId: string | undefined, fn: (ctx: JobContext) => Promise<string | void>): Job {
    if (deviceId) {
      const busy = this.busyFor(deviceId);
      if (busy) throw new Error(`This phone is busy with "${busy.title}". Wait for it to finish or cancel it first.`);
    }
    const job: Job = { id: randomUUID(), kind, title, deviceId, status: 'running', progress: null, detail: 'Starting…', log: [], startedAt: Date.now() };
    const ctrl = new AbortController();
    this.controllers.set(job.id, ctrl);
    this.jobs.unshift(job);
    while (this.jobs.length > MAX_JOBS) {
      const idx = this.jobs.findLastIndex((j) => j.status !== 'running');
      if (idx < 0) break;
      this.jobs.splice(idx, 1);
    }
    const ctx: JobContext = {
      signal: ctrl.signal,
      progress: (fraction, detail) => {
        job.progress = fraction == null ? null : Math.max(0, Math.min(1, fraction));
        if (detail) job.detail = detail;
        this.emitSoon();
      },
      detail: (text) => {
        job.detail = text;
        this.emitSoon();
      },
      log: (line) => {
        job.log.push(line);
        if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
        this.emitSoon();
      },
      check: () => {
        if (ctrl.signal.aborted) throw new CancelledError();
      },
    };
    log.info('job start', { kind, title });
    this.emit();
    fn(ctx)
      .then((result) => {
        job.status = 'done';
        job.progress = 1;
        if (result) job.resultPath = result;
        if (job.detail === 'Starting…' || !job.detail) job.detail = 'Finished';
      })
      .catch((err: unknown) => {
        if (err instanceof CancelledError || ctrl.signal.aborted) {
          job.status = 'cancelled';
          job.detail = 'Cancelled';
        } else {
          job.status = 'failed';
          job.error = explainDiskError(err instanceof Error ? err.message : String(err));
          job.detail = job.error;
          log.error('job failed', { kind, title, error: job.error });
        }
      })
      .finally(() => {
        job.endedAt = Date.now();
        this.controllers.delete(job.id);
        log.info('job end', { kind, title, status: job.status });
        this.emit();
      });
    return job;
  }

  cancel(id: string) {
    this.controllers.get(id)?.abort();
  }

  clearFinished() {
    for (let i = this.jobs.length - 1; i >= 0; i--) if (this.jobs[i].status !== 'running') this.jobs.splice(i, 1);
    this.emit();
  }

  cancelAll() {
    for (const c of this.controllers.values()) c.abort();
  }

  get running() {
    return this.jobs.filter((j) => j.status === 'running');
  }

  private emitSoon() {
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.onChange();
    }, 150);
  }

  private emit() {
    if (this.emitTimer) {
      clearTimeout(this.emitTimer);
      this.emitTimer = null;
    }
    this.onChange();
  }
}
