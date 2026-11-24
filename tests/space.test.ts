import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { serveFile } from '../electron/serve';
import { explainDiskError, spaceProblem } from '../shared/export';

const GB = 1024 ** 3;

describe('free space checks', () => {
  it('flags copies that would leave less than 1 GB free', () => {
    expect(spaceProblem(null, 10 * GB)).toBeNull();
    expect(spaceProblem(20 * GB, 10 * GB)).toBeNull();
    expect(spaceProblem(10.5 * GB, 10 * GB)).toMatch(/needs about 10\.0 GB but only 10\.5 GB is free/);
    expect(spaceProblem(5 * GB, 0)).toBeNull();
  });

  it('explains a full disk', () => {
    expect(explainDiskError('ENOSPC: no space left on device, write')).toMatch(/drive is full/);
    expect(explainDiskError('Not enough space on this computer: …')).toBe('Not enough space on this computer: …');
    expect(explainDiskError('Cancelled')).toBe('Cancelled');
  });
});

describe('preview file serving', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mt-serve-')), 'clip.mp4');
  fs.writeFileSync(file, '0123456789');

  it('serves whole files and byte ranges so videos can seek', async () => {
    const all = serveFile(file, null);
    expect([all.status, all.headers.get('content-type'), await all.text()]).toEqual([200, 'video/mp4', '0123456789']);
    const part = serveFile(file, 'bytes=2-5');
    expect([part.status, part.headers.get('content-range'), await part.text()]).toEqual([206, 'bytes 2-5/10', '2345']);
    const open = serveFile(file, 'bytes=7-');
    expect(await open.text()).toBe('789');
    const tail = serveFile(file, 'bytes=-3');
    expect(await tail.text()).toBe('789');
    expect(serveFile(file, 'bytes=20-').status).toBe(416);
    expect(serveFile(file + '.missing', null).status).toBe(404);
  });
});
