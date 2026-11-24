// Android over adb: discovery, backup, restore, recoverable-file scan and erase.
import fs from 'node:fs';
import path from 'node:path';
import { run, RunResult } from './exec';
import { dirStats, every, writeJson } from './fsutil';
import type { JobContext } from './jobs';
import { log } from './logger';
import {
  ANDROID_CATEGORIES,
  CALL_KEYS,
  CONTACT_KEYS,
  SDCARD,
  SMS_KEYS,
  androidModelName,
  categoryById,
  isProviderDenied,
  isSafePackageName,
  parseAdbDevices,
  parseBattery,
  parseContentRows,
  parseDf,
  parseGetprop,
  parsePackageList,
  parsePmPath,
  parseTrashScan,
  pathsForCategories,
  shQuote,
  trashScanCommand,
} from '../shared/android';
import { ANDROID_CALL_TYPES, androidContactsToCards, csv, isoTime, toVCard } from '../shared/export';
import { mediaKind } from '../shared/ios';
import { chunk, CopyItem, MediaView, parseStatLines, parseStatTypeLines, PhoneApp, RemoteFile, TRANSFER_ITEMS, VIEW_KIND } from '../shared/transfer';
import type { AndroidCategoryId, BackupRecord, CategoryResult, PhoneDevice, TransferItemId, TrashItem } from '../shared/types';

export const META_FILE = 'mintransfer.json';

export class AndroidService {
  private info = new Map<string, { at: number; device: PhoneDevice }>();

  constructor(private readonly adbPath: () => string | undefined) {}

  private adb(serial: string | null, args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
    const bin = this.adbPath();
    if (!bin) throw new Error('Android Platform-Tools (adb) are not installed. Open Settings ▸ Tools.');
    return run(bin, serial ? ['-s', serial, ...args] : args, { timeoutMs: 30000, ...opts });
  }

  private async shell(serial: string, cmd: string, opts: Parameters<typeof run>[2] = {}): Promise<string> {
    const r = await this.adb(serial, ['shell', cmd], opts);
    return r.stdout;
  }

  async list(): Promise<PhoneDevice[]> {
    if (!this.adbPath()) return [];
    let out: RunResult;
    try {
      out = await this.adb(null, ['devices', '-l'], { timeoutMs: 15000 });
    } catch (err) {
      log.warn('adb devices failed', err);
      return [];
    }
    const entries = parseAdbDevices(out.stdout);
    const devices: PhoneDevice[] = [];
    for (const e of entries) {
      const base: PhoneDevice = {
        id: e.serial,
        platform: 'android',
        state: e.state,
        stateDetail: e.stateDetail,
        name: e.model ?? 'Android phone',
        model: e.model ?? 'Android phone',
        manufacturer: '',
        osName: 'Android',
        osVersion: '',
        wireless: e.wireless,
      };
      if (e.state !== 'ready') {
        devices.push(base);
        continue;
      }
      const cached = this.info.get(e.serial);
      if (cached && Date.now() - cached.at < 30000) {
        devices.push(cached.device);
        continue;
      }
      try {
        const d = await this.describe(e.serial, base);
        this.info.set(e.serial, { at: Date.now(), device: d });
        devices.push(d);
      } catch (err) {
        log.warn('describe android failed', err);
        devices.push(cached?.device ?? base);
      }
    }
    for (const id of [...this.info.keys()]) if (!entries.some((e) => e.serial === id)) this.info.delete(id);
    return devices;
  }

  invalidate(serial: string) {
    this.info.delete(serial);
  }

  private async describe(serial: string, base: PhoneDevice): Promise<PhoneDevice> {
    const [props, battery, df, name] = await Promise.all([
      this.shell(serial, 'getprop', { timeoutMs: 10000 }).then(parseGetprop),
      this.shell(serial, 'dumpsys battery', { timeoutMs: 10000 }).then(parseBattery).catch(() => ({ level: undefined, charging: undefined })),
      this.shell(serial, 'df -k /data', { timeoutMs: 10000 }).then(parseDf).catch(() => null),
      this.shell(serial, 'settings get global device_name', { timeoutMs: 10000 }).catch(() => ''),
    ]);
    const { model, manufacturer } = androidModelName(props, base.model);
    const devName = name.trim() && name.trim() !== 'null' ? name.trim() : model;
    return {
      ...base,
      name: devName,
      model,
      manufacturer,
      osVersion: props['ro.build.version.release'] ?? '',
      serial: props['ro.serialno'] || serial,
      battery: battery.level,
      charging: battery.charging,
      storageTotal: df?.total,
      storageFree: df?.free,
    };
  }

