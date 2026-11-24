// iPhone / iPad over libimobiledevice: discovery, pairing, backup, restore, encryption and erase.
// Backups use Apple's own MobileBackup2 protocol (the same one Finder and iTunes use), so
// a MinTransfer backup is a standard iOS backup that Finder, iTunes and Apple Devices can also read.
import fs from 'node:fs';
import path from 'node:path';
import { CancelledError, run, RunResult, toolEnv } from './exec';
import { dirStats, writeJson } from './fsutil';
import type { JobContext } from './jobs';
import { log } from './logger';
import { readPlistFile } from './plist';
import type { IosTool, ToolPaths } from './tools';
import { META_FILE } from './android';
import { IosBackupReader } from './iosBackup';
import { formatBytes } from '../shared/export';
import { CopyItem, helperCommand, HelperParser, HelperReply, MediaView, PhoneApp, RemoteFile, TRANSFER_ITEMS, VIEW_KIND } from '../shared/transfer';
import { appleModelName, mediaKind, classifyLockdownError, explainBackupError, parseBackupProgress, parseKeyValues, parseUdidList } from '../shared/ios';
import type { BackupRecord, CategoryResult, PhoneDevice, TransferItemId } from '../shared/types';

export class IosService {
  private info = new Map<string, { at: number; device: PhoneDevice }>();
  private lastPairAttempt = new Map<string, number>();

  constructor(private readonly tools: () => ToolPaths['ios']) {}

  get available() {
    const t = this.tools();
    return !!(t.idevice_id && t.ideviceinfo);
  }

  private bin(name: IosTool): string {
    const p = this.tools()[name];
    if (!p) throw new Error('libimobiledevice is not installed. Open Settings ▸ Tools for instructions.');
    return p;
  }

  private exec(name: IosTool, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
    const bin = this.bin(name);
    return run(bin, args, { timeoutMs: 20000, env: toolEnv(bin), ...opts });
  }

  async list(): Promise<PhoneDevice[]> {
    if (!this.available) return [];
    let ids: { udid: string; wireless: boolean }[];
    try {
      ids = parseUdidList((await this.exec('idevice_id', ['-l'], { timeoutMs: 10000 })).stdout);
    } catch (err) {
      log.warn('idevice_id failed', err);
      return [];
    }
    const out: PhoneDevice[] = [];
    for (const { udid, wireless } of ids) {
      const cached = this.info.get(udid);
      if (cached && cached.device.state === 'ready' && Date.now() - cached.at < 30000) {
        out.push(cached.device);
        continue;
      }
      const d = await this.describe(udid, wireless);
      this.info.set(udid, { at: Date.now(), device: d });
      out.push(d);
    }
    for (const id of [...this.info.keys()]) if (!ids.some((i) => i.udid === id)) this.info.delete(id);
    return out;
  }

  invalidate(udid: string) {
    this.info.delete(udid);
  }

