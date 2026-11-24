// File-system helpers shared by the services.
import fs from 'node:fs';
import path from 'node:path';

export interface DirStats {
  files: number;
  bytes: number;
}

/** Recursively counts files and bytes. Missing folders count as empty. */
export function dirStats(dir: string): DirStats {
  const out = { files: 0, bytes: 0 };
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        out.files++;
        try {
          out.bytes += fs.statSync(p).size;
        } catch {
          /* vanished */
        }
      }
    }
  };
  walk(dir);
  return out;
}

/** Calls `fn` every `ms` until the returned stop() is called. */
export function every(ms: number, fn: () => void): () => void {
  const t = setInterval(fn, ms);
  return () => clearInterval(t);
}

/** A path that does not exist yet: "name.ext", "name (2).ext", … */
export function uniquePath(file: string): string {
  if (!fs.existsSync(file)) return file;
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  for (let i = 2; ; i++) {
    const p = `${base} (${i})${ext}`;
    if (!fs.existsSync(p)) return p;
  }
}

/** Free space on the volume that holds `dir`, or null when unknown. */
export function freeSpace(dir: string): number | null {
  try {
    let d = dir;
    while (!fs.existsSync(d)) {
      const parent = path.dirname(d);
      if (parent === d) return null;
      d = parent;
    }
    const s = fs.statfsSync(d);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function writeJson(file: string, data: unknown) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}