  // ---------------------------------------------------------------- backup

  async backup(ctx: JobContext, device: PhoneDevice, categories: AndroidCategoryId[], dir: string, label?: string): Promise<BackupRecord> {
    const serial = device.id;
    fs.mkdirSync(dir, { recursive: true });
    const record: BackupRecord = {
      id: path.basename(dir),
      platform: 'android',
      source: 'mintransfer',
      deviceId: device.serial ?? serial,
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
      note: label,
    };
    const save = () => writeJson(path.join(dir, META_FILE), record);
    save();

    const fileCats = categories.includes('storage') ? (['storage'] as AndroidCategoryId[]) : categories.filter((c) => categoryById(c)?.kind === 'files');
    const otherCats = categories.filter((c) => !fileCats.includes(c) && categoryById(c)?.kind !== 'files' && c !== 'storage');
    const steps = fileCats.length + otherCats.length || 1;
    let step = 0;

    for (const cat of fileCats) {
      ctx.check();
      const info = categoryById(cat)!;
      const res = await this.pullCategory(ctx, serial, cat, path.join(dir, 'files'), (f) => ctx.progress((step + f) / steps));
      record.categories.push({ id: cat, label: info.label, ...res });
      step++;
      save();
    }
    for (const cat of otherCats) {
      ctx.check();
      const info = categoryById(cat)!;
      ctx.progress(step / steps, `Backing up ${info.label.toLowerCase()}…`);
      let res: Omit<CategoryResult, 'id' | 'label'>;
      if (cat === 'apps') res = await this.backupApps(ctx, serial, path.join(dir, 'apps'), (f) => ctx.progress((step + f) / steps));
      else res = await this.backupProvider(ctx, serial, cat, path.join(dir, 'data'));
      record.categories.push({ id: cat, label: info.label, ...res });
      if (res.warning) ctx.log(`⚠ ${info.label}: ${res.warning}`);
      step++;
      save();
    }
    record.sizeBytes = dirStats(dir).bytes;
    record.complete = true;
    save();
    ctx.progress(1, `Backed up ${record.categories.reduce((n, c) => n + c.files, 0).toLocaleString()} items`);
    return record;
  }

