// Android: backup categories and parsers for adb / Android shell output.
// Pure functions only (no Node or Electron), so everything here is unit-tested.
import type { AndroidCategoryId, CategoryInfo, ConnectionState, TrashItem } from './types';

export const ANDROID_CATEGORIES: CategoryInfo[] = [
  { id: 'photos', label: 'Photos', description: 'Camera roll, screenshots and saved pictures (DCIM, Pictures).', paths: ['DCIM', 'Pictures'], kind: 'files' },
  { id: 'videos', label: 'Videos', description: 'Movies folder. Camera videos are included with Photos.', paths: ['Movies'], kind: 'files' },
  { id: 'music', label: 'Music & audio', description: 'Music, podcasts, audiobooks, ringtones and voice recordings.', paths: ['Music', 'Podcasts', 'Audiobooks', 'Ringtones', 'Notifications', 'Alarms', 'Recordings'], kind: 'files' },
  { id: 'documents', label: 'Documents', description: 'The Documents folder.', paths: ['Documents'], kind: 'files' },
  { id: 'downloads', label: 'Downloads', description: 'Everything in the Download folder.', paths: ['Download'], kind: 'files' },
  { id: 'whatsapp', label: 'WhatsApp media', description: 'WhatsApp images, video, voice notes, documents and its local chat backup files.', paths: ['Android/media/com.whatsapp/WhatsApp', 'WhatsApp'], kind: 'files' },
  { id: 'apps', label: 'Apps (APK)', description: 'Installers of the apps you installed, including split APKs. App data is not included (Android does not allow it without root).', kind: 'apps' },
  { id: 'contacts', label: 'Contacts', description: 'Exported as a vCard file that any phone or computer can import.', kind: 'provider' },
  { id: 'calls', label: 'Call log', description: 'Exported as CSV. Some phones block this for USB debugging.', kind: 'provider' },
  { id: 'messages', label: 'SMS messages', description: 'Exported as CSV. Most phones on Android 10+ block this for USB debugging.', kind: 'provider' },
  { id: 'storage', label: 'Entire internal storage', description: 'Every file in shared storage (/sdcard). Overrides the file categories above.', paths: [''], kind: 'all' },
];

export const FILE_CATEGORIES = ANDROID_CATEGORIES.filter((c) => c.kind === 'files');

/** Shared-storage root used for every path. "/sdcard" is a symlink on all supported versions. */
export const SDCARD = '/sdcard';

/** Top-level shared-storage folders the erase screen offers to wipe. */
export const WIPEABLE_FOLDERS = ['DCIM', 'Pictures', 'Movies', 'Music', 'Download', 'Documents', 'Recordings', 'Podcasts', 'Audiobooks', 'WhatsApp', 'Android/media'];

export function categoryById(id: string): CategoryInfo | undefined {
  return ANDROID_CATEGORIES.find((c) => c.id === id);
}

/** Expands the selected categories into the list of /sdcard-relative folders to pull. */
export function pathsForCategories(ids: AndroidCategoryId[]): string[] {
  if (ids.includes('storage')) return [''];
  const out: string[] = [];
  for (const id of ids) for (const p of categoryById(id)?.paths ?? []) if (!out.includes(p)) out.push(p);
  return out;
}

// ------------------------------------------------------------------ adb devices

export interface AdbListEntry {
  serial: string;
  state: ConnectionState;
  stateDetail?: string;
  model?: string;
  product?: string;
  wireless: boolean;
}

