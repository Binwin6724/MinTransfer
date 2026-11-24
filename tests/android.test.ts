import { describe, expect, it } from 'vitest';
import {
  androidModelName,
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
  recoveredName,
  shQuote,
  trashSource,
} from '../shared/android';

describe('adb devices', () => {
  it('parses states, models and transports', () => {
    const out = `List of devices attached
R58M1234ABC            device usb:1-1 product:beyond1qltesq model:SM_G973U device:beyond1q transport_id:1
emulator-5554          unauthorized transport_id:2
192.168.1.20:5555      device product:panther model:Pixel_7 device:panther transport_id:3
0123456789ABCDEF       offline transport_id:4
XYZ                    no permissions (missing udev rules? user is in the plugdev group); see [http://developer.android.com/tools/device.html]
ABC                    recovery transport_id:5
`;
    const list = parseAdbDevices(out);
    expect(list).toHaveLength(6);
    expect(list[0]).toMatchObject({ serial: 'R58M1234ABC', state: 'ready', model: 'SM G973U', wireless: false });
    expect(list[1].state).toBe('unauthorized');
    expect(list[1].stateDetail).toMatch(/Allow/);
    expect(list[2]).toMatchObject({ state: 'ready', model: 'Pixel 7', wireless: true });
    expect(list[3].state).toBe('offline');
    expect(list[4].state).toBe('unauthorized');
    expect(list[5].state).toBe('recovery');
  });
  it('ignores daemon chatter', () => {
    expect(parseAdbDevices('* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\n\n')).toEqual([]);
  });
});

describe('device properties', () => {
  const props = parseGetprop('[ro.product.model]: [SM-S918B]\n[ro.product.manufacturer]: [samsung]\n[ro.build.version.release]: [14]\n[ro.product.marketname]: []\n');
  it('parses getprop', () => {
    expect(props['ro.product.model']).toBe('SM-S918B');
    expect(props['ro.build.version.release']).toBe('14');
  });
  it('builds a friendly name', () => {
    expect(androidModelName(props).model).toBe('Samsung SM-S918B');
    expect(androidModelName({ 'ro.product.manufacturer': 'Google', 'ro.product.model': 'Pixel 8' }).model).toBe('Google Pixel 8');
    expect(androidModelName({ 'ro.product.manufacturer': 'Xiaomi', 'ro.product.marketname': 'Xiaomi 14' }).model).toBe('Xiaomi 14');
    expect(androidModelName({ 'ro.product.manufacturer': 'LGE', 'ro.product.model': 'LM-G900' }).manufacturer).toBe('LGE');
  });
  it('parses battery', () => {
    expect(parseBattery('Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  status: 2\n  level: 87\n')).toEqual({ level: 87, charging: true });
    expect(parseBattery('  AC powered: false\n  USB powered: false\n  status: 3\n  level: 40\n')).toEqual({ level: 40, charging: false });
  });
  it('parses df', () => {
    expect(parseDf('Filesystem     1K-blocks     Used Available Use% Mounted on\n/dev/block/dm-48 115602320 40000000  75500000  35% /data\n')).toEqual({ total: 115602320 * 1024, free: 75500000 * 1024 });
    expect(parseDf('garbage')).toBeNull();
  });
});

describe('packages', () => {
  it('parses pm list packages -f with = in paths', () => {
    const list = parsePackageList('package:/data/app/~~a1b2==/com.whatsapp-Zx9==/base.apk=com.whatsapp\npackage:/data/app/com.spotify.music-1/base.apk=com.spotify.music\n');
    expect(list).toEqual([
      { name: 'com.spotify.music', apk: '/data/app/com.spotify.music-1/base.apk' },
      { name: 'com.whatsapp', apk: '/data/app/~~a1b2==/com.whatsapp-Zx9==/base.apk' },
    ]);
  });
  it('orders split APKs with base first', () => {
    expect(parsePmPath('package:/d/split_config.arm64_v8a.apk\npackage:/d/base.apk\npackage:/d/split_config.en.apk\n')).toEqual(['/d/base.apk', '/d/split_config.arm64_v8a.apk', '/d/split_config.en.apk']);
  });
  it('rejects unsafe package names', () => {
    expect(isSafePackageName('com.example.app')).toBe(true);
    expect(isSafePackageName('com.example;rm -rf /')).toBe(false);
    expect(isSafePackageName('single')).toBe(false);
  });
});

describe('content providers', () => {
  it('parses rows whose values contain commas, equals signs and newlines', () => {
    const out = 'Row: 0 address=+15551234, date=1700000000000, type=1, read=1, body=Hi, are you free? a=b\nsecond line\nRow: 1 address=Bank, date=1700000001000, type=2, read=0, body=NULL\n';
    const rows = parseContentRows(out, ['address', 'date', 'type', 'read', 'body']);
    expect(rows).toHaveLength(2);
    expect(rows[0].body).toBe('Hi, are you free? a=b\nsecond line');
    expect(rows[0].address).toBe('+15551234');
    expect(rows[1].body).toBe('');
    expect(rows[1].type).toBe('2');
  });
  it('detects permission denials', () => {
    expect(isProviderDenied('Error while accessing provider:sms\njava.lang.SecurityException: Permission Denial: opening provider')).toBe(true);
    expect(isProviderDenied('Row: 0 a=b')).toBe(false);
  });
});

describe('categories and trash', () => {
  it('expands categories to folders', () => {
    expect(pathsForCategories(['photos', 'videos'])).toEqual(['DCIM', 'Pictures', 'Movies']);
    expect(pathsForCategories(['photos', 'storage'])).toEqual(['']);
  });
  it('parses the trash scan', () => {
    const items = parseTrashScan(
      '2048|1700000000|/sdcard/DCIM/Camera/.trashed-1702592000-IMG_0001.jpg\n0|1700000000|/sdcard/empty\n512|1700000100|/sdcard/DCIM/.thumbnails/123.jpg\n900|1700000050|/sdcard/Android/data/com.sec.android.gallery3d/files/.Trash/abc\n',
    );
    expect(items.map((i) => i.name)).toEqual(['123.jpg', 'abc', 'IMG_0001.jpg']);
    expect(items[0].source).toMatch(/Thumbnail/);
    expect(items[1].source).toMatch(/Samsung/);
    expect(items[2].source).toMatch(/Recently deleted/);
    expect(items[2].mtime).toBe(1700000000000);
  });
  it('names recovered files', () => {
    expect(recoveredName('/sdcard/DCIM/.trashed-1712345678-My photo.jpg')).toBe('My photo.jpg');
    expect(trashSource('/sdcard/MIUI/Gallery/cloud/.trashBin/x.jpg')).toMatch(/Xiaomi/);
  });
  it('quotes shell arguments', () => {
    expect(shQuote("it's here")).toBe(`'it'\\''s here'`);
  });
});