  private async describe(udid: string, wireless: boolean): Promise<PhoneDevice> {
    const base: PhoneDevice = {
      id: udid,
      platform: 'ios',
      state: 'unknown',
      name: 'iPhone',
      model: 'iPhone',
      manufacturer: 'Apple',
      osName: 'iOS',
      osVersion: '',
      wireless,
    };
    const net = wireless ? ['-n'] : [];
    const r = await this.exec('ideviceinfo', ['-u', udid, ...net]).catch((e: Error) => ({ code: 1, stdout: '', stderr: e.message, all: e.message }) as RunResult);
    if (r.code !== 0 || !/ProductType:/.test(r.stdout)) {
      const { state, detail } = classifyLockdownError(r.all);
      // Ask the phone to show "Trust This Computer?" (at most every 6 s so we don't spam it).
      if ((state === 'untrusted' || state === 'locked') && this.tools().idevicepair) {
        const last = this.lastPairAttempt.get(udid) ?? 0;
        if (Date.now() - last > 6000) {
          this.lastPairAttempt.set(udid, Date.now());
          this.exec('idevicepair', ['-u', udid, 'pair'], { timeoutMs: 15000 }).catch(() => undefined);
        }
      }
      // Basic, unpaired info is still available (name, model, iOS version).
      const basic = await this.exec('ideviceinfo', ['-u', udid, ...net, '-s']).catch(() => null);
      const kv = basic && basic.code === 0 ? parseKeyValues(basic.stdout) : {};
      return {
        ...base,
        state: state === 'unknown' ? 'untrusted' : state,
        stateDetail: detail,
        name: kv.DeviceName || base.name,
        model: appleModelName(kv.ProductType, kv.DeviceClass),
        osName: osName(kv.DeviceClass),
        osVersion: kv.ProductVersion ?? '',
      };
    }
    const kv = parseKeyValues(r.stdout);
    const [battery, disk, backup] = await Promise.all([
      this.exec('ideviceinfo', ['-u', udid, ...net, '-q', 'com.apple.mobile.battery']).then((x) => parseKeyValues(x.stdout)).catch(() => ({}) as Record<string, string>),
      this.exec('ideviceinfo', ['-u', udid, ...net, '-q', 'com.apple.disk_usage']).then((x) => parseKeyValues(x.stdout)).catch(() => ({}) as Record<string, string>),
      this.exec('ideviceinfo', ['-u', udid, ...net, '-q', 'com.apple.mobile.backup']).then((x) => parseKeyValues(x.stdout)).catch(() => ({}) as Record<string, string>),
    ]);
    return {
      ...base,
      state: 'ready',
      name: kv.DeviceName || 'iPhone',
      model: appleModelName(kv.ProductType, kv.DeviceClass),
      osName: osName(kv.DeviceClass),
      osVersion: kv.ProductVersion ?? '',
      serial: kv.SerialNumber,
      battery: battery.BatteryCurrentCapacity ? Number(battery.BatteryCurrentCapacity) : undefined,
      charging: battery.BatteryIsCharging ? battery.BatteryIsCharging === 'true' : undefined,
      storageTotal: disk.TotalDiskCapacity ? Number(disk.TotalDiskCapacity) : undefined,
      storageFree: disk.AmountDataAvailable ? Number(disk.AmountDataAvailable) : disk.TotalDataAvailable ? Number(disk.TotalDataAvailable) : undefined,
      backupEncryption: backup.WillEncrypt ? backup.WillEncrypt === 'true' : undefined,
    };
  }

  async pair(udid: string): Promise<string> {
    const r = await this.exec('idevicepair', ['-u', udid, 'pair'], { timeoutMs: 30000 });
    this.invalidate(udid);
    if (r.code === 0) return 'Paired';
    return classifyLockdownError(r.all).detail;
  }

  // ---------------------------------------------------------------- backup

  private async backup2(ctx: JobContext, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
    const bin = this.bin('idevicebackup2');
    const r = await run(bin, args, {
      timeoutMs: 0,
      signal: ctx.signal,
      env: { ...toolEnv(bin), ...env },
      onLine: (line) => {
        const p = parseBackupProgress(line);
        if (p != null) ctx.progress(p);
        else if (!/^\[=*\s*\]/.test(line)) {
          ctx.log(line);
          if (/Receiving|Sending|Backup|Restor|Erase|Starting/i.test(line)) ctx.detail(line.trim().slice(0, 140));
        }
      },
    });
    return r;
  }

  async setEncryption(ctx: JobContext, udid: string, on: boolean, password: string): Promise<void> {
    ctx.progress(null, on ? 'Turning on encrypted backups…' : 'Turning off backup encryption…');
    const env: Record<string, string> = on ? { BACKUP_PASSWORD_NEW: password } : { BACKUP_PASSWORD: password };
    const r = await this.backup2(ctx, ['-u', udid, 'encryption', on ? 'on' : 'off'], env);
    if (r.code !== 0 || /error/i.test(r.all)) throw new Error(explainBackupError(r.all));
    this.invalidate(udid);
  }