  /** Remote folders (relative to /sdcard) that exist for a category. */
  private async existingPaths(serial: string, cat: AndroidCategoryId): Promise<string[]> {
    if (cat === 'storage') {
      // Pull every top-level entry separately so one unreadable folder can't abort the rest.
      // Android/data and Android/obb are private to apps on Android 11+, so only Android/media is taken.
      const out = await this.shell(serial, `ls -1a ${SDCARD}/`);
      const names = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s && s !== '.' && s !== '..' && s !== 'Android');
      const media = await this.shell(serial, `[ -d ${SDCARD}/Android/media ] && echo yes`);
      return media.includes('yes') ? [...names, 'Android/media'] : names;
    }
    const wanted = pathsForCategories([cat]);
    const out = await this.shell(serial, wanted.map((p) => `[ -e ${shQuote(`${SDCARD}/${p}`)} ] && echo ${shQuote(p)}`).join('; ') + '; true');
    return out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => wanted.includes(s));
  }

  private async remoteSizeKb(serial: string, paths: string[]): Promise<number> {
    if (!paths.length) return 0;
    const out = await this.shell(serial, `du -sk ${paths.map((p) => shQuote(`${SDCARD}/${p}`)).join(' ')} 2>/dev/null`, { timeoutMs: 120000 });
    return out.split(/\r?\n/).reduce((n, l) => n + (Number(/^(\d+)/.exec(l.trim())?.[1]) || 0), 0);
  }

  private async pullCategory(
    ctx: JobContext,
    serial: string,
    cat: AndroidCategoryId,
    filesDir: string,
    onFraction: (f: number) => void,
  ): Promise<Omit<CategoryResult, 'id' | 'label'>> {
    const info = categoryById(cat)!;
    ctx.progress(null, `Looking for ${info.label.toLowerCase()}…`);
    const paths = await this.existingPaths(serial, cat);
    if (!paths.length) return { files: 0, bytes: 0, warning: 'Nothing found on the phone.' };
    const totalBytes = (await this.remoteSizeKb(serial, paths)) * 1024;
    ctx.log(`${info.label}: ${paths.length} folder(s), about ${(totalBytes / 1048576).toFixed(1)} MB`);
    let doneBytes = 0;
    const errors: string[] = [];
    for (const rel of paths) {
      ctx.check();
      const local = path.join(filesDir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      const before = dirStats(local).bytes;
      const stop = every(1200, () => {
        const now = doneBytes + dirStats(local).bytes - before;
        onFraction(totalBytes ? Math.min(0.99, now / totalBytes) : 0);
        ctx.detail(`Copying ${info.label.toLowerCase()}: ${rel}… ${(now / 1048576).toFixed(0)} of ${(totalBytes / 1048576).toFixed(0)} MB`);
      });
      try {
        // If the local folder already exists adb would nest the copy inside it, so pull into a temp name first.
        const exists = fs.existsSync(local);
        const target = exists ? `${local}.mt-partial` : local;
        const r = await this.adb(serial, ['pull', '-a', `${SDCARD}/${rel}`, target], {
          timeoutMs: 0,
          signal: ctx.signal,
          onLine: (l) => {
            if (/error|failed|denied/i.test(l)) {
              errors.push(l);
              ctx.log(l);
            }
          },
        });
        if (exists && fs.existsSync(target)) {
          fs.cpSync(target, local, { recursive: true, force: true });
          fs.rmSync(target, { recursive: true, force: true });
        }
        if (r.code !== 0) ctx.log(`adb pull ${rel} exited with ${r.code}: ${r.all.trim().split('\n').pop()}`);
      } finally {
        stop();
      }
      doneBytes += dirStats(local).bytes - before;
    }
    const stats = paths.reduce(
      (acc, rel) => {
        const s = dirStats(path.join(filesDir, ...rel.split('/')));
        return { files: acc.files + s.files, bytes: acc.bytes + s.bytes };
      },
      { files: 0, bytes: 0 },
    );
    onFraction(1);
    return { ...stats, warning: errors.length ? `${errors.length} file(s) could not be read.` : undefined };
  }

  private async backupApps(ctx: JobContext, serial: string, appsDir: string, onFraction: (f: number) => void): Promise<Omit<CategoryResult, 'id' | 'label'>> {
    const pkgs = parsePackageList(await this.shell(serial, 'pm list packages -3 -f')).filter((p) => isSafePackageName(p.name));
    fs.mkdirSync(appsDir, { recursive: true });
    let files = 0;
    let failed = 0;
    for (let i = 0; i < pkgs.length; i++) {
      ctx.check();
      const p = pkgs[i];
      ctx.detail(`Saving app ${i + 1} of ${pkgs.length}: ${p.name}`);
      onFraction(i / pkgs.length);
      const apks = parsePmPath(await this.shell(serial, `pm path ${p.name}`));
      const dest = path.join(appsDir, p.name);
      fs.mkdirSync(dest, { recursive: true });
      let ok = true;
      for (const apk of apks) {
        const r = await this.adb(serial, ['pull', apk, path.join(dest, path.posix.basename(apk))], { timeoutMs: 600000, signal: ctx.signal });
        if (r.code !== 0) ok = false;
        else files++;
      }
      if (!ok) {
        failed++;
        ctx.log(`Could not copy ${p.name}`);
      }
    }
    writeJson(path.join(appsDir, 'apps.json'), pkgs.map((p) => p.name));
    onFraction(1);
    return { files, bytes: dirStats(appsDir).bytes, warning: failed ? `${failed} app(s) could not be copied.` : undefined };
  }

  private async backupProvider(ctx: JobContext, serial: string, cat: AndroidCategoryId, dataDir: string): Promise<Omit<CategoryResult, 'id' | 'label'>> {
    fs.mkdirSync(dataDir, { recursive: true });
    const query = async (uri: string, keys: string[], sort?: string) => {
      const cmd = `content query --uri ${uri} --projection ${keys.join(':')}${sort ? ` --sort ${shQuote(sort)}` : ''}`;
      const r = await this.adb(serial, ['shell', cmd], { timeoutMs: 300000, signal: ctx.signal, maxBuffer: 512 * 1024 * 1024 });
      if (isProviderDenied(r.all)) return null;
      return parseContentRows(r.stdout, keys);
    };
    const denied = 'Android blocked access to this data over USB debugging on this phone.';
    if (cat === 'contacts') {
      const rows = await query('content://com.android.contacts/data', CONTACT_KEYS);
      if (!rows) return { files: 0, bytes: 0, warning: denied };
      const cards = androidContactsToCards(rows);
      const file = path.join(dataDir, 'contacts.vcf');
      fs.writeFileSync(file, toVCard(cards));
      ctx.log(`Exported ${cards.length} contacts`);
      return { files: cards.length, bytes: fs.statSync(file).size };
    }
    if (cat === 'calls') {
      const rows = await query('content://call_log/calls', CALL_KEYS, 'date DESC');
      if (!rows) return { files: 0, bytes: 0, warning: denied };
      const file = path.join(dataDir, 'call-log.csv');
      fs.writeFileSync(
        file,
        csv([['Date', 'Number', 'Name', 'Type', 'Duration (s)'], ...rows.map((r) => [isoTime(Number(r.date)), r.number, r.name, ANDROID_CALL_TYPES[r.type] ?? r.type, r.duration])]),
      );
      return { files: rows.length, bytes: fs.statSync(file).size };
    }
    if (cat === 'messages') {
      const rows = await query('content://sms', SMS_KEYS, 'date ASC');
      if (!rows) return { files: 0, bytes: 0, warning: denied };
      const file = path.join(dataDir, 'messages.csv');
      fs.writeFileSync(
        file,
        csv([['Date', 'Address', 'Direction', 'Read', 'Text'], ...rows.map((r) => [isoTime(Number(r.date)), r.address, r.type === '2' ? 'Sent' : r.type === '1' ? 'Received' : r.type, r.read === '1' ? 'yes' : 'no', r.body])]),
      );
      return { files: rows.length, bytes: fs.statSync(file).size };
    }
    return { files: 0, bytes: 0 };
  }

  // ---------------------------------------------------------------- restore

  async restore(ctx: JobContext, serial: string, record: BackupRecord, categories: string[]): Promise<void> {
    const steps = categories.length || 1;
    let step = 0;
    const filesDir = path.join(record.path, 'files');
    for (const cat of categories) {
      ctx.check();
      const info = categoryById(cat);
      if (!info) continue;
      ctx.progress(step / steps, `Restoring ${info.label.toLowerCase()}…`);
      if (info.kind === 'files' || info.kind === 'all') {
        const rels = info.kind === 'all' ? listTopLevel(filesDir) : (info.paths ?? []).filter((p) => fs.existsSync(path.join(filesDir, ...p.split('/'))));
        for (const rel of rels) {
          ctx.check();
          const local = path.join(filesDir, ...rel.split('/'));
          const remoteParent = path.posix.dirname(`${SDCARD}/${rel}`);
          ctx.log(`Copying ${rel} to the phone`);
          await this.shell(serial, `mkdir -p ${shQuote(remoteParent)}`);
          const r = await this.adb(serial, ['push', '--sync', local, `${remoteParent}/`], { timeoutMs: 0, signal: ctx.signal, onLine: (l) => /error|fail/i.test(l) && ctx.log(l) });
          if (r.code !== 0) ctx.log(`⚠ ${rel}: ${r.all.trim().split('\n').pop()}`);
        }
        await this.rescanMedia(serial);
      } else if (info.kind === 'apps') {
        await this.restoreApps(ctx, serial, path.join(record.path, 'apps'), (f) => ctx.progress((step + f) / steps));
      } else if (cat === 'contacts') {
        const vcf = path.join(record.path, 'data', 'contacts.vcf');
        if (!fs.existsSync(vcf)) {
          ctx.log('No contacts in this backup.');
        } else {
          const remote = `${SDCARD}/Download/MinTransfer-contacts.vcf`;
          await this.adb(serial, ['push', vcf, remote], { signal: ctx.signal });
          await this.shell(serial, `am start -a android.intent.action.VIEW -t text/x-vcard -d ${shQuote('file://' + remote)}`).catch(() => '');
          ctx.log('Contacts file copied to Download/MinTransfer-contacts.vcf. Confirm the import on the phone (or open Contacts ▸ Import).');
        }
      } else {
        ctx.log(`${info.label}: Android does not let USB tools write this data. The exported file stays in the backup folder.`);
      }
      step++;
    }
    ctx.progress(1, 'Restore finished');
  }

  private async rescanMedia(serial: string) {
    // Android 10+: ask MediaProvider to rescan shared storage; older versions use the broadcast.
    await this.shell(serial, 'content call --uri content://media --method scan_volume --arg external_primary 2>/dev/null; am broadcast -a android.intent.action.MEDIA_MOUNTED -d file:///sdcard 2>/dev/null; true').catch(() => '');
  }

  private async restoreApps(ctx: JobContext, serial: string, appsDir: string, onFraction: (f: number) => void) {
    let pkgs: string[] = [];
    try {
      pkgs = fs.readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      ctx.log('No apps in this backup.');
      return;
    }
    let ok = 0;
    for (let i = 0; i < pkgs.length; i++) {
      ctx.check();
      onFraction(i / pkgs.length);
      ctx.detail(`Installing app ${i + 1} of ${pkgs.length}: ${pkgs[i]}`);
      const dir = path.join(appsDir, pkgs[i]);
      const apks = fs.readdirSync(dir).filter((f) => f.endsWith('.apk')).sort((a, b) => (a === 'base.apk' ? -1 : b === 'base.apk' ? 1 : a.localeCompare(b))).map((f) => path.join(dir, f));
      if (!apks.length) continue;
      const r = await this.adb(serial, [apks.length > 1 ? 'install-multiple' : 'install', '-r', ...apks], { timeoutMs: 600000, signal: ctx.signal });
      if (/Success/.test(r.all)) ok++;
      else ctx.log(`⚠ ${pkgs[i]}: ${r.all.trim().split('\n').pop()}`);
    }
    ctx.log(`Installed ${ok} of ${pkgs.length} apps. If nothing happened, allow "Install via USB" in Developer options and confirm on the phone.`);
  }

  // ---------------------------------------------------------------- recover

  async scanTrash(ctx: JobContext, serial: string): Promise<TrashItem[]> {
    ctx.progress(null, 'Searching the phone for deleted files that are still recoverable…');
    const r = await this.adb(serial, ['shell', trashScanCommand()], { timeoutMs: 600000, signal: ctx.signal, maxBuffer: 256 * 1024 * 1024 });
    const items = parseTrashScan(r.stdout);
    ctx.progress(1, `Found ${items.length.toLocaleString()} recoverable file(s)`);
    return items;
  }

  async pullFiles(ctx: JobContext, serial: string, items: TrashItem[], dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true });
    const used = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      ctx.check();
      const it = items[i];
      ctx.progress(i / items.length, `Recovering ${i + 1} of ${items.length}: ${it.name}`);
      const folder = path.join(dest, it.source.replace(/[<>:"/\\|?*]/g, '-'));
      fs.mkdirSync(folder, { recursive: true });
      let name = it.name.replace(/[<>:"/\\|?*]/g, '_') || `file-${i}`;
      while (used.has(path.join(folder, name).toLowerCase()) || fs.existsSync(path.join(folder, name))) name = `${i}-${name}`;
      used.add(path.join(folder, name).toLowerCase());
      const r = await this.adb(serial, ['pull', '-a', it.path, path.join(folder, name)], { timeoutMs: 600000, signal: ctx.signal });
      if (r.code !== 0) ctx.log(`⚠ ${it.path}: ${r.all.trim().split('\n').pop()}`);
    }
    ctx.progress(1, `Recovered ${items.length} file(s)`);
  }

  // ---------------------------------------------------------------- phone manager

  /** Folders searched for each media view. Camera videos live in DCIM next to photos. */
  private static MEDIA_DIRS: Record<MediaView, string[]> = {
    photos: ['DCIM', 'Pictures'],
    videos: ['DCIM', 'Pictures', 'Movies'],
    music: ['Music', 'Podcasts', 'Audiobooks', 'Ringtones', 'Notifications', 'Alarms', 'Recordings', 'Download'],
  };

  async listMedia(serial: string, view: MediaView, signal?: AbortSignal): Promise<RemoteFile[]> {
    const dirs = AndroidService.MEDIA_DIRS[view].map((d) => shQuote(`${SDCARD}/${d}`));
    // Hidden folders (.thumbnails, .trashed-…) are left out.
    const cmd = `for d in ${dirs.join(' ')}; do [ -d "$d" ] && find "$d" -type f -not -path '*/.*' -exec stat -c '%s|%Y|%n' {} + ; done 2>/dev/null; true`;
    const out = await this.shell(serial, cmd, { timeoutMs: 300000, signal, maxBuffer: 256 * 1024 * 1024 });
    const kind = VIEW_KIND[view];
    return parseStatLines(out)
      .filter((f) => f.size > 0 && mediaKind(f.path) === kind)
      .sort((a, b) => b.mtime - a.mtime);
  }

  async listDir(serial: string, dir: string): Promise<RemoteFile[]> {
    const d = safeRemote(dir);
    const out = await this.shell(serial, `find ${shQuote(d)} -mindepth 1 -maxdepth 1 -exec stat -L -c '%F|%s|%Y|%n' {} + 2>/dev/null; true`, { timeoutMs: 60000 });
    return parseStatTypeLines(out).sort((a, b) => Number(b.dir) - Number(a.dir) || a.path.localeCompare(b.path));
  }

  /** Every file below the given folders (for exporting folders from Explorer). */
  async walk(serial: string, dirs: string[]): Promise<RemoteFile[]> {
    if (!dirs.length) return [];
    const out = await this.shell(serial, `find ${dirs.map((d) => shQuote(safeRemote(d))).join(' ')} -type f -exec stat -c '%s|%Y|%n' {} + 2>/dev/null; true`, {
      timeoutMs: 300000,
      maxBuffer: 256 * 1024 * 1024,
    });
    return parseStatLines(out);
  }

  /** Copies files off the phone. adb pull takes many files per call, so files are batched per folder. */
  async copyFrom(ctx: JobContext, serial: string, items: CopyItem[]): Promise<{ files: number; failed: number }> {
    const total = items.reduce((n, i) => n + i.size, 0) || 1;
    let done = 0;
    let files = 0;
    let failed = 0;
    const groups = new Map<string, CopyItem[]>();
    for (const it of items) {
      const key = `${path.posix.dirname(it.remote)}\n${path.dirname(it.local)}`;
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
    for (const group of groups.values()) {
      const localDir = path.dirname(group[0].local);
      fs.mkdirSync(localDir, { recursive: true });
      for (const part of chunk(group, 25)) {
        ctx.check();
        // adb names pulled files after the source, so only same-named targets can be batched.
        const same = part.filter((p) => path.basename(p.local) === path.posix.basename(p.remote));
        const renamed = part.filter((p) => !same.includes(p));
        if (same.length) {
          const r = await this.adb(serial, ['pull', '-a', ...same.map((p) => p.remote), localDir], { timeoutMs: 0, signal: ctx.signal });
          if (r.code !== 0) ctx.log(r.all.trim().split('\n').slice(-1)[0]);
        }
        for (const p of renamed) {
          const r = await this.adb(serial, ['pull', '-a', p.remote, p.local], { timeoutMs: 0, signal: ctx.signal });
          if (r.code !== 0) ctx.log(r.all.trim().split('\n').slice(-1)[0]);
        }
        for (const p of part) {
          if (fs.existsSync(p.local)) files++;
          else failed++;
          done += p.size;
        }
        ctx.progress(Math.min(0.99, done / total), `Copied ${files.toLocaleString()} of ${items.length.toLocaleString()} files`);
      }
    }
    return { files, failed };
  }

  /** Copies files from this computer into a folder on the phone. */
  async copyTo(ctx: JobContext, serial: string, locals: string[], remoteDir: string): Promise<number> {
    const dir = safeRemote(remoteDir);
    await this.shell(serial, `mkdir -p ${shQuote(dir)}`);
    let n = 0;
    for (let i = 0; i < locals.length; i++) {
      ctx.check();
      ctx.progress(i / locals.length, `Copying ${path.basename(locals[i])} (${i + 1} of ${locals.length})`);
      const r = await this.adb(serial, ['push', locals[i], `${dir}/`], { timeoutMs: 0, signal: ctx.signal });
      if (r.code === 0) n++;
      else ctx.log(`⚠ ${path.basename(locals[i])}: ${r.all.trim().split('\n').pop()}`);
    }
    await this.rescanMedia(serial);
    return n;
  }

  async remove(serial: string, paths: string[], ctx?: JobContext): Promise<void> {
    const parts = chunk(paths.map(safeRemote), 50);
    for (let i = 0; i < parts.length; i++) {
      ctx?.check();
      ctx?.progress(i / parts.length, `Deleted ${(i * 50).toLocaleString()} of ${paths.length.toLocaleString()}`);
      await this.shell(serial, `rm -rf -- ${parts[i].map(shQuote).join(' ')}; true`, { timeoutMs: 120000, signal: ctx?.signal });
    }
    await this.rescanMedia(serial);
  }


  async apps(serial: string): Promise<PhoneApp[]> {
    const pkgs = parsePackageList(await this.shell(serial, 'pm list packages -3 -f')).filter((p) => isSafePackageName(p.name));
    const sizes = new Map<string, number>();
    const apks = pkgs.map((p) => p.apk).filter(Boolean);
    for (const part of chunk(apks, 60)) {
      for (const f of parseStatLines(await this.shell(serial, `stat -c '%s|%Y|%n' ${part.map(shQuote).join(' ')} 2>/dev/null; true`))) sizes.set(f.path, f.size);
    }
    return pkgs.map((p) => ({ id: p.name, name: p.name, version: '', apk: p.apk, size: sizes.get(p.apk) }));
  }

  /** Saves the APKs (base + splits) of the given apps into dir/<package>/. */
  async exportApps(ctx: JobContext, serial: string, ids: string[], dir: string): Promise<number> {
    let ok = 0;
    for (let i = 0; i < ids.length; i++) {
      ctx.check();
      if (!isSafePackageName(ids[i])) continue;
      ctx.progress(i / ids.length, `Saving ${ids[i]} (${i + 1} of ${ids.length})`);
      const dest = path.join(dir, ids[i]);
      fs.mkdirSync(dest, { recursive: true });
      let good = true;
      for (const apk of parsePmPath(await this.shell(serial, `pm path ${ids[i]}`))) {
        const r = await this.adb(serial, ['pull', apk, path.join(dest, path.posix.basename(apk))], { timeoutMs: 600000, signal: ctx.signal });
        if (r.code !== 0) good = false;
      }
      if (good) ok++;
      else ctx.log(`Could not copy ${ids[i]}`);
    }
    return ok;
  }

  async installApks(ctx: JobContext, serial: string, files: string[]): Promise<number> {
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      ctx.check();
      ctx.progress(i / files.length, `Installing ${path.basename(files[i])} (${i + 1} of ${files.length})`);
      const r = await this.adb(serial, ['install', '-r', files[i]], { timeoutMs: 600000, signal: ctx.signal });
      if (/Success/.test(r.all)) ok++;
      else ctx.log(`⚠ ${path.basename(files[i])}: ${r.all.trim().split('\n').pop()}`);
    }
    return ok;
  }

  async uninstall(serial: string, id: string): Promise<void> {
    if (!isSafePackageName(id)) throw new Error('Invalid app id');
    const r = await this.adb(serial, ['uninstall', id], { timeoutMs: 120000 });
    if (!/Success/.test(r.all)) throw new Error(`Android didn’t remove ${id}: ${r.all.trim().split('\n').pop()}`);
  }

  /** Exports contacts / call log / SMS / apps / file categories for Transfer ▸ Information and Home. */
  async exportData(ctx: JobContext, serial: string, item: TransferItemId, out: string): Promise<CategoryResult> {
    const label = TRANSFER_ITEMS.find((t) => t.id === item)?.label ?? item;
    if (item === 'contacts' || item === 'calls' || item === 'messages') return { id: item, label, ...(await this.backupProvider(ctx, serial, item, out)) };
    if (item === 'apps') return { id: item, label, ...(await this.backupApps(ctx, serial, path.join(out, 'Apps'), (f) => ctx.progress(f))) };
    return { id: item, label, ...(await this.pullCategory(ctx, serial, item as AndroidCategoryId, path.join(out, label), (f) => ctx.progress(f))) };
  }

  // ---------------------------------------------------------------- erase

  async erase(ctx: JobContext, serial: string, opts: { wipeFolders: string[]; uninstallApps: boolean; rebootToRecovery: boolean }) {
    const steps = opts.wipeFolders.length + (opts.uninstallApps ? 1 : 0) + (opts.rebootToRecovery ? 1 : 0) || 1;
    let step = 0;
    for (const folder of opts.wipeFolders) {
      ctx.check();
      if (!/^[A-Za-z0-9 ._-]+(\/[A-Za-z0-9 ._-]+)?$/.test(folder) || folder.includes('..')) throw new Error(`Refusing to wipe "${folder}"`);
      ctx.progress(step / steps, `Deleting ${folder}…`);
      const target = `${SDCARD}/${folder}`;
      // Delete the contents but keep the folder itself so apps that expect it keep working.
      await this.shell(serial, `[ -d ${shQuote(target)} ] && (find ${shQuote(target)} -mindepth 1 -delete 2>/dev/null || rm -rf ${shQuote(target)}/* ${shQuote(target)}/.[!.]*); true`, { timeoutMs: 0, signal: ctx.signal });
      ctx.log(`Wiped ${target}`);
      step++;
    }
    if (opts.wipeFolders.length) await this.rescanMedia(serial);
    if (opts.uninstallApps) {
      ctx.check();
      const pkgs = parsePackageList(await this.shell(serial, 'pm list packages -3')).filter((p) => isSafePackageName(p.name));
      for (let i = 0; i < pkgs.length; i++) {
        ctx.check();
        ctx.progress((step + i / pkgs.length) / steps, `Removing app ${i + 1} of ${pkgs.length}: ${pkgs[i].name}`);
        const out = await this.shell(serial, `pm uninstall ${pkgs[i].name}`, { timeoutMs: 120000 });
        if (!/Success/.test(out)) ctx.log(`⚠ ${pkgs[i].name}: ${out.trim()}`);
      }
      step++;
    }
    if (opts.rebootToRecovery) {
      ctx.progress(step / steps, 'Restarting into recovery mode…');
      await this.adb(serial, ['reboot', 'recovery'], { timeoutMs: 30000 });
      ctx.log('The phone is restarting into recovery. Use the volume keys to choose "Wipe data/factory reset" and the power key to confirm.');
    }
    this.invalidate(serial);
    ctx.progress(1, 'Erase finished');
  }
}

function listTopLevel(filesDir: string): string[] {
  const out: string[] = [];
  try {
    for (const e of fs.readdirSync(filesDir, { withFileTypes: true })) {
      if (!e.isDirectory() && !e.isFile()) continue;
      if (e.name === 'Android') {
        if (fs.existsSync(path.join(filesDir, 'Android', 'media'))) out.push('Android/media');
      } else out.push(e.name);
    }
  } catch {
    /* empty */
  }
  return out;
}

export const ALL_ANDROID_CATEGORIES = ANDROID_CATEGORIES;

/** Only shared storage may be browsed or changed. */
export function safeRemote(p: string): string {
  const norm = path.posix.normalize(p.replace(/\/+$/, '') || '/');
  if (norm.includes('..') || !(norm === SDCARD || norm.startsWith(`${SDCARD}/`))) throw new Error(`Only shared storage (${SDCARD}) can be used: ${p}`);
  return norm;
}