/** Parses `adb devices -l`. */
export function parseAdbDevices(out: string): AdbListEntry[] {
  const list: AdbListEntry[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('List of devices') || line.startsWith('*')) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const serial = m[1];
    const rest = m[2];
    const props: Record<string, string> = {};
    for (const kv of rest.matchAll(/(\w+):(\S+)/g)) props[kv[1]] = kv[2];
    const word = rest.split(/\s+/)[0];
    let state: ConnectionState = 'unknown';
    let stateDetail: string | undefined;
    if (rest.startsWith('no permissions')) {
      state = 'unauthorized';
      stateDetail = 'Your computer has no USB permission for this phone (on Linux add a udev rule).';
    } else if (word === 'device') state = 'ready';
    else if (word === 'unauthorized') {
      state = 'unauthorized';
      stateDetail = 'Unlock the phone and tap "Allow" on the USB debugging prompt.';
    } else if (word === 'offline') {
      state = 'offline';
      stateDetail = 'The phone is not responding. Reconnect the cable or toggle USB debugging.';
    } else if (word === 'recovery' || word === 'sideload' || word === 'rescue') {
      state = 'recovery';
      stateDetail = 'The phone is in recovery mode.';
    } else if (word === 'authorizing' || word === 'connecting') {
      state = 'unauthorized';
      stateDetail = 'Waiting for the phone to authorise this computer…';
    }
    list.push({
      serial,
      state,
      stateDetail,
      model: props.model?.replace(/_/g, ' '),
      product: props.product,
      wireless: /:\d+$/.test(serial) || serial.includes('._adb-tls-connect.'),
    });
  }
  return list;
}

/** Parses `getprop` output into a map. */
export function parseGetprop(out: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const m of out.matchAll(/^\[([^\]]+)\]:\s*\[([^\]]*)\]/gm)) props[m[1]] = m[2];
  return props;
}

/** Parses `dumpsys battery`. */
export function parseBattery(out: string): { level?: number; charging?: boolean } {
  const level = /^\s*level:\s*(\d+)/m.exec(out);
  const status = /^\s*status:\s*(\d+)/m.exec(out);
  const powered = /(AC|USB|Wireless|Dock) powered:\s*true/i.test(out);
  return {
    level: level ? Number(level[1]) : undefined,
    // BatteryManager.BATTERY_STATUS_CHARGING = 2, FULL = 5
    charging: status ? status[1] === '2' || (status[1] === '5' && powered) : powered || undefined,
  };
}

/** Parses `df -k <path>` and returns bytes for the last data line. */
export function parseDf(out: string): { total: number; free: number } | null {
  const lines = out.trim().split(/\r?\n/).filter((l) => !/^Filesystem/i.test(l));
  // Long filesystem names can wrap onto their own line on old toolboxes; join the numbers.
  const nums = lines.join(' ').split(/\s+/).filter((t) => /^\d+$/.test(t)).map(Number);
  // df prints: 1K-blocks Used Available Use% Mounted-on (Use% is not purely numeric).
  if (nums.length < 3) return null;
  const [blocks, , avail] = nums.slice(0, 3);
  return { total: blocks * 1024, free: avail * 1024 };
}

/** Friendly name for an Android device from its properties. */
export function androidModelName(props: Record<string, string>, fallback = 'Android phone'): { model: string; manufacturer: string } {
  const manufacturer = props['ro.product.manufacturer'] || props['ro.product.brand'] || '';
  const marketing = props['ro.product.marketname'] || props['ro.config.marketing_name'] || props['ro.vendor.oplus.market.name'] || '';
  let model = marketing || props['ro.product.model'] || fallback;
  const brand = capitalise(manufacturer);
  if (brand && !model.toLowerCase().startsWith(brand.toLowerCase())) model = `${brand} ${model}`;
  return { model, manufacturer: brand };
}