  async backup(ctx: JobContext, device: PhoneDevice, dir: string, opts: { encryptPassword?: string; label?: string }): Promise<BackupRecord> {
    const udid = device.id;
    fs.mkdirSync(dir, { recursive: true });
    if (opts.encryptPassword && !device.backupEncryption) await this.setEncryption(ctx, udid, true, opts.encryptPassword);
    ctx.progress(null, 'Unlock the iPhone if it asks for its passcode. Preparing backup…');
    const record: BackupRecord = {
      id: path.basename(dir),
      platform: 'ios',
      source: 'mintransfer',
      deviceId: udid,
      deviceName: device.name,
      deviceModel: device.model,
      osVersion: device.osVersion,
      createdAt: Date.now(),
      path: dir,
      dataPath: path.join(dir, udid),
      sizeBytes: 0,
      categories: [],
      encrypted: !!(opts.encryptPassword || device.backupEncryption),
      complete: false,
      note: opts.label,
    };
    writeJson(path.join(dir, META_FILE), record);
    const net = device.wireless ? ['-n'] : [];
    const r = await this.backup2(ctx, ['-u', udid, ...net, 'backup', '--full', dir]);
    const ok = r.code === 0 && /Backup Successful|Finished/i.test(r.all) && !/Backup Failed/i.test(r.all);
    const stats = dirStats(record.dataPath);
    record.sizeBytes = stats.bytes;
    record.categories = [{ id: 'full', label: 'Full device backup', files: stats.files, bytes: stats.bytes }];
    try {
      const manifest = readPlistFile(path.join(record.dataPath, 'Manifest.plist')) as Record<string, unknown> | null;
      if (manifest && typeof manifest.IsEncrypted === 'boolean') record.encrypted = manifest.IsEncrypted;
    } catch {
      /* not written when the backup failed early */
    }
    record.complete = ok;
    writeJson(path.join(dir, META_FILE), record);
    if (!ok) throw new Error(explainBackupError(r.all));
    ctx.progress(1, `Backup finished: ${stats.files.toLocaleString()} files`);
    return record;
  }

  // ---------------------------------------------------------------- transfer

  /** Whether the mt-ios helper (files and apps) is available. */
  get helperAvailable() {
    return !!this.tools()['mt-ios'];
  }

  /**
   * Runs mt-ios commands in one connection. `bases[i]` is the folder command i lists (null for
   * walk / non-list commands). Calls onReply as each command finishes.
   */
  private async helper(udid: string, commands: string[], bases: (string | null)[], opts: { signal?: AbortSignal; onReply?: (i: number, r: HelperReply) => void } = {}): Promise<HelperReply[]> {
    const bin = this.tools()['mt-ios'];
    if (!bin) throw new Error('This feature needs MinTransfer’s iPhone file helper, which is missing from this installation. Reinstall MinTransfer.');
    const parser = new HelperParser(bases, opts.onReply);
    let fatal: Error | null = null;
    const r = await run(bin, ['-u', udid], {
      timeoutMs: 0,
      signal: opts.signal,
      env: toolEnv(bin),
      input: commands.join('\n') + '\n',
      maxBuffer: 1024 * 1024,
      onLine: (line, stream) => {
        if (stream !== 'stdout' || fatal) return;
        try {
          parser.line(line);
        } catch (err) {
          fatal = err as Error;
        }
      },
    });
    if (fatal) throw new Error(explainBackupError((fatal as Error).message));
    if (!parser.ready) throw new Error(explainBackupError(r.all || 'The iPhone file service did not start.'));
    return parser.replies;
  }

  async listDir(udid: string, dir: string): Promise<RemoteFile[]> {
    const [r] = await this.helper(udid, [helperCommand('ls', dir)], [dir]);
    if (!r?.ok) throw new Error(r?.error ?? `Couldn’t open ${dir}`);
    return r.entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
  }

