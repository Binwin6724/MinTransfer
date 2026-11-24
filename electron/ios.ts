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
import { appleModelName, IOS_ITEMS, classifyLockdownError, explainBackupError, parseBackupProgress, parseKeyValues, parseUdidList } from '../shared/ios';
import type { BackupRecord, IosItemId, PhoneDevice } from '../shared/types';

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

  /**
   * "Choose items" backup. iOS has no partial backup, so MinTransfer makes a full backup into a
   * hidden staging folder, exports only the chosen items as ordinary files, then deletes the
   * staging copy (or keeps it as a restorable full backup when keepFull is set).
   */
  async backupItems(
    ctx: JobContext,
    device: PhoneDevice,
    dir: string,
    items: IosItemId[],
    opts: { keepFull?: boolean; label?: string },
  ): Promise<BackupRecord> {
    if (!items.length) throw new Error('Choose at least one thing to back up.');
    if (device.backupEncryption)
      throw new Error('Backup encryption is on for this iPhone, so its contents can’t be read. Make a full backup instead, or turn off encryption first.');
    const udid = device.id;
    const staging = path.join(dir, '.staging');
    fs.mkdirSync(staging, { recursive: true });
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
      dataPath: dir,
      sizeBytes: 0,
      categories: [],
      encrypted: false,
      complete: false,
      note: opts.label,
      kind: 'items',
    };
    const save = () => writeJson(path.join(dir, META_FILE), record);
    save();
    const phase = (from: number, to: number): JobContext => ({
      ...ctx,
      progress: (f, d) => ctx.progress(f == null ? null : from + f * (to - from), d),
    });

    try {
      // 1. Read everything off the phone (Apple only offers whole-device backups).
      ctx.progress(null, 'Unlock the iPhone if it asks for its passcode. Reading the iPhone…');
      const net = device.wireless ? ['-n'] : [];
      const r = await this.backup2(phase(0, 0.85), ['-u', udid, ...net, 'backup', '--full', staging]);
      const ok = r.code === 0 && /Backup Successful|Finished/i.test(r.all) && !/Backup Failed/i.test(r.all);
      if (!ok) throw new Error(explainBackupError(r.all));
      const dataPath = path.join(staging, udid);
      if (IosBackupReader.isEncrypted(dataPath))
        throw new Error('The iPhone encrypted this backup, so its contents can’t be read. Make a full backup instead, or turn off encryption first.');

      // 2. Export just the chosen items.
      const reader = await IosBackupReader.open(dataPath);
      try {
        for (let i = 0; i < items.length; i++) {
          ctx.check();
          const info = IOS_ITEMS.find((x) => x.id === items[i]);
          const label = info?.label ?? items[i];
          ctx.progress(0.85 + (0.13 * i) / items.length, `Saving ${label}…`);
          const before = new Set(fs.readdirSync(dir));
          let warning: string | undefined;
          try {
            await reader.extract(phase(0.85 + (0.13 * i) / items.length, 0.85 + (0.13 * (i + 1)) / items.length), items[i], dir);
          } catch (err) {
            if (err instanceof CancelledError) throw err;
            // One missing item (e.g. contacts kept only in iCloud) shouldn't fail the others.
            warning = 'Not on this iPhone (it may be kept only in iCloud)';
            log.warn('item export failed', { item: items[i], err: String(err) });
          }
          const paths: string[] = [];
          let files = 0;
          let bytes = 0;
          for (const p of fs.readdirSync(dir).filter((f) => !before.has(f))) {
            const s = dirStats(path.join(dir, p));
            if (!s.files) {
              fs.rmSync(path.join(dir, p), { recursive: true, force: true });
              continue;
            }
            paths.push(p);
            files += s.files;
            bytes += s.bytes;
          }
          if (!files) warning ??= 'Nothing found on this iPhone';
          record.categories.push({ id: items[i], label, files, bytes, paths, warning });
          if (warning) ctx.log(`${label}: ${warning}`);
          else
          ctx.log(`${label}: ${files.toLocaleString()} files`);
        }
      } finally {
        reader.close();
      }

      // 3. Keep or drop the full copy.
      if (opts.keepFull) {
        fs.renameSync(dataPath, path.join(dir, udid));
        const s = dirStats(path.join(dir, udid));
        record.kind = 'full';
        record.dataPath = path.join(dir, udid);
        record.categories.push({ id: 'full', label: 'Full device backup', files: s.files, bytes: s.bytes, paths: [udid] });
      }
      record.complete = true;
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
      record.sizeBytes = record.categories.reduce((n, c) => n + c.bytes, 0);
      save();
    }
    const total = record.categories.filter((c) => c.id !== 'full').reduce((n, c) => n + c.files, 0);
    ctx.progress(1, `Backup finished: ${total.toLocaleString()} files saved`);
    return record;
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
