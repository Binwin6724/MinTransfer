// The backup library: MinTransfer backups in the chosen folder plus (read-only) iOS backups
// made by Finder, iTunes or the Apple Devices app.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { META_FILE } from './android';
import { dirStats, readJson } from './fsutil';
import { IosBackupReader } from './iosBackup';
import type { JobContext } from './jobs';
import { log } from './logger';
import { readPlistFile } from './plist';
import { categoryById } from '../shared/android';
import { appleModelName, IOS_ITEMS } from '../shared/ios';
import type { BackupRecord, RecoverGroup } from '../shared/types';

export function systemBackupDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Application Support', 'MobileSync', 'Backup')];
  if (process.platform === 'win32') {
    const dirs = [path.join(home, 'Apple', 'MobileSync', 'Backup')];
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Apple Computer', 'MobileSync', 'Backup'));
    return dirs;
  }
  return [path.join(home, '.local', 'share', 'MobileSync', 'Backup')];
}

export class Library {
  backups: BackupRecord[] = [];
  /** Set when macOS blocked reading the Finder backup folder. */
  systemAccessDenied = false;
  private sizeCache = new Map<string, { mtime: number; size: number }>();

  constructor(
    private readonly dir: () => string,
    private readonly includeSystem: () => boolean,
  ) {}

