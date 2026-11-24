// Running the helper tools (adb, libimobiledevice) without a shell.
// Arguments are always passed as an array, so device names and paths can never be interpreted by a shell.
import { spawn, ChildProcess } from 'node:child_process';
import path from 'node:path';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout + stderr, for error detection. */
  all: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Called for each output line (stdout and stderr, \r and \n both split lines). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void;
  /** Maximum captured output; older output is dropped. */
  maxBuffer?: number;
  input?: string;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

export function toolEnv(binPath: string): NodeJS.ProcessEnv {
  // libimobiledevice on Windows ships its DLLs next to the executables; adb finds its own.
  const dir = path.dirname(binPath);
  const sep = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: `${dir}${sep}${process.env.PATH ?? ''}` };
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError());
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { env: opts.env ?? toolEnv(bin), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(err);
    }
    const max = opts.maxBuffer ?? 32 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let all = '';
    let settled = false;
    const partial = { stdout: '', stderr: '' };

    const feed = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
      const s = chunk.toString('utf8');
      if (stream === 'stdout') stdout = (stdout + s).slice(-max);
      else stderr = (stderr + s).slice(-max);
      all = (all + s).slice(-max);
      if (opts.onLine) {
        const text = partial[stream] + s;
        const parts = text.split(/\r\n|\r|\n/);
        partial[stream] = parts.pop() ?? '';
        for (const p of parts) if (p.trim()) opts.onLine(p, stream);
      }
    };
    child.stdout?.on('data', (c: Buffer) => feed('stdout', c));
    child.stderr?.on('data', (c: Buffer) => feed('stderr', c));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          if (settled) return;
          kill(child);
          settled = true;
          reject(new Error(`${path.basename(bin)} timed out after ${Math.round(opts.timeoutMs! / 1000)}s`));
        }, opts.timeoutMs)
      : null;
    const onAbort = () => {
      if (settled) return;
      kill(child);
      settled = true;
      reject(new CancelledError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (opts.onLine) for (const k of ['stdout', 'stderr'] as const) if (partial[k].trim()) opts.onLine(partial[k], k);
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr, all });
    });
    // If the tool exits (or is cancelled) before reading all its input, writing to it fails with
    // EPIPE. That's expected; without a handler Node would treat it as an uncaught exception.
    child.stdin?.on('error', () => {});
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});
    if (opts.input != null) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

function kill(child: ChildProcess) {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}
