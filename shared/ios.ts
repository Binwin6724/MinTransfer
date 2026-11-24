// iOS: parsers for libimobiledevice output and Apple model names. Pure functions, unit-tested.
import type { ConnectionState } from './types';

/** Parses `ideviceinfo` (`Key: value` per line; nested dictionaries are indented and ignored). */
export function parseKeyValues(out: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of out.split(/\r?\n/)) {
    if (/^\s/.test(line)) continue;
    const i = line.indexOf(': ');
    if (i <= 0) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 2).trim();
  }
  return map;
}

/** Parses `idevice_id -l` (one UDID per line; newer versions append " (USB)" / " (Network)"). */
export function parseUdidList(out: string): { udid: string; wireless: boolean }[] {
  const seen = new Map<string, boolean>();
  for (const raw of out.split(/\r?\n/)) {
    const m = /^([0-9A-Fa-f-]{24,40})(?:\s+\((USB|Network)\))?/.exec(raw.trim());
    if (!m) continue;
    const wireless = m[2] === 'Network';
    // Prefer USB when a device is listed on both transports.
    if (!seen.has(m[1]) || !wireless) seen.set(m[1], wireless);
  }
  return [...seen].map(([udid, wireless]) => ({ udid, wireless }));
}

/** Maps lockdownd / idevicepair errors to a connection state with advice. */
export function classifyLockdownError(text: string): { state: ConnectionState; detail: string } {
  const t = text.toLowerCase();
  if (t.includes('pairing dialog response pending') || t.includes('accept the trust dialog') || t.includes('trust dialog'))
    return { state: 'untrusted', detail: 'Unlock the iPhone and tap "Trust", then enter its passcode.' };
  if (t.includes('passcode') || t.includes('password protected'))
    return { state: 'locked', detail: 'Unlock the iPhone with its passcode so it can be paired.' };
  if (t.includes('user denied pairing') || t.includes('denied'))
    return { state: 'untrusted', detail: 'This computer was not trusted. Reconnect the cable and tap "Trust".' };
  if (t.includes('invalid hostid') || t.includes('not paired') || t.includes('pairing') || t.includes('ssl'))
    return { state: 'untrusted', detail: 'The iPhone is not paired with this computer yet. Unlock it and tap "Trust".' };
  if (t.includes('no device found') || t.includes('not found'))
    return { state: 'offline', detail: 'The iPhone disconnected.' };
  if (t.includes('usbmux') || t.includes('could not connect'))
    return {
      state: 'offline',
      detail: 'Cannot reach the Apple device service. On Windows install the Apple Devices app (or iTunes); on macOS reconnect the cable.',
    };
  return { state: 'unknown', detail: text.trim().split('\n')[0] || 'The iPhone did not respond.' };
}

/** Progress percentage from an idevicebackup2 line such as `[====     ]  42% Finished`. */
export function parseBackupProgress(line: string): number | null {
  const m = /(\d{1,3}(?:\.\d+)?)%\s*Finished/i.exec(line) ?? /\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(line);
  if (!m) return null;
  const v = Number(m[1]);
  return v >= 0 && v <= 100 ? v / 100 : null;
}

/** Turns idevicebackup2 failure text into a sentence a person can act on. */
export function explainBackupError(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('find my') || t.includes('findmy') || t.includes('find my iphone'))
    return 'Turn off Find My on the iPhone (Settings ▸ your name ▸ Find My) and try again.';
  if (t.includes('wrong password') || t.includes('password') && t.includes('incorrect'))
    return 'The backup password is wrong.';
  if (t.includes('no space') || t.includes('not enough') || t.includes('enospc'))
    return 'There is not enough free space for this operation.';
  if (t.includes('passcode') || t.includes('locked')) return 'Unlock the iPhone and keep it unlocked until the operation starts.';
  if (t.includes('could not connect') || t.includes('no device found')) return 'The iPhone disconnected. Reconnect it and try again.';
  if (t.includes('encrypt') && t.includes('password')) return 'This backup is encrypted. Enter its password.';
  const err = text
    .split(/\r?\n/)
    .reverse()
    .find((l) => /error/i.test(l));
  return err?.replace(/^ERROR:\s*/i, '').trim() || 'The iPhone reported an error. See the activity log for details.';
}

const MODELS: Record<string, string> = {
  'iPhone10,1': 'iPhone 8', 'iPhone10,4': 'iPhone 8', 'iPhone10,2': 'iPhone 8 Plus', 'iPhone10,5': 'iPhone 8 Plus',
  'iPhone10,3': 'iPhone X', 'iPhone10,6': 'iPhone X', 'iPhone11,2': 'iPhone XS', 'iPhone11,4': 'iPhone XS Max',
  'iPhone11,6': 'iPhone XS Max', 'iPhone11,8': 'iPhone XR', 'iPhone12,1': 'iPhone 11', 'iPhone12,3': 'iPhone 11 Pro',
  'iPhone12,5': 'iPhone 11 Pro Max', 'iPhone12,8': 'iPhone SE (2nd generation)', 'iPhone13,1': 'iPhone 12 mini',
  'iPhone13,2': 'iPhone 12', 'iPhone13,3': 'iPhone 12 Pro', 'iPhone13,4': 'iPhone 12 Pro Max', 'iPhone14,4': 'iPhone 13 mini',
  'iPhone14,5': 'iPhone 13', 'iPhone14,2': 'iPhone 13 Pro', 'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,6': 'iPhone SE (3rd generation)', 'iPhone14,7': 'iPhone 14', 'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro', 'iPhone15,3': 'iPhone 14 Pro Max', 'iPhone15,4': 'iPhone 15', 'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro', 'iPhone16,2': 'iPhone 15 Pro Max', 'iPhone17,3': 'iPhone 16', 'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,1': 'iPhone 16 Pro', 'iPhone17,2': 'iPhone 16 Pro Max', 'iPhone17,5': 'iPhone 16e',
  'iPhone18,1': 'iPhone 17 Pro', 'iPhone18,2': 'iPhone 17 Pro Max', 'iPhone18,3': 'iPhone 17', 'iPhone18,4': 'iPhone Air',
};

/** Marketing name for a ProductType such as "iPhone15,2". Unknown types fall back to the device class. */
export function appleModelName(productType: string | undefined, deviceClass?: string): string {
  if (productType && MODELS[productType]) return MODELS[productType];
  if (productType?.startsWith('iPad')) return `iPad (${productType})`;
  if (productType?.startsWith('iPod')) return `iPod touch (${productType})`;
  return productType ? `${deviceClass || 'iPhone'} (${productType})` : deviceClass || 'iPhone';
}

/** Seconds since 2001-01-01 (Apple's reference date) → JS milliseconds. Handles ns timestamps from iOS 11+. */
export function appleTime(v: number | null | undefined): number {
  if (v == null || !Number.isFinite(v) || v === 0) return 0;
  let s = v;
  if (Math.abs(s) > 1e14) s = s / 1e9; // nanoseconds
  return Math.round((s + 978307200) * 1000);
}