  scan(): BackupRecord[] {
    const list: BackupRecord[] = [];
    const root = this.dir();
    try {
      fs.mkdirSync(root, { recursive: true });
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory()) continue;
        const folder = path.join(root, e.name);
        const rec = readJson<BackupRecord>(path.join(folder, META_FILE));
        if (!rec) continue;
        // The folder may have been moved or renamed since it was written.
        rec.id = `mt:${e.name}`;
        rec.path = folder;
        if (rec.platform === 'ios' && rec.kind !== 'items') rec.dataPath = path.join(folder, rec.deviceId);
        else rec.dataPath = folder;
        list.push(rec);
      }
    } catch (err) {
      log.warn('library scan failed', err);
    }
    this.systemAccessDenied = false;
    if (this.includeSystem()) {
      for (const sys of systemBackupDirs()) {
        let entries: fs.Dirent[] = [];
        try {
          entries = fs.readdirSync(sys, { withFileTypes: true });
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'EPERM' || (err as NodeJS.ErrnoException).code === 'EACCES') this.systemAccessDenied = true;
          continue;
        }
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const rec = this.readSystemBackup(path.join(sys, e.name));
          if (rec) list.push(rec);
        }
      }
    }
    this.backups = list.sort((a, b) => b.createdAt - a.createdAt);
    return this.backups;
  }

  private readSystemBackup(dataPath: string): BackupRecord | null {
    try {
      const info = readPlistFile(path.join(dataPath, 'Info.plist')) as Record<string, unknown> | null;
      if (!info) return null;
      const status = path.join(dataPath, 'Status.plist');
      const mtime = fs.existsSync(status) ? fs.statSync(status).mtimeMs : 0;
      let size = this.sizeCache.get(dataPath);
      if (!size || size.mtime !== mtime) {
        size = { mtime, size: dirStats(dataPath).bytes };
        this.sizeCache.set(dataPath, size);
      }
      const date = info['Last Backup Date'];
      return {
        id: `sys:${dataPath}`,
        platform: 'ios',
        source: 'system',
        deviceId: String(info['Target Identifier'] ?? info['Unique Identifier'] ?? path.basename(dataPath)),
        deviceName: String(info['Device Name'] ?? info['Display Name'] ?? 'iPhone'),
        deviceModel: appleModelName(info['Product Type'] as string | undefined),
        osVersion: String(info['Product Version'] ?? ''),
        createdAt: date instanceof Date ? date.getTime() : mtime,
        path: path.dirname(dataPath),
        dataPath,
        sizeBytes: size.size,
        categories: [],
        encrypted: IosBackupReader.isEncrypted(dataPath),
        complete: fs.existsSync(path.join(dataPath, 'Manifest.db')) || fs.existsSync(path.join(dataPath, 'Manifest.mbdb')),
        note: 'Made by Finder / iTunes',
      };
    } catch (err) {
      log.warn('could not read system backup', { dataPath, err: String(err) });
      return null;
    }
  }

  get(id: string): BackupRecord {
    const rec = this.backups.find((b) => b.id === id) ?? this.scan().find((b) => b.id === id);
    if (!rec) throw new Error('That backup no longer exists.');
    return rec;
  }

  remove(id: string) {
    const rec = this.get(id);
    if (rec.source !== 'mintransfer') throw new Error('Backups made by Finder or iTunes can only be deleted there.');
    if (!fs.existsSync(path.join(rec.path, META_FILE))) throw new Error('Refusing to delete a folder that is not a MinTransfer backup.');
    fs.rmSync(rec.path, { recursive: true, force: true });
    this.scan();
  }

  // ---------------------------------------------------------------- browsing

  async groups(id: string): Promise<RecoverGroup[]> {
    const rec = this.get(id);
    if (rec.kind === 'items') {
      return rec.categories.map((c) => ({
        id: c.id,
        label: c.label,
        description: IOS_ITEMS.find((x) => x.id === c.id)?.description ?? '',
        count: c.files,
        bytes: c.bytes,
        format: 'files',
        available: c.files > 0,
        reason: c.files > 0 ? undefined : (c.warning ?? 'Empty'),
      }));
    }
    if (rec.platform === 'ios') {
      const reader = await IosBackupReader.open(rec.dataPath);
      try {
        return reader.groups();
      } finally {
        reader.close();
      }
    }
    return rec.categories.map((c) => {
      const info = categoryById(c.id);
      return {
        id: c.id,
        label: c.label,
        description: info?.description ?? '',
        count: c.files,
        bytes: c.bytes,
        format: info?.kind === 'provider' ? (c.id === 'contacts' ? 'vcf' : 'csv') : info?.kind === 'apps' ? 'apk' : 'files',
        available: c.files > 0,
        reason: c.files > 0 ? undefined : (c.warning ?? 'Empty'),
      };
    });
  }

  async extract(ctx: JobContext, id: string, groups: string[], dest: string): Promise<string> {
    const rec = this.get(id);
    const out = path.join(dest, `${rec.deviceName.replace(/[<>:"/\\|?*]/g, '_')} - recovered ${new Date().toISOString().slice(0, 10)}`);
    fs.mkdirSync(out, { recursive: true });
    if (rec.kind === 'items') {
      for (let i = 0; i < groups.length; i++) {
        ctx.check();
        const c = rec.categories.find((x) => x.id === groups[i]);
        ctx.progress(i / groups.length, `Copying ${c?.label ?? groups[i]}…`);
        for (const p of c?.paths ?? []) {
          const src = path.join(rec.path, p);
          if (fs.existsSync(src)) fs.cpSync(src, path.join(out, p), { recursive: true });
        }
      }
    } else if (rec.platform === 'ios') {
      const reader = await IosBackupReader.open(rec.dataPath);
      try {
        for (let i = 0; i < groups.length; i++) {
          ctx.check();
          ctx.progress(i / groups.length, `Extracting ${groups[i]}…`);
          await reader.extract(
            {
              ...ctx,
              progress: (f, d) => ctx.progress((i + (f ?? 0)) / groups.length, d),
            },
            groups[i],
            out,
          );
        }
      } finally {
        reader.close();
      }
    } else {
      for (let i = 0; i < groups.length; i++) {
        ctx.check();
        const g = groups[i];
        const info = categoryById(g);
        ctx.progress(i / groups.length, `Copying ${info?.label ?? g}…`);
        if (info?.kind === 'files' || info?.kind === 'all') {
          const rels = info.kind === 'all' ? [''] : (info.paths ?? []);
          for (const rel of rels) {
            const src = path.join(rec.path, 'files', ...rel.split('/').filter(Boolean));
            if (fs.existsSync(src)) fs.cpSync(src, path.join(out, info.label, ...rel.split('/').filter(Boolean)), { recursive: true });
          }
        } else if (info?.kind === 'apps') {
          fs.cpSync(path.join(rec.path, 'apps'), path.join(out, 'Apps'), { recursive: true });
        } else {
          const file = { contacts: 'contacts.vcf', calls: 'call-log.csv', messages: 'messages.csv' }[g];
          if (file && fs.existsSync(path.join(rec.path, 'data', file))) fs.copyFileSync(path.join(rec.path, 'data', file), path.join(out, file));
        }
      }
    }
    ctx.progress(1, 'Extraction finished');
    return out;
  }
}
