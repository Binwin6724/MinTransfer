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

  it('only deletes folders that are MinTransfer backups', () => {
    const lib = new Library(() => path.join(root, 'lib'), () => false);
    const [rec] = lib.scan();
    lib.remove(rec.id);
    expect(lib.scan()).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'lib', 'not a backup'))).toBe(true);
  });
});
