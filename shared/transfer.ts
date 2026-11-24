// Transfer: copy chosen kinds of content off a phone as ordinary files.
// Item lists and parsers for afcclient / Android `stat` output. Pure functions, unit-tested.
import type { PhonePlatform, TransferItemId } from './types';

export interface TransferItem {
  id: TransferItemId;
  label: string;
  description: string;
  platforms: PhonePlatform[];
  /**
   * iPhone only. "direct" items are copied straight from the camera roll; "backup" items live in
   * app storage Apple only hands out through a full backup, so they take as long as one.
   */
  ios?: 'direct' | 'backup';
}

export const TRANSFER_ITEMS: TransferItem[] = [
  { id: 'photos', label: 'Photos', description: 'Camera roll, screenshots and saved pictures, original quality.', platforms: ['ios', 'android'], ios: 'direct' },
  { id: 'videos', label: 'Videos', description: 'Videos from the camera roll and Movies folder.', platforms: ['ios', 'android'], ios: 'direct' },
  { id: 'music', label: 'Music & audio', description: 'Music, podcasts, audiobooks, ringtones and recordings.', platforms: ['android'] },
  { id: 'documents', label: 'Documents', description: 'The Documents folder.', platforms: ['android'] },
  { id: 'downloads', label: 'Downloads', description: 'Everything in the Download folder.', platforms: ['android'] },
  { id: 'contacts', label: 'Contacts', description: 'A vCard (.vcf) any phone, Google, Outlook or Mac Contacts can import.', platforms: ['ios', 'android'], ios: 'backup' },
  { id: 'messages', label: 'Messages', description: 'Conversations as CSV. On iPhone also one transcript per chat with attachments.', platforms: ['ios', 'android'], ios: 'backup' },
  { id: 'calls', label: 'Call history', description: 'Calls as CSV.', platforms: ['ios', 'android'], ios: 'backup' },
  { id: 'notes', label: 'Notes', description: 'Every note as a text file.', platforms: ['ios'], ios: 'backup' },
  { id: 'voicememos', label: 'Voice Memos', description: 'Recordings as .m4a audio files.', platforms: ['ios'], ios: 'backup' },
  { id: 'whatsapp', label: 'WhatsApp', description: 'iPhone: chats and media. Android: photos, videos, voice notes and documents.', platforms: ['ios', 'android'], ios: 'backup' },
  { id: 'apps', label: 'Apps (APK)', description: 'Installers of the apps you added. App data isn’t included.', platforms: ['android'] },
];

export function transferItemsFor(platform: PhonePlatform): TransferItem[] {
  return TRANSFER_ITEMS.filter((i) => i.platforms.includes(platform));
}

export interface RemoteFile {
  /** Full path on the phone. */
  path: string;
  size: number;
  /** ms since epoch, or 0 if unknown. */
  mtime: number;
  dir: boolean;
}

/** One file to copy between the phone and this computer. */
export interface CopyItem {
  remote: string;
  local: string;
  size: number;
  mtime: number;
}

/** Media views of the phone manager. */
export type MediaView = 'photos' | 'videos' | 'music';

/** Which media kind each view shows. */
export const VIEW_KIND: Record<MediaView, 'image' | 'video' | 'audio'> = { photos: 'image', videos: 'video', music: 'audio' };

/** One command's answer from the mt-ios helper. */
export interface HelperReply {
  ok: boolean;
  error?: string;
  entries: RemoteFile[];
  apps: PhoneApp[];
  bytes: number;
}

export interface PhoneApp {
  id: string;
  name: string;
  version: string;
  /** App size (and, on iPhone, its data) in bytes, when known. */
  size?: number;
  dataSize?: number;
  /** Android: path of base.apk on the phone. */
  apk?: string;
}

/**
 * Streams mt-ios output into one reply per command. `ls` replies carry names relative to `dirs[i]`;
 * `walk` replies carry full paths. Throws on FATAL (phone not reachable).
 */
export class HelperParser {
  replies: HelperReply[] = [];
  ready = false;
  private cur: HelperReply = { ok: false, entries: [], apps: [], bytes: 0 };

  constructor(private readonly bases: (string | null)[], private readonly onReply?: (i: number, r: HelperReply) => void) {}

  line(raw: string) {
    const f = raw.split('\t');
    if (f[0] === 'READY') this.ready = true;
    else if (f[0].startsWith('FATAL')) throw new Error(raw.replace(/^FATAL\s*/, ''));
    else if (f[0] === 'E' && f.length >= 5) {
      const name = f.slice(4).join('\t');
      const base = this.bases[this.replies.length];
      const full = base == null ? name : `${base === '/' ? '' : base.replace(/\/+$/, '')}/${name}`;
      this.cur.entries.push({ path: full, dir: f[1] === 'd', size: Number(f[2]) || 0, mtime: (Number(f[3]) || 0) * 1000 });
    } else if (f[0] === 'A' && f.length >= 6) {
      this.cur.apps.push({ id: f[1], name: f[2] || f[1], version: f[3], size: Number(f[4]) || 0, dataSize: Number(f[5]) || 0 });
    } else if (f[0] === 'OK') this.finish({ ok: true, bytes: Number(f[1]) || 0 });
    else if (f[0].startsWith('ERR')) this.finish({ ok: false, error: raw.replace(/^ERR\s*/, '') });
  }

  private finish(r: Partial<HelperReply>) {
    const reply = { ...this.cur, ...r };
    this.onReply?.(this.replies.length, reply);
    this.replies.push(reply);
    this.cur = { ok: false, entries: [], apps: [], bytes: 0 };
  }
}

/** Builds one helper command line; refuses fields that would break the TAB/line protocol. */
export function helperCommand(...fields: string[]): string {
  for (const f of fields) if (/[\t\r\n]/.test(f)) throw new Error('File names with tabs or line breaks can’t be copied.');
  return fields.join('\t');
}

/** Parses Android `stat -c '%F|%s|%Y|%n'` lines (type, size, mtime, path). */
export function parseStatTypeLines(out: string): RemoteFile[] {
  const list: RemoteFile[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^([^|]+)\|(\d+)\|(\d+)\|(.+)$/.exec(raw.trim());
    if (m) list.push({ path: m[4], dir: m[1] === 'directory', size: Number(m[2]), mtime: Number(m[3]) * 1000 });
  }
  return list;
}

/** Parses `stat -c '%s|%Y|%n'` lines from an Android shell. */
export function parseStatLines(out: string): RemoteFile[] {
  const list: RemoteFile[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(.+)$/.exec(raw.trim());
    if (m) list.push({ path: m[3], size: Number(m[1]), mtime: Number(m[2]) * 1000, dir: false });
  }
  return list;
}

/** Splits `items` into arrays of at most `n`. */
export function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/** Groups files by their parent folder on the phone. */
export function byFolder(files: RemoteFile[]): Map<string, RemoteFile[]> {
  const map = new Map<string, RemoteFile[]>();
  for (const f of files) {
    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
    map.set(dir, [...(map.get(dir) ?? []), f]);
  }
  return map;
}
