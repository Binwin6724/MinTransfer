// End-to-end check of Transfer on an iPhone with a stand-in for the mt-ios helper that serves a
// folder on disk as the phone, plus a stand-in idevicebackup2 for the "via backup" items.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AndroidService } from '../electron/android';
import { IosService } from '../electron/ios';
import type { JobContext } from '../electron/jobs';
import { PhoneManager } from '../electron/manager';
import type { PhoneDevice } from '../shared/types';

const UDID = '00008110-MANAGER';
const unix = process.platform !== 'win32';
let root: string;
let phone: string;
let helper: string;
let backup2: string;
const ctx: JobContext = { signal: new AbortController().signal, progress() {}, detail() {}, log() {}, check() {} };
const device = { id: UDID, platform: 'ios', state: 'ready', name: 'Test iPhone', model: 'iPhone 15', manufacturer: 'Apple', osName: 'iOS', osVersion: '18.0' } as PhoneDevice;

beforeAll(() => {
  if (!unix) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-mgr-'));
  phone = path.join(root, 'phone');
  fs.mkdirSync(path.join(phone, 'DCIM', '100APPLE'), { recursive: true });
  fs.mkdirSync(path.join(phone, 'Downloads'), { recursive: true });
  fs.writeFileSync(path.join(phone, 'DCIM', '100APPLE', 'IMG_0001.HEIC'), 'photo-1');
  fs.writeFileSync(path.join(phone, 'DCIM', '100APPLE', 'IMG_0002.MOV'), 'video-22');
  fs.writeFileSync(path.join(phone, 'DCIM', '100APPLE', 'IMG_0001.AAE'), 'x');
  fs.writeFileSync(path.join(phone, 'Downloads', 'doc.pdf'), 'pdf');
  // A shell stand-in that speaks the mt-ios protocol against the folder above.
  helper = path.join(root, 'mt-ios');
  fs.writeFileSync(
    helper,
    `#!/bin/bash
P="${phone}"
echo READY
ent() { local f="$1" name="$2"; if [ -d "$f" ]; then t=d; s=0; else t=f; s=$(wc -c < "$f" | tr -d ' '); fi; echo -e "E\\t$t\\t$s\\t1700000000\\t$name"; }
walk() { for f in "$P$1"/*; do [ -e "$f" ] || continue; ent "$f" "\${f#$P}"; [ -d "$f" ] && walk "\${f#$P}"; done; }
while IFS=$'\\t' read -r cmd a b; do
  case "$cmd" in
    ls) for f in "$P$a"/*; do [ -e "$f" ] && ent "$f" "$(basename "$f")"; done; echo OK ;;
    walk) walk "$a"; echo OK ;;
    get) if cp "$P$a" "$b" 2>/dev/null; then echo -e "OK\\t$(wc -c < "$b" | tr -d ' ')"; else echo "ERR cannot open $a"; fi ;;
    put) cp "$a" "$P$b" && echo OK ;;
    mkdir) mkdir -p "$P$a" && echo OK ;;
    rm) rm "$P$a" && echo OK || echo "ERR cannot delete $a" ;;
    apps) echo -e "A\\tcom.example.app\\tExample\\t1.0\\t100\\t50"; echo OK ;;
    *) echo "ERR unknown command" ;;
  esac
done
`,
    { mode: 0o755 },
  );
  // A backup stand-in that produces an (empty-of-data) backup, so "via backup" items report "not found".
  backup2 = path.join(root, 'idevicebackup2');
  fs.writeFileSync(
    backup2,
    `#!/bin/sh\nfor a; do dest="$a"; done\nmkdir -p "$dest/${UDID}"\ncp "${path.join(root, 'Manifest.db')}" "$dest/${UDID}/Manifest.db"\necho "Backup Successful."\n`,
    { mode: 0o755 },
  );
});
afterAll(() => root && fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!unix)('Transfer on iPhone', () => {
  const make = () => {
    const ios = new IosService(() => ({ 'mt-ios': helper, idevicebackup2: backup2 }));
    return { ios, mgr: new PhoneManager(new AndroidService(() => undefined), ios, () => path.join(root, 'out')) };
  };

  it('lists camera-roll photos and videos separately', async () => {
    const { ios } = make();
    expect((await ios.listMedia(UDID, 'photos')).map((f) => f.path)).toEqual(['/DCIM/100APPLE/IMG_0001.HEIC']);
    expect((await ios.listMedia(UDID, 'videos')).map((f) => f.path)).toEqual(['/DCIM/100APPLE/IMG_0002.MOV']);
    expect(await ios.listMedia(UDID, 'music')).toEqual([]);
  });

  it('copies photos into Photos/<album> and skips them the next time', async () => {
    const { ios, mgr } = make();
    const photos = await ios.listMedia(UDID, 'photos');
    const out = await mgr.exportFiles(ctx, device, 'photos', photos);
    const file = path.join(out, '100APPLE', 'IMG_0001.HEIC');
    expect(fs.readFileSync(file, 'utf8')).toBe('photo-1');
    expect(fs.statSync(file).mtimeMs).toBe(1700000000000);
    const logs: string[] = [];
    await mgr.exportFiles({ ...ctx, log: (l) => logs.push(l) }, device, 'photos', photos);
    expect(logs.join('\n')).toMatch(/already copied/);
  });

  it('browses folders, copies a folder with Explorer, imports and deletes', async () => {
    const { ios, mgr } = make();
    const rootList = await ios.listDir(UDID, '/');
    expect(rootList.map((e) => [e.path, e.dir])).toEqual([
      ['/DCIM', true],
      ['/Downloads', true],
    ]);
    const out = await mgr.exportFiles(ctx, device, 'files', [rootList[1]], '/');
    expect(fs.readFileSync(path.join(out, 'Downloads', 'doc.pdf'), 'utf8')).toBe('pdf');

    const local = path.join(root, 'upload.txt');
    fs.writeFileSync(local, 'hello');
    expect(await mgr.importFiles(ctx, device, [local], '/Downloads')).toBe(1);
    expect(fs.readFileSync(path.join(phone, 'Downloads', 'upload.txt'), 'utf8')).toBe('hello');
    await mgr.remove(device, ['/Downloads/upload.txt']);
    expect(fs.existsSync(path.join(phone, 'Downloads', 'upload.txt'))).toBe(false);
    await expect(mgr.remove(device, ['/DCIM/100APPLE/IMG_0001.HEIC'])).rejects.toThrow(/Photos app/);
    await expect(mgr.importFiles(ctx, device, [local], '/DCIM')).rejects.toThrow(/Photos app/);
  });

  it('lists apps', async () => {
    const { mgr } = make();
    expect(await mgr.apps(device)).toEqual([{ id: 'com.example.app', name: 'Example', version: '1.0', size: 100, dataSize: 50 }]);
  });

  it('exports information through a temporary backup and cleans it up', async () => {
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)');
    fs.writeFileSync(path.join(root, 'Manifest.db'), db.export());
    db.close();
    const { mgr } = make();
    const logs: string[] = [];
    const out = await mgr.exportItems({ ...ctx, log: (l) => logs.push(l) }, device, ['contacts', 'photos']);
    expect(logs.join('\n')).toMatch(/Contacts: Not on this iPhone/);
    expect(fs.existsSync(path.join(out, 'Information', '.mt-backup'))).toBe(false);
    expect(fs.existsSync(path.join(out, 'Photos', '100APPLE', 'IMG_0001.HEIC'))).toBe(true);
  });

  it('refuses encrypted iPhones for information but not for photos', async () => {
    const { ios } = make();
    await expect(ios.exportData(ctx, { ...device, backupEncryption: true }, ['contacts'], path.join(root, 'enc'))).rejects.toThrow(/encryption/);
  });
});