function capitalise(s: string) {
  if (!s) return s;
  if (s.toUpperCase() === s && s.length <= 4) return s; // LG, HTC, ZTE
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ------------------------------------------------------------------ packages

export interface PackageEntry {
  name: string;
  apk: string;
}

/** Parses `pm list packages -f`. Lines look like `package:/data/app/~~x==/com.a-y==/base.apk=com.a`. */
export function parsePackageList(out: string): PackageEntry[] {
  const list: PackageEntry[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('package:')) continue;
    const body = line.slice('package:'.length);
    const eq = body.lastIndexOf('=');
    if (eq <= 0) list.push({ name: body, apk: '' });
    else list.push({ apk: body.slice(0, eq), name: body.slice(eq + 1) });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parses `pm path <pkg>` into APK paths (base first). */
export function parsePmPath(out: string): string[] {
  const paths = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('package:'))
    .map((l) => l.slice('package:'.length));
  return paths.sort((a, b) => (a.endsWith('/base.apk') ? -1 : b.endsWith('/base.apk') ? 1 : a.localeCompare(b)));
}

/** Package names must be safe to use in a shell command and as a folder name. */
export function isSafePackageName(name: string): boolean {
  return /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/.test(name);
}

// ------------------------------------------------------------------ content providers

/**
 * Parses `content query --projection a:b:c` output. Each row starts with `Row: N `.
 * Values may contain commas and newlines, so we split only before the known keys.
 */
export function parseContentRows(out: string, keys: string[]): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const chunks = out.split(/^Row:\s*\d+\s/m).slice(1);
  const keyAlt = keys.map(escapeRe).join('|');
  const splitter = new RegExp(`(?:^|, )(${keyAlt})=`, 'g');
  for (let chunk of chunks) {
    chunk = chunk.replace(/\r?\n$/, '');
    const row: Record<string, string> = {};
    const marks: { key: string; start: number; valueStart: number }[] = [];
    for (const m of chunk.matchAll(splitter)) marks.push({ key: m[1], start: m.index!, valueStart: m.index! + m[0].length });
    marks.forEach((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].start : chunk.length;
      const v = chunk.slice(mk.valueStart, end);
      row[mk.key] = v === 'NULL' ? '' : v;
    });
    if (marks.length) rows.push(row);
  }
  return rows;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CONTACT_KEYS = ['raw_contact_id', 'mimetype', 'data1', 'data2', 'data3'];
export const CALL_KEYS = ['number', 'name', 'date', 'duration', 'type'];
export const SMS_KEYS = ['address', 'date', 'type', 'read', 'body'];

/** True when the provider refused access (permission denial / security exception). */
export function isProviderDenied(out: string): boolean {
  return /SecurityException|Permission Denial|requires android\.permission|Error while accessing provider/i.test(out);
}

// ------------------------------------------------------------------ trash scan

/** Shell command that lists recoverable files: MediaStore trash, gallery recycle bins and thumbnail caches. */
export function trashScanCommand(): string {
  const tests = [
    "-name '.trashed-*'",
    "-path '*/.thumbnails/*'",
    "-path '*[Tt]rash*/*'",
    "-path '*[Rr]ecycle*/*'",
    "-path '*/.deleted/*'",
  ].join(' -o ');
  return `find ${SDCARD}/ -type f \\( ${tests} \\) -exec stat -c '%s|%Y|%n' {} + 2>/dev/null`;
}

export function parseTrashScan(out: string): TrashItem[] {
  const items: TrashItem[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.+)$/.exec(raw.trim());
    if (!m) continue;
    const path = m[3];
    const size = Number(m[1]);
    if (size === 0) continue;
    items.push({ path, size, mtime: Number(m[2]) * 1000, name: recoveredName(path), source: trashSource(path) });
  }
  return items.sort((a, b) => b.mtime - a.mtime);
}

/** `.trashed-1712345678-IMG_1.jpg` → `IMG_1.jpg`. */
export function recoveredName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/^\.trashed-\d+-/, '').replace(/^\.pending-\d+-/, '');
}

export function trashSource(path: string): string {
  const p = path.toLowerCase();
  if (/\/\.trashed-/.test(path)) return 'Recently deleted (Android trash)';
  if (p.includes('/.thumbnails/')) return 'Thumbnail cache (preview of deleted photos)';
  if (p.includes('com.sec.android.gallery3d')) return 'Samsung Gallery recycle bin';
  if (p.includes('miui') || p.includes('com.miui.gallery')) return 'Xiaomi Gallery trash';
  if (p.includes('coloros') || p.includes('oplus') || p.includes('oneplus')) return 'OPPO / OnePlus Gallery recycle bin';
  if (p.includes('whatsapp')) return 'WhatsApp';
  return 'App or file-manager trash';
}

/** Single-quote a path for the Android shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