  async walk(udid: string, dirs: string[], signal?: AbortSignal): Promise<RemoteFile[]> {
    if (!dirs.length) return [];
    const replies = await this.helper(udid, dirs.map((d) => helperCommand('walk', d)), dirs.map(() => null), { signal });
    return replies.flatMap((r) => r.entries).filter((f) => !f.dir);
  }

  /** Camera-roll photos or videos. iPhone music isn't reachable (Apple keeps it in the Music app's private library). */
  async listMedia(udid: string, view: MediaView, signal?: AbortSignal): Promise<RemoteFile[]> {
    if (view === 'music') return [];
    const kind = VIEW_KIND[view];
    return (await this.walk(udid, ['/DCIM'], signal)).filter((f) => mediaKind(f.path) === kind && f.size > 0).sort((a, b) => b.mtime - a.mtime);
  }

  async copyFrom(ctx: JobContext, udid: string, items: CopyItem[]): Promise<{ files: number; failed: number }> {
    const total = items.reduce((n, i) => n + i.size, 0) || 1;
    let done = 0;
    let files = 0;
    let failed = 0;
    for (const it of items) fs.mkdirSync(path.dirname(it.local), { recursive: true });
    await this.helper(
      udid,
      items.map((i) => helperCommand('get', i.remote, i.local)),
      items.map(() => null),
      {
        signal: ctx.signal,
        onReply: (i, r) => {
          done += items[i].size;
          if (r.ok) {
            files++;
            if (items[i].mtime) {
              try {
                fs.utimesSync(items[i].local, new Date(items[i].mtime), new Date(items[i].mtime));
              } catch {
                /* keep going */
              }
            }
          } else {
            failed++;
            ctx.log(`⚠ ${r.error}`);
          }
          if (i % 5 === 0 || i === items.length - 1) ctx.progress(Math.min(0.99, done / total), `Copied ${files.toLocaleString()} of ${items.length.toLocaleString()} files (${formatBytes(done)})`);
        },
      },
    );
    return { files, failed };
  }

  async copyTo(ctx: JobContext, udid: string, locals: string[], remoteDir: string): Promise<number> {
    if (/^\/(DCIM|PhotoData)(\/|$)/i.test(remoteDir)) throw new Error('Files copied into the camera roll don’t appear in the Photos app. Choose another folder, such as Downloads.');
    let n = 0;
    const replies = await this.helper(
      udid,
      [helperCommand('mkdir', remoteDir), ...locals.map((l) => helperCommand('put', l, `${remoteDir === '/' ? '' : remoteDir}/${path.basename(l)}`))],
      [null, ...locals.map(() => null)],
      {
        signal: ctx.signal,
        onReply: (i, r) => {
          if (i === 0) return;
          if (r.ok) n++;
          else ctx.log(`⚠ ${r.error}`);
          ctx.progress(i / locals.length, `Copied ${n} of ${locals.length}`);
        },
      },
    );
    void replies;
    return n;
  }

  async remove(udid: string, paths: string[]): Promise<void> {
    for (const p of paths)
      if (/^\/(DCIM|PhotoData)(\/|$)/i.test(p)) throw new Error('Photos and videos can only be deleted in the Photos app on the iPhone, so the Photos library stays intact.');
    const replies = await this.helper(udid, paths.map((p) => helperCommand('rm', p)), paths.map(() => null));
    const bad = replies.filter((r) => !r.ok);
    if (bad.length) throw new Error(`${bad.length} item(s) couldn’t be deleted. Folders must be empty first. ${bad[0].error ?? ''}`);
  }

  async apps(udid: string): Promise<PhoneApp[]> {
    const [r] = await this.helper(udid, ['apps'], [null]);
    if (!r?.ok) throw new Error(r?.error ?? 'Couldn’t list apps');
    return r.apps.sort((a, b) => a.name.localeCompare(b.name));
  }

