import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { META_FILE } from '../electron/android';
import type { JobContext } from '../electron/jobs';
import { Library } from '../electron/library';
import type { BackupRecord } from '../shared/types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-lib-'));
const ctx: JobContext = { signal: new AbortController().signal, progress() {}, detail() {}, log() {}, check() {} };
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function makeAndroidBackup(name: string): string {
  const dir = path.join(root, 'lib', name);
  fs.mkdirSync(path.join(dir, 'files', 'DCIM', 'Camera'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'files', 'DCIM', 'Camera', 'a.jpg'), 'A');
  fs.writeFileSync(path.join(dir, 'data', 'contacts.vcf'), 'BEGIN:VCARD\r\nEND:VCARD\r\n');
  const rec: BackupRecord = {
    id: name, platform: 'android', source: 'mintransfer', deviceId: 'SER1', deviceName: 'Pixel', deviceModel: 'Google Pixel 8', osVersion: '15',
    createdAt: 1, path: '/moved/elsewhere', dataPath: '/moved/elsewhere', sizeBytes: 30, encrypted: false, complete: true,
    categories: [{ id: 'photos', label: 'Photos', files: 1, bytes: 1 }, { id: 'contacts', label: 'Contacts', files: 1, bytes: 20 }, { id: 'calls', label: 'Call log', files: 0, bytes: 0, warning: 'blocked' }],
  };
  fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(rec));
  return dir;
}

describe('backup library', () => {
  it('finds MinTransfer backups even after the folder moved', () => {
    const dir = makeAndroidBackup('Pixel 2026-01-01 000000');
    fs.mkdirSync(path.join(root, 'lib', 'not a backup'));
    const lib = new Library(() => path.join(root, 'lib'), () => false);
    const list = lib.scan();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe(dir);
    expect(list[0].id).toBe('mt:Pixel 2026-01-01 000000');
  });

  it('lists groups and extracts files', async () => {
    const lib = new Library(() => path.join(root, 'lib'), () => false);
    const [rec] = lib.scan();
    const groups = await lib.groups(rec.id);
    expect(groups.map((g) => [g.id, g.available])).toEqual([['photos', true], ['contacts', true], ['calls', false]]);
    const out = await lib.extract(ctx, rec.id, ['photos', 'contacts'], path.join(root, 'out'));
    expect(fs.readFileSync(path.join(out, 'Photos', 'DCIM', 'Camera', 'a.jpg'), 'utf8')).toBe('A');
    expect(fs.existsSync(path.join(out, 'contacts.vcf'))).toBe(true);
  });

  it('browses and extracts iPhone "chosen items" backups', async () => {
    const dir = path.join(root, 'lib', 'iPhone 2026-02-01 000000');
    fs.mkdirSync(path.join(dir, 'Photos', '100APPLE'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Photos', '100APPLE', 'IMG_1.HEIC'), 'P');
    fs.writeFileSync(path.join(dir, 'Contacts.vcf'), 'V');
    fs.writeFileSync(path.join(dir, 'Contacts.csv'), 'C');
    const rec: BackupRecord = {
      id: 'x', platform: 'ios', source: 'mintransfer', deviceId: 'UDID1', deviceName: 'iPhone', deviceModel: 'iPhone 15', osVersion: '18.0',
      createdAt: 2, path: dir, dataPath: dir, sizeBytes: 3, encrypted: false, complete: true, kind: 'items',
      categories: [
        { id: 'images', label: 'Photos', files: 1, bytes: 1, paths: ['Photos'] },
        { id: 'contacts', label: 'Contacts', files: 2, bytes: 2, paths: ['Contacts.vcf', 'Contacts.csv'] },
        { id: 'notes', label: 'Notes', files: 0, bytes: 0, paths: [], warning: 'Nothing found on this iPhone' },
      ],
    };
    fs.writeFileSync(path.join(dir, META_FILE), JSON.stringify(rec));
    const lib = new Library(() => path.join(root, 'lib'), () => false);
    const found = lib.scan().find((b) => b.deviceId === 'UDID1')!;
    expect(found.dataPath).toBe(dir);
    const groups = await lib.groups(found.id);
    expect(groups.map((g) => [g.id, g.available])).toEqual([['images', true], ['contacts', true], ['notes', false]]);
    const out = await lib.extract(ctx, found.id, ['images', 'contacts'], path.join(root, 'out-ios'));
    expect(fs.readFileSync(path.join(out, 'Photos', '100APPLE', 'IMG_1.HEIC'), 'utf8')).toBe('P');
    expect(fs.existsSync(path.join(out, 'Contacts.vcf'))).toBe(true);
    fs.rmSync(dir, { recursive: true });
  });

  it('only deletes folders that are MinTransfer backups', () => {
    const lib = new Library(() => path.join(root, 'lib'), () => false);
    const [rec] = lib.scan();
    lib.remove(rec.id);
    expect(lib.scan()).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'lib', 'not a backup'))).toBe(true);
  });
});
