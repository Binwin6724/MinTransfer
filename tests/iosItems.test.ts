// End-to-end check of the iPhone "choose items" backup with a stand-in idevicebackup2 that
// writes a small synthetic backup, so the whole flow runs without a phone.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plist from 'plist';
import initSqlJs from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { META_FILE } from '../electron/android';
import { IosService } from '../electron/ios';
import type { JobContext } from '../electron/jobs';
import type { BackupRecord, PhoneDevice } from '../shared/types';

const UDID = '00008110-ITEMS';
const unix = process.platform !== 'win32';
let root: string;
let fakeTool: string;
const ctx: JobContext = { signal: new AbortController().signal, progress() {}, detail() {}, log() {}, check() {} };
const device: PhoneDevice = {
  id: UDID, platform: 'ios', state: 'ready', name: 'Test iPhone', model: 'iPhone 15', osName: 'iOS', osVersion: '18.0', wireless: false,
} as PhoneDevice;

beforeAll(async () => {
  if (!unix) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-items-'));
  const fixture = path.join(root, 'fixture');
  fs.mkdirSync(fixture);
  fs.writeFileSync(path.join(fixture, 'Manifest.plist'), plist.build({ IsEncrypted: false }));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)');
  for (const [rel, data] of [['Media/DCIM/100APPLE/IMG_0001.HEIC', 'photo'], ['Media/DCIM/100APPLE/IMG_0002.MOV', 'video'], ['Media/DCIM/100APPLE/IMG_0001.AAE', 'edit']]) {
    const id = crypto.createHash('sha1').update(`CameraRollDomain-${rel}`).digest('hex');
    fs.mkdirSync(path.join(fixture, id.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(fixture, id.slice(0, 2), id), data);
    db.run("INSERT INTO Files VALUES (?, 'CameraRollDomain', ?, 1, NULL)", [id, rel]);
  }
  fs.writeFileSync(path.join(fixture, 'Manifest.db'), db.export());
  db.close();
  fakeTool = path.join(root, 'idevicebackup2');
  fs.writeFileSync(fakeTool, `#!/bin/sh\nfor a; do dest="$a"; done\nmkdir -p "$dest/${UDID}"\ncp -R "${fixture}/." "$dest/${UDID}/"\necho "Backup Successful."\n`, { mode: 0o755 });
});
afterAll(() => root && fs.rmSync(root, { recursive: true, force: true }));

describe.skipIf(!unix)('iPhone chosen-items backup', () => {
  it('saves only the chosen items and removes the temporary full backup', async () => {
    const ios = new IosService(() => ({ idevicebackup2: fakeTool }));
    const dir = path.join(root, 'out1');
    const rec = await ios.backupItems(ctx, device, dir, ['images', 'contacts'], {});
    expect(rec.kind).toBe('items');
    expect(rec.complete).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'Photos', '100APPLE'))).toEqual(['IMG_0001.HEIC']);
    expect(fs.existsSync(path.join(dir, 'Videos'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.staging'))).toBe(false);
    expect(fs.existsSync(path.join(dir, UDID))).toBe(false);
    const photos = rec.categories.find((c) => c.id === 'images')!;
    expect([photos.files, photos.paths]).toEqual([1, ['Photos']]);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')) as BackupRecord;
    expect(saved.categories.map((c) => c.id)).toEqual(['images', 'contacts']);
  });

  it('can keep the full backup as a restorable copy', async () => {
    const ios = new IosService(() => ({ idevicebackup2: fakeTool }));
    const dir = path.join(root, 'out2');
    const rec = await ios.backupItems(ctx, device, dir, ['videos'], { keepFull: true });
    expect(rec.kind).toBe('full');
    expect(rec.dataPath).toBe(path.join(dir, UDID));
    expect(fs.existsSync(path.join(dir, UDID, 'Manifest.db'))).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'Videos', '100APPLE'))).toEqual(['IMG_0002.MOV']);
  });

  it('refuses when backup encryption is on', async () => {
    const ios = new IosService(() => ({ idevicebackup2: fakeTool }));
    await expect(ios.backupItems(ctx, { ...device, backupEncryption: true }, path.join(root, 'out3'), ['images'], {})).rejects.toThrow(/encryption/);
  });
});
