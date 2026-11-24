// Phone manager (the Transfer page): browse photos, videos, music, apps and files on a phone,
// copy them to this computer or back, and export contacts / messages / calls.
// Everything a phone sends lands in <transfer folder>/<phone name>/<Photos|Videos|Music|Files|Apps…>,
// and files already copied with the same size are skipped, so repeat transfers only copy what's new.
import fs from 'node:fs';
import path from 'node:path';
import type { AndroidService } from './android';
import type { IosService } from './ios';
import type { JobContext } from './jobs';
import { formatBytes, safeName } from '../shared/export';
import { CopyItem, MediaView, PhoneApp, RemoteFile, TRANSFER_ITEMS } from '../shared/transfer';
import { SDCARD } from '../shared/android';
import type { CategoryResult, PhoneDevice, TransferItemId } from '../shared/types';

export type ExportView = MediaView | 'files';

const VIEW_FOLDER: Record<ExportView, string> = { photos: 'Photos', videos: 'Videos', music: 'Music', files: 'Files' };

/** Where imported files go on Android for each media view. */
const ANDROID_IMPORT_DIR: Record<MediaView, string> = {
  photos: `${SDCARD}/Pictures/MinTransfer`,
  videos: `${SDCARD}/Movies/MinTransfer`,
  music: `${SDCARD}/Music`,
};

export class PhoneManager {
  constructor(
    private readonly android: AndroidService,
    private readonly ios: IosService,
    private readonly transferDir: () => string,
  ) {}

  /** <transfer folder>/<phone name> */
  deviceFolder(d: PhoneDevice): string {
    return path.join(this.transferDir(), safeName(d.name, 'Phone'));
  }

  rootDir(d: PhoneDevice): string {
    return d.platform === 'ios' ? '/' : SDCARD;
  }

  listMedia(d: PhoneDevice, view: MediaView): Promise<RemoteFile[]> {
    return d.platform === 'ios' ? this.ios.listMedia(d.id, view) : this.android.listMedia(d.id, view);
  }

  listDir(d: PhoneDevice, dir: string): Promise<RemoteFile[]> {
    return d.platform === 'ios' ? this.ios.listDir(d.id, dir) : this.android.listDir(d.id, dir);
  }

  /**
   * Copies files (and, from Explorer, whole folders) to the computer. Media keep their album
   * folder (DCIM/100APPLE → Photos/100APPLE); Explorer keeps paths relative to `base`.
   */
  async exportFiles(ctx: JobContext, d: PhoneDevice, view: ExportView, picked: RemoteFile[], base?: string): Promise<string> {
    const out = path.join(this.deviceFolder(d), VIEW_FOLDER[view]);
    let files = picked.filter((f) => !f.dir);
    const dirs = picked.filter((f) => f.dir).map((f) => f.path);
    if (dirs.length) {
      ctx.progress(null, 'Listing folders…');
      files = [...files, ...(d.platform === 'ios' ? await this.ios.walk(d.id, dirs, ctx.signal) : await this.android.walk(d.id, dirs))];
    }
    const local = (f: RemoteFile) => {
      const parts =
        view === 'files' && base
          ? path.posix.relative(base, f.path).split('/')
          : [path.posix.basename(path.posix.dirname(f.path)), path.posix.basename(f.path)];
      return path.join(out, ...parts.filter((p) => p && p !== '..').map((p) => safeName(p, '_')));
    };
    const all: CopyItem[] = files.map((f) => ({ remote: f.path, local: local(f), size: f.size, mtime: f.mtime }));
    const todo = all.filter((i) => !sameFile(i));
    const skipped = all.length - todo.length;
    if (skipped) ctx.log(`${skipped.toLocaleString()} file(s) were already copied earlier and were skipped.`);
    if (!todo.length) {
      fs.mkdirSync(out, { recursive: true });
      ctx.progress(1, all.length ? 'Everything was already on this computer' : 'Nothing to copy');
      return out;
    }
    const bytes = todo.reduce((n, i) => n + i.size, 0);
    ctx.log(`Copying ${todo.length.toLocaleString()} file(s), ${formatBytes(bytes)}, to ${out}`);
    const r = d.platform === 'ios' ? await this.ios.copyFrom(ctx, d.id, todo) : await this.android.copyFrom(ctx, d.id, todo);
    if (r.failed) ctx.log(`⚠ ${r.failed} file(s) could not be copied.`);
    ctx.progress(1, `Copied ${r.files.toLocaleString()} file(s)${skipped ? `, ${skipped.toLocaleString()} already here` : ''}`);
    return out;
  }

