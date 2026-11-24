import { describe, expect, it } from 'vitest';
import { byFolder, chunk, helperCommand, HelperParser, parseStatLines, parseStatTypeLines, transferItemsFor } from '../shared/transfer';
import { mediaKind } from '../shared/ios';

describe('mt-ios helper protocol', () => {
  it('splits output into one reply per command', () => {
    const seen: number[] = [];
    const p = new HelperParser(['/DCIM', null, null, null], (i) => seen.push(i));
    for (const l of [
      'READY',
      'E\td\t96\t1700000000\t100APPLE',
      'E\tf\t12\t1700000001\tnote with spaces.txt',
      'OK',
      'E\tf\t5\t1700000002\t/DCIM/100APPLE/IMG_1.HEIC',
      'OK',
      'OK\t2048',
      'ERR cannot open /x',
    ])
      p.line(l);
    expect(p.ready).toBe(true);
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(p.replies[0].entries).toEqual([
      { path: '/DCIM/100APPLE', dir: true, size: 96, mtime: 1700000000000 },
      { path: '/DCIM/note with spaces.txt', dir: false, size: 12, mtime: 1700000001000 },
    ]);
    expect(p.replies[1].entries[0].path).toBe('/DCIM/100APPLE/IMG_1.HEIC');
    expect(p.replies[2]).toMatchObject({ ok: true, bytes: 2048 });
    expect(p.replies[3]).toMatchObject({ ok: false, error: 'cannot open /x' });
  });

  it('reads app lists and root listings', () => {
    const p = new HelperParser(['/', null]);
    p.line('READY');
    p.line('E\td\t0\t0\tDCIM');
    p.line('OK');
    p.line('A\tcom.example.app\tExample\t2.1\t1000\t500');
    p.line('OK');
    expect(p.replies[0].entries[0].path).toBe('/DCIM');
    expect(p.replies[1].apps).toEqual([{ id: 'com.example.app', name: 'Example', version: '2.1', size: 1000, dataSize: 500 }]);
  });

  it('turns FATAL into an error and refuses unsafe fields', () => {
    const p = new HelperParser([]);
    expect(() => p.line('FATAL No device found')).toThrow('No device found');
    expect(helperCommand('get', '/a b', '/c')).toBe('get\t/a b\t/c');
    expect(() => helperCommand('get', 'a\tb')).toThrow();
  });
});

describe('Android listings', () => {
  it('parses stat output with and without types', () => {
    expect(parseStatLines('123|1700000000|/sdcard/DCIM/Camera/a b.jpg\njunk')).toEqual([{ path: '/sdcard/DCIM/Camera/a b.jpg', size: 123, mtime: 1700000000000, dir: false }]);
    expect(parseStatTypeLines('directory|4096|1700000000|/sdcard/DCIM\nregular file|10|1700000001|/sdcard/x.txt')).toEqual([
      { path: '/sdcard/DCIM', dir: true, size: 4096, mtime: 1700000000000 },
      { path: '/sdcard/x.txt', dir: false, size: 10, mtime: 1700000001000 },
    ]);
  });
});

describe('helpers', () => {
  it('chunks, groups and classifies', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    const g = byFolder([
      { path: '/a/1', size: 1, mtime: 0, dir: false },
      { path: '/a/2', size: 1, mtime: 0, dir: false },
      { path: '/b/3', size: 1, mtime: 0, dir: false },
    ]);
    expect([...g.keys()]).toEqual(['/a', '/b']);
    expect(mediaKind('song.MP3')).toBe('audio');
    expect(transferItemsFor('ios').map((i) => i.id)).not.toContain('music');
    expect(transferItemsFor('android').map((i) => i.id)).toContain('apps');
  });
});
