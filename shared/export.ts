// Export helpers: CSV, vCard, and small formatters. Pure functions, unit-tested.

export function csv(rows: (string | number | null | undefined)[][]): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = v == null ? '' : String(v);
            return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(','),
      )
      .join('\r\n') + '\r\n'
  );
}

export interface ContactCard {
  name: string;
  given?: string;
  family?: string;
  org?: string;
  phones: { value: string; type?: string }[];
  emails: { value: string; type?: string }[];
  addresses: string[];
  note?: string;
  birthday?: string;
  urls: string[];
}

export function emptyCard(): ContactCard {
  return { name: '', phones: [], emails: [], addresses: [], urls: [] };
}

function vEscape(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** Builds a vCard 3.0 document (widely importable by Android, iOS, macOS, Windows and Google). */
export function toVCard(cards: ContactCard[]): string {
  const out: string[] = [];
  for (const c of cards) {
    const display = c.name || [c.given, c.family].filter(Boolean).join(' ') || c.org || c.phones[0]?.value || c.emails[0]?.value;
    if (!display) continue;
    out.push('BEGIN:VCARD', 'VERSION:3.0');
    out.push(`FN:${vEscape(display)}`);
    out.push(`N:${vEscape(c.family ?? '')};${vEscape(c.given ?? (c.family ? '' : display))};;;`);
    if (c.org) out.push(`ORG:${vEscape(c.org)}`);
    for (const p of c.phones) out.push(`TEL;TYPE=${(p.type || 'CELL').toUpperCase()}:${vEscape(p.value)}`);
    for (const e of c.emails) out.push(`EMAIL;TYPE=${(e.type || 'INTERNET').toUpperCase()}:${vEscape(e.value)}`);
    for (const a of c.addresses) out.push(`ADR:;;${vEscape(a)};;;;`);
    for (const u of c.urls) out.push(`URL:${vEscape(u)}`);
    if (c.birthday) out.push(`BDAY:${c.birthday}`);
    if (c.note) out.push(`NOTE:${vEscape(c.note)}`);
    out.push('END:VCARD');
  }
  return out.length ? out.join('\r\n') + '\r\n' : '';
}

const ANDROID_PHONE_TYPES: Record<string, string> = { '1': 'HOME', '2': 'CELL', '3': 'WORK', '4': 'FAX', '7': 'VOICE', '12': 'MAIN' };
const ANDROID_EMAIL_TYPES: Record<string, string> = { '1': 'HOME', '2': 'WORK' };

/** Groups rows from content://com.android.contacts/data into cards. */
export function androidContactsToCards(rows: Record<string, string>[]): ContactCard[] {
  const byId = new Map<string, ContactCard>();
  for (const r of rows) {
    const id = r.raw_contact_id;
    if (!id) continue;
    const card = byId.get(id) ?? emptyCard();
    byId.set(id, card);
    const v = r.data1?.trim();
    if (!v) continue;
    switch (r.mimetype) {
      case 'vnd.android.cursor.item/name':
        card.name = v;
        card.given = r.data2 || undefined;
        card.family = r.data3 || undefined;
        break;
      case 'vnd.android.cursor.item/phone_v2':
        if (!card.phones.some((p) => p.value === v)) card.phones.push({ value: v, type: ANDROID_PHONE_TYPES[r.data2] });
        break;
      case 'vnd.android.cursor.item/email_v2':
        if (!card.emails.some((p) => p.value === v)) card.emails.push({ value: v, type: ANDROID_EMAIL_TYPES[r.data2] });
        break;
      case 'vnd.android.cursor.item/organization':
        card.org = v;
        break;
      case 'vnd.android.cursor.item/postal-address_v2':
        card.addresses.push(v);
        break;
      case 'vnd.android.cursor.item/note':
        card.note = v;
        break;
      case 'vnd.android.cursor.item/website':
        card.urls.push(v);
        break;
      case 'vnd.android.cursor.item/contact_event':
        if (r.data2 === '3') card.birthday = v;
        break;
    }
  }
  return [...byId.values()].filter((c) => c.name || c.phones.length || c.emails.length);
}

/** "_$!<Mobile>!$_" → "Mobile". */
export function appleLabel(label: string | null | undefined): string {
  if (!label) return '';
  const m = /_\$!<(.+)>!\$_/.exec(label);
  return m ? m[1] : label;
}

export function phoneTypeFromLabel(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('mobile') || l.includes('iphone') || l.includes('cell')) return 'CELL';
  if (l.includes('home')) return 'HOME';
  if (l.includes('work')) return 'WORK';
  if (l.includes('fax')) return 'FAX';
  if (l.includes('main')) return 'MAIN';
  return 'VOICE';
}

export const ANDROID_CALL_TYPES: Record<string, string> = {
  '1': 'Incoming', '2': 'Outgoing', '3': 'Missed', '4': 'Voicemail', '5': 'Rejected', '6': 'Blocked', '7': 'Answered externally',
};

export function isoTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function formatBytes(n: number | undefined | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${u[i]}`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** File-system safe name (Windows-safe too). */
export function safeName(s: string, fallback = 'item'): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

/** Folder name for a new backup: "Pixel 8 2026-11-23 2105". */
export function backupFolderName(deviceName: string, when: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}-${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`;
  return `${safeName(deviceName, 'Phone')} ${stamp}`;
}

/** Space kept free on top of what a copy needs, so the computer itself doesn't run out. */
export const SPACE_MARGIN = 1024 ** 3;

/**
 * Message when `free` bytes can't hold `need` bytes (plus a 1 GB margin), else null.
 * `free` is null when the drive's free space is unknown.
 */
export function spaceProblem(free: number | null | undefined, need: number, where = 'this computer'): string | null {
  if (free == null || need <= 0 || free >= need + SPACE_MARGIN) return null;
  return `Not enough space on ${where}: this needs about ${formatBytes(need)} but only ${formatBytes(free)} is free. Free up space or choose another folder on a bigger drive.`;
}

/** Turns "ENOSPC: no space left on device" into something a person understands. */
export function explainDiskError(message: string): string {
  return /ENOSPC|no space left|disk full|not enough space/i.test(message) && !/^Not enough space on/.test(message)
    ? 'The computer’s drive is full, so the copy stopped. Free up space (or choose a folder on another drive) and try again. Files already copied are kept.'
    : message;
}