  importDir(d: PhoneDevice, view: MediaView | 'files', dir?: string): string {
    if (view === 'files') {
      if (!dir) throw new Error('Open a folder first.');
      return dir;
    }
    if (d.platform === 'ios')
      throw new Error('Apple only lets the Photos app add photos and videos to an iPhone (or iCloud / Finder sync). Use Explorer to copy files into Downloads instead.');
    return ANDROID_IMPORT_DIR[view];
  }

  async importFiles(ctx: JobContext, d: PhoneDevice, locals: string[], remoteDir: string): Promise<number> {
    const n = d.platform === 'ios' ? await this.ios.copyTo(ctx, d.id, locals, remoteDir) : await this.android.copyTo(ctx, d.id, locals, remoteDir);
    ctx.progress(1, `Copied ${n} of ${locals.length} file(s) to the phone`);
    return n;
  }

  remove(d: PhoneDevice, paths: string[]): Promise<void> {
    return d.platform === 'ios' ? this.ios.remove(d.id, paths) : this.android.remove(d.id, paths);
  }

  apps(d: PhoneDevice): Promise<PhoneApp[]> {
    return d.platform === 'ios' ? this.ios.apps(d.id) : this.android.apps(d.id);
  }

  async exportApps(ctx: JobContext, d: PhoneDevice, ids: string[]): Promise<string> {
    if (d.platform === 'ios') throw new Error('Apple doesn’t allow copying iPhone apps to a computer. They can be downloaded again from the App Store.');
    const out = path.join(this.deviceFolder(d), 'Apps');
    const n = await this.android.exportApps(ctx, d.id, ids, out);
    ctx.progress(1, `Saved ${n} of ${ids.length} app(s)`);
    return out;
  }

  async installApps(ctx: JobContext, d: PhoneDevice, files: string[]): Promise<number> {
    if (d.platform === 'ios') throw new Error('iPhones only install apps from the App Store.');
    const n = await this.android.installApks(ctx, d.id, files);
    ctx.progress(1, `Installed ${n} of ${files.length} app(s)`);
    return n;
  }

  uninstall(d: PhoneDevice, id: string): Promise<void> {
    return d.platform === 'ios' ? this.ios.uninstall(d.id, id) : this.android.uninstall(d.id, id);
  }

  /** Home / Information: export whole kinds of content (contacts, messages, all photos…). */
  async exportItems(ctx: JobContext, d: PhoneDevice, items: TransferItemId[]): Promise<string> {
    const out = this.deviceFolder(d);
    fs.mkdirSync(out, { recursive: true });
    let results: CategoryResult[] = [];
    if (d.platform === 'ios') {
      const media = items.filter((i) => i === 'photos' || i === 'videos') as MediaView[];
      const rest = items.filter((i) => !media.includes(i as MediaView));
      // Photos and videos use the same incremental copy as the Photos / Videos tabs.
      if (media.length && this.ios.helperAvailable) {
        for (let i = 0; i < media.length; i++) {
          const sub = scaled(ctx, i / items.length, (i + 1) / items.length);
          sub.progress(null, 'Reading the camera roll…');
          await this.exportFiles(sub, d, media[i], await this.ios.listMedia(d.id, media[i], ctx.signal));
        }
        if (rest.length) results = await this.ios.exportData(scaled(ctx, media.length / items.length, 1), d, rest, path.join(out, 'Information'));
      } else results = await this.ios.exportData(ctx, d, items, path.join(out, 'Information'));
    } else {
      for (let i = 0; i < items.length; i++) {
        ctx.check();
        const sub = scaled(ctx, i / items.length, (i + 1) / items.length);
        const label = TRANSFER_ITEMS.find((t) => t.id === items[i])?.label ?? items[i];
        sub.progress(0, `Copying ${label.toLowerCase()}…`);
        if (items[i] === 'photos' || items[i] === 'videos' || items[i] === 'music') {
          await this.exportFiles(sub, d, items[i] as MediaView, await this.android.listMedia(d.id, items[i] as MediaView, ctx.signal));
        } else if (items[i] === 'apps') {
          const apps = await this.android.apps(d.id);
          await this.exportApps(sub, d, apps.map((a) => a.id));
        } else {
          results.push(await this.android.exportData(sub, d.id, items[i], path.join(out, items[i] === 'contacts' || items[i] === 'calls' || items[i] === 'messages' ? 'Information' : 'Files')));
        }
      }
    }
    for (const r of results) if (r.warning) ctx.log(`${r.label}: ${r.warning}`);
    ctx.progress(1, 'Transfer finished');
    return out;
  }
}

function sameFile(i: CopyItem): boolean {
  try {
    return fs.statSync(i.local).size === i.size;
  } catch {
    return false;
  }
}

function scaled(ctx: JobContext, from: number, to: number): JobContext {
  return { ...ctx, progress: (f, d) => ctx.progress(f == null ? null : from + f * (to - from), d) };
}