  async uninstall(udid: string, id: string): Promise<void> {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error('Invalid app id');
    const [r] = await this.helper(udid, [helperCommand('uninstall', id)], [null]);
    if (!r?.ok) throw new Error(r?.error ?? `Couldn’t remove ${id}`);
  }

  /**
   * Exports items for Transfer ▸ Information / Home. Photos and videos come straight from the
   * camera roll; everything else lives in app storage that Apple only hands out through a full
   * backup, so that part makes one in a temporary folder, exports the items and deletes it.
   */
  async exportData(ctx: JobContext, device: PhoneDevice, items: TransferItemId[], out: string): Promise<CategoryResult[]> {
    if (!items.length) throw new Error('Choose at least one thing to transfer.');
    fs.mkdirSync(out, { recursive: true });
    const media: TransferItemId[] = this.helperAvailable ? items.filter((i) => i === 'photos' || i === 'videos') : [];
    const viaBackup = items.filter((i) => !media.includes(i));
    if (viaBackup.length && device.backupEncryption)
      throw new Error(
        `Backup encryption is on for this iPhone, so ${viaBackup.map((i) => TRANSFER_ITEMS.find((t) => t.id === i)?.label ?? i).join(', ')} can’t be read. Turn encryption off, or transfer Photos and Videos only.`,
      );
    const split = !media.length ? 0 : !viaBackup.length ? 1 : 0.3;
    const results: CategoryResult[] = [];
    for (let i = 0; i < media.length; i++) {
      const view = media[i] as MediaView;
      const label = view === 'photos' ? 'Photos' : 'Videos';
      const pctx = scaled(ctx, (split * i) / media.length, (split * (i + 1)) / media.length);
      pctx.progress(null, `Reading the camera roll…`);
      const files = await this.listMedia(device.id, view, ctx.signal);
      const items2: CopyItem[] = files.map((f) => ({ ...f, remote: f.path, local: path.join(out, label, ...f.path.split('/').slice(-2)) }));
      const r = await this.copyFrom(pctx, device.id, items2);
      const bytes = files.reduce((n, f) => n + f.size, 0);
      results.push({ id: view, label, files: r.files, bytes, paths: r.files ? [label] : [], warning: r.failed ? `${r.failed} file(s) couldn’t be read` : r.files ? undefined : 'None on this iPhone' });
    }
    if (viaBackup.length) results.push(...(await this.exportViaBackup(ctx, device, viaBackup, out, scaled(ctx, split, 1))));
    return results;
  }

