// Minimal rotating file logger. Logs app events only — never file contents or passwords.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;

export type Level = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  private file: string | null = null;

  init(dir: string) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, 'mintransfer.log');
    } catch {
      this.file = null;
    }
  }

  get path() {
    return this.file;
  }

  debug(msg: string, data?: unknown) {
    if (process.env.MINTRANSFER_DEBUG) this.write('debug', msg, data);
  }
  info(msg: string, data?: unknown) {
    this.write('info', msg, data);
  }
  warn(msg: string, data?: unknown) {
    this.write('warn', msg, data);
  }
  error(msg: string, data?: unknown) {
    this.write('error', msg, data);
  }

  private write(level: Level, msg: string, data?: unknown) {
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${
      data === undefined ? '' : ' ' + safeJson(data)
    }\n`;
    if (level === 'error' || level === 'warn') process.stderr.write(line);
    else if (!process.env.MINTRANSFER_QUIET) process.stdout.write(line);
    if (!this.file) return;
    try {
      const st = fs.existsSync(this.file) ? fs.statSync(this.file) : null;
      if (st && st.size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1');
      fs.appendFileSync(this.file, line);
    } catch {
      /* logging must never crash the app */
    }
  }
}

function safeJson(v: unknown) {
  try {
    if (v instanceof Error) return JSON.stringify({ message: v.message, stack: v.stack });
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = new Logger();
