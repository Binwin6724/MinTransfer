import { describe, expect, it } from 'vitest';
import { appleModelName, appleTime, classifyLockdownError, explainBackupError, parseBackupProgress, parseKeyValues, parseUdidList } from '../shared/ios';

describe('libimobiledevice parsers', () => {
  it('parses ideviceinfo key/values and skips nested entries', () => {
    const kv = parseKeyValues('DeviceName: Ana’s iPhone\nProductType: iPhone15,2\nProductVersion: 17.5.1\nNonVolatileRAM:\n auto-boot: dHJ1ZQ==\nSerialNumber: F2LXXXX\n');
    expect(kv).toMatchObject({ DeviceName: 'Ana’s iPhone', ProductType: 'iPhone15,2', ProductVersion: '17.5.1', SerialNumber: 'F2LXXXX' });
    expect(kv['auto-boot']).toBeUndefined();
  });
  it('parses UDID lists and prefers USB', () => {
    expect(parseUdidList('00008110-001A2B3C4D5E801E\n')).toEqual([{ udid: '00008110-001A2B3C4D5E801E', wireless: false }]);
    expect(parseUdidList('00008110-001A2B3C4D5E801E (Network)\n00008110-001A2B3C4D5E801E (USB)\n')).toEqual([{ udid: '00008110-001A2B3C4D5E801E', wireless: false }]);
    expect(parseUdidList('ERROR: Unable to retrieve device list!\n')).toEqual([]);
  });
  it('classifies lockdown errors', () => {
    expect(classifyLockdownError('ERROR: Could not connect to lockdownd: Pairing dialog response pending (-19)').state).toBe('untrusted');
    expect(classifyLockdownError('ERROR: Could not validate with device because a passcode is set.').state).toBe('locked');
    expect(classifyLockdownError('ERROR: Could not connect to lockdownd: Invalid HostID (-21)').state).toBe('untrusted');
    expect(classifyLockdownError('No device found with udid X.').state).toBe('offline');
  });
  it('reads backup progress', () => {
    expect(parseBackupProgress('[=====================                             ]  42% Finished')).toBeCloseTo(0.42);
    expect(parseBackupProgress('Receiving files')).toBeNull();
  });
  it('explains backup failures', () => {
    expect(explainBackupError('ERROR: Restore Failed (Error Code 211): Find My iPhone is enabled')).toMatch(/Find My/);
    expect(explainBackupError('ERROR: something odd happened')).toBe('something odd happened');
    // Error 105 comes after a "waiting for passcode" line; the space problem must win.
    const log105 = [
      'Backup directory is "/Users/someone/Documents/MinTransfer/iPhone/Information/.mt-backup"',
      'Started "com.apple.mobilebackup2" service on port 64229.',
      'Full backup mode.',
      '*** Waiting for passcode to be entered on the device ***',
      'ErrorCode 105: Insufficient free disk space on drive to back up (MBErrorDomain/105)',
      'Received 0 files from device.',
      'Backup Failed (Error Code 105).',
    ].join('\n');
    expect(explainBackupError(log105)).toMatch(/Not enough free space on this computer/);
    expect(explainBackupError('*** Waiting for passcode to be entered on the device ***\nERROR: Device is locked')).toMatch(/Unlock the iPhone/);
    expect(explainBackupError('*** Waiting for passcode to be entered on the device ***')).toMatch(/Unlock the iPhone/);
  });
  it('names models', () => {
    expect(appleModelName('iPhone16,2')).toBe('iPhone 15 Pro Max');
    expect(appleModelName('iPad13,4')).toBe('iPad (iPad13,4)');
    expect(appleModelName(undefined)).toBe('iPhone');
  });
  it('converts Apple timestamps (seconds and nanoseconds)', () => {
    expect(appleTime(0)).toBe(0);
    expect(new Date(appleTime(725760000)).toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(new Date(appleTime(725760000 * 1e9)).toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });
});

describe('mediaKind', () => {
  it('sorts camera roll files', async () => {
    const { mediaKind } = await import('../shared/ios');
    expect(mediaKind('IMG_0001.HEIC')).toBe('image');
    expect(mediaKind('IMG_0002.jpg')).toBe('image');
    expect(mediaKind('IMG_0003.MOV')).toBe('video');
    expect(mediaKind('IMG_0004.mp4')).toBe('video');
    expect(mediaKind('IMG_0001.AAE')).toBeNull();
  });
});