  private async exportViaBackup(ctx: JobContext, device: PhoneDevice, items: TransferItemId[], out: string, pctx: JobContext): Promise<CategoryResult[]> {
    const udid = device.id;
    const staging = path.join(out, '.mt-backup');
    fs.mkdirSync(staging, { recursive: true });
    const results: CategoryResult[] = [];
    try {
      // Apple only offers whole-device backups for app data such as Messages and Notes.
      pctx.progress(null, 'Unlock the iPhone if it asks for its passcode. Reading the iPhone…');
      const net = device.wireless ? ['-n'] : [];
      const r = await this.backup2(scaled(pctx, 0, 0.85), ['-u', udid, ...net, 'backup', '--full', staging]);
      const ok = r.code === 0 && /Backup Successful|Finished/i.test(r.all) && !/Backup Failed/i.test(r.all);
      if (!ok) throw new Error(explainBackupError(r.all));
      const dataPath = path.join(staging, udid);
      if (IosBackupReader.isEncrypted(dataPath))
        throw new Error('The iPhone encrypted this backup, so its contents can’t be read. Turn off backup encryption and try again.');

      const reader = await IosBackupReader.open(dataPath);
      try {
        for (let i = 0; i < items.length; i++) {
          ctx.check();
          const label = TRANSFER_ITEMS.find((t) => t.id === items[i])?.label ?? items[i];
          const from = 0.85 + (0.15 * i) / items.length;
          const to = 0.85 + (0.15 * (i + 1)) / items.length;
          pctx.progress(from, `Saving ${label}…`);
          const before = new Set(fs.readdirSync(out));
          let warning: string | undefined;
          try {
            await reader.extract(scaled(pctx, from, to), BACKUP_GROUP[items[i]] ?? items[i], out);
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            // One missing item (e.g. contacts kept only in iCloud) shouldn't fail the others.
            warning = 'Not on this iPhone (it may be kept only in iCloud)';
            log.warn('item export failed', { item: items[i], err: String(err) });
          }
          const paths: string[] = [];
          let files = 0;
          let bytes = 0;
          for (const p of fs.readdirSync(out).filter((f) => !before.has(f))) {
            const st = dirStats(path.join(out, p));
            if (!st.files) {
              fs.rmSync(path.join(out, p), { recursive: true, force: true });
              continue;
            }
            paths.push(p);
            files += st.files;
            bytes += st.bytes;
          }
          if (!files) warning ??= 'Nothing found on this iPhone';
          results.push({ id: items[i], label, files, bytes, paths, warning });
          ctx.log(warning ? `${label}: ${warning}` : `${label}: ${files.toLocaleString()} files`);
        }
      } finally {
        reader.close();
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    return results;
  }

  // ---------------------------------------------------------------- restore

  async restore(
    ctx: JobContext,
    udid: string,
    record: BackupRecord,
    opts: { system: boolean; settings: boolean; reboot: boolean; password?: string; copy: boolean },
  ): Promise<void> {
    const sourceFolder = path.basename(record.dataPath);
    const parent = path.dirname(record.dataPath);
    const args = ['-u', udid, 'restore'];
    if (opts.system) args.push('--system');
    if (opts.settings) args.push('--settings');
    if (!opts.reboot) args.push('--no-reboot');
    if (opts.copy) args.push('--copy');
    args.push('--source', sourceFolder, parent);
    ctx.progress(null, 'Keep the iPhone unlocked and connected. Starting restore…');
    const r = await this.backup2(ctx, args, opts.password ? { BACKUP_PASSWORD: opts.password } : {});
    if (r.code !== 0 || /Restore Failed|ERROR/i.test(r.all)) throw new Error(explainBackupError(r.all));
    this.invalidate(udid);
    ctx.progress(1, opts.reboot ? 'Restore finished. The iPhone is restarting.' : 'Restore finished. Restart the iPhone to finish applying it.');
  }

  // ---------------------------------------------------------------- erase

  /**
   * libimobiledevice has no "Erase All Content and Settings" command, so MinTransfer offers the
   * Apple-supported routes: erase on the phone itself, or put it in recovery mode for a factory
   * restore with Finder / Apple Devices / iTunes.
   */
  async enterRecovery(ctx: JobContext, udid: string): Promise<void> {
    ctx.progress(null, 'Restarting the iPhone into recovery mode…');
    const r = await this.exec('ideviceenterrecovery', [udid], { timeoutMs: 60000, signal: ctx.signal });
    ctx.log(r.all.trim());
    if (r.code !== 0) throw new Error(explainBackupError(r.all));
    this.invalidate(udid);
    ctx.progress(
      1,
      process.platform === 'darwin'
        ? 'The iPhone is in recovery mode. Open Finder, select it and choose Restore to erase it and reinstall iOS.'
        : 'The iPhone is in recovery mode. Open Apple Devices (or iTunes), select it and choose Restore to erase it and reinstall iOS.',
    );
  }

}

function osName(deviceClass?: string) {
  if (deviceClass === 'iPad') return 'iPadOS';
  return 'iOS';
}

/** Maps a transfer item to the backup reader's export group. */
const BACKUP_GROUP: Partial<Record<TransferItemId, string>> = { photos: 'images', videos: 'videos' };

/** A job context whose progress 0..1 maps onto from..to of the parent's bar. */
function scaled(ctx: JobContext, from: number, to: number): JobContext {
  return { ...ctx, progress: (f, d) => ctx.progress(f == null ? null : from + f * (to - from), d) };
}

