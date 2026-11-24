// Reads unencrypted iOS backups (iOS 10 and later: Manifest.db) and extracts what people
// actually want back: photos (including Recently Deleted), contacts, messages with attachments,
// call history, notes (including Recently Deleted), voice memos and WhatsApp chats.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import initSqlJs, { Database, SqlJsStatic, SqlValue } from 'sql.js';
import type { JobContext } from './jobs';
import { readPlistFile } from './plist';
import { attributedBodyText, noteText } from '../shared/binary';
import { appleLabel, csv, ContactCard, emptyCard, isoTime, phoneTypeFromLabel, safeName, toVCard } from '../shared/export';
import { appleTime, mediaKind } from '../shared/ios';
import type { RecoverGroup } from '../shared/types';

let SQL: Promise<SqlJsStatic> | null = null;
function sql(): Promise<SqlJsStatic> {
  if (!SQL) {
    const wasm = require.resolve('sql.js/dist/sql-wasm.wasm');
    SQL = initSqlJs({ wasmBinary: new Uint8Array(fs.readFileSync(wasm)) as unknown as ArrayBuffer } as Parameters<typeof initSqlJs>[0]);
  }
  return SQL;
}

type Row = Record<string, SqlValue>;

function all(db: Database, query: string, params: SqlValue[] = []): Row[] {
  const rows: Row[] = [];
  let stmt;
  try {
    stmt = db.prepare(query);
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject() as Row);
  } catch {
    return rows;
  } finally {
    stmt?.free();
  }
  return rows;
}

function str(v: SqlValue | undefined): string {
  if (v == null) return '';
  if (v instanceof Uint8Array) return new TextDecoder().decode(v);
  return String(v);
}

function num(v: SqlValue | undefined): number {
  return typeof v === 'number' ? v : Number(v) || 0;
}

interface FileRef {
  fileID: string;
  domain: string;
  relativePath: string;
}

const DOMAINS = {
  contacts: ['HomeDomain', 'Library/AddressBook/AddressBook.sqlitedb'],
  sms: ['HomeDomain', 'Library/SMS/sms.db'],
  calls: ['HomeDomain', 'Library/CallHistoryDB/CallHistory.storedata'],
  notes: ['AppDomainGroup-group.com.apple.notes', 'NoteStore.sqlite'],
  photosDb: ['CameraRollDomain', 'Media/PhotoData/Photos.sqlite'],
} as const;

export class IosBackupReader {
  private constructor(
    readonly dataPath: string,
    private readonly manifest: Database,
    private readonly SQL: SqlJsStatic,
  ) {}

  static isEncrypted(dataPath: string): boolean {
    try {
      const m = readPlistFile(path.join(dataPath, 'Manifest.plist')) as Record<string, unknown> | null;
      return m?.IsEncrypted === true;
    } catch {
      return false;
    }
  }

  static async open(dataPath: string): Promise<IosBackupReader> {
    const dbFile = path.join(dataPath, 'Manifest.db');
    if (!fs.existsSync(dbFile)) {
      if (fs.existsSync(path.join(dataPath, 'Manifest.mbdb'))) throw new Error('Backups from iOS 9 and earlier are not supported for browsing.');
      throw new Error('This folder is not a complete iOS backup (Manifest.db is missing).');
    }
    if (IosBackupReader.isEncrypted(dataPath)) throw new Error('This backup is encrypted. It can be restored to an iPhone, but its contents cannot be browsed.');
    const S = await sql();
    const db = new S.Database(new Uint8Array(fs.readFileSync(dbFile)));
    return new IosBackupReader(dataPath, db, S);
  }

  close() {
    this.manifest.close();
  }

  /** Location of a backed-up file on disk (iOS 10+: <first two hex chars>/<fileID>). */
  blobPath(fileID: string): string {
    const nested = path.join(this.dataPath, fileID.slice(0, 2), fileID);
    return fs.existsSync(nested) ? nested : path.join(this.dataPath, fileID);
  }

  private find(domain: string, relativePath: string): FileRef | null {
    const r = all(this.manifest, 'SELECT fileID, domain, relativePath FROM Files WHERE domain = ? AND relativePath = ? AND flags = 1', [domain, relativePath])[0];
    return r ? { fileID: str(r.fileID), domain: str(r.domain), relativePath: str(r.relativePath) } : null;
  }

  private files(where: string, params: SqlValue[] = []): FileRef[] {
    return all(this.manifest, `SELECT fileID, domain, relativePath FROM Files WHERE flags = 1 AND ${where} ORDER BY relativePath`, params).map((r) => ({
      fileID: str(r.fileID),
      domain: str(r.domain),
      relativePath: str(r.relativePath),
    }));
  }

  private openDb(domain: string, relativePath: string): Database | null {
    const ref = this.find(domain, relativePath);
    if (!ref) return null;
    const file = this.blobPath(ref.fileID);
    if (!fs.existsSync(file)) return null;
    try {
      return new this.SQL.Database(new Uint8Array(fs.readFileSync(file)));
    } catch {
      return null;
    }
  }

  private sizeOf(refs: FileRef[]): number {
    let n = 0;
    for (const r of refs) {
      try {
        n += fs.statSync(this.blobPath(r.fileID)).size;
      } catch {
        /* missing */
      }
    }
    return n;
  }

  private photoRefs() {
    return this.files("domain = 'CameraRollDomain' AND relativePath LIKE 'Media/DCIM/%'");
  }

  private deletedPhotoRefs(): FileRef[] {
    const db = this.openDb(...DOMAINS.photosDb);
    if (!db) return [];
    try {
      let rows = all(db, 'SELECT ZDIRECTORY, ZFILENAME FROM ZASSET WHERE ZTRASHEDSTATE = 1');
      if (!rows.length) rows = all(db, 'SELECT ZDIRECTORY, ZFILENAME FROM ZGENERICASSET WHERE ZTRASHEDSTATE = 1');
      const out: FileRef[] = [];
      for (const r of rows) {
        const ref = this.find('CameraRollDomain', `Media/${str(r.ZDIRECTORY)}/${str(r.ZFILENAME)}`);
        if (ref) out.push(ref);
      }
      return out;
    } finally {
      db.close();
    }
  }

  private voiceMemoRefs() {
    return this.files("relativePath LIKE '%Recordings/%' AND (relativePath LIKE '%.m4a' OR relativePath LIKE '%.qta' OR relativePath LIKE '%.caf')");
  }

  private whatsappMediaRefs() {
    return this.files("domain LIKE 'AppDomainGroup-group.net.whatsapp.%' AND relativePath LIKE 'Message/Media/%'");
  }

  private countIn(db: [string, string], query: string): { count: number; available: boolean } {
    const d = this.openDb(db[0], db[1]);
    if (!d) return { count: 0, available: false };
    try {
      return { count: num(all(d, query)[0]?.n), available: true };
    } finally {
      d.close();
    }
  }

  groups(): RecoverGroup[] {
    const photos = this.photoRefs();
    const deleted = this.deletedPhotoRefs();
    const memos = this.voiceMemoRefs();
    const contacts = this.countIn(DOMAINS.contacts as unknown as [string, string], 'SELECT COUNT(*) AS n FROM ABPerson');
    const sms = this.countIn(DOMAINS.sms as unknown as [string, string], 'SELECT COUNT(*) AS n FROM message');
    const calls = this.countIn(DOMAINS.calls as unknown as [string, string], 'SELECT COUNT(*) AS n FROM ZCALLRECORD');
    const notes = this.countIn(DOMAINS.notes as unknown as [string, string], 'SELECT COUNT(*) AS n FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE1 IS NOT NULL');
    const deletedNotes = this.countIn(
      DOMAINS.notes as unknown as [string, string],
      'SELECT COUNT(*) AS n FROM ZICCLOUDSYNCINGOBJECT n WHERE n.ZTITLE1 IS NOT NULL AND (n.ZMARKEDFORDELETION = 1 OR n.ZFOLDER IN (SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDERTYPE = 1))',
    );
    const waDb = this.files("domain LIKE 'AppDomainGroup-group.net.whatsapp.%' AND relativePath = 'ChatStorage.sqlite'")[0];
    let waCount = 0;
    if (waDb) {
      const d = this.openDb(waDb.domain, waDb.relativePath);
      if (d) {
        waCount = num(all(d, 'SELECT COUNT(*) AS n FROM ZWAMESSAGE')[0]?.n);
        d.close();
      }
    }
    const waMedia = this.whatsappMediaRefs();
    const allCount = num(all(this.manifest, 'SELECT COUNT(*) AS n FROM Files WHERE flags = 1')[0]?.n);
    const notIn = 'Not in this backup';
    return [
      { id: 'photos', label: 'Photos & videos', description: 'Camera roll originals (Media/DCIM). Photos stored only in iCloud are not in local backups.', count: photos.length, bytes: this.sizeOf(photos), format: 'files', available: photos.length > 0, reason: photos.length ? undefined : notIn },
      { id: 'deleted-photos', label: 'Recently Deleted photos', description: 'Photos and videos in the Recently Deleted album when the backup was made.', count: deleted.length, bytes: this.sizeOf(deleted), format: 'files', deleted: true, available: deleted.length > 0, reason: deleted.length ? undefined : 'None found' },
      { id: 'contacts', label: 'Contacts', description: 'Saved as a vCard (.vcf) you can import into any phone, Google, Outlook or macOS Contacts.', count: contacts.count, bytes: 0, format: 'vcf', available: contacts.available && contacts.count > 0, reason: contacts.available ? undefined : 'Contacts are synced with iCloud and not in this backup' },
      { id: 'messages', label: 'Messages (SMS & iMessage)', description: 'All conversations as CSV plus one readable transcript per chat, with photos and attachments.', count: sms.count, bytes: 0, format: 'csv + txt', available: sms.available && sms.count > 0, reason: sms.available ? undefined : 'Messages in iCloud is on, so they are not in this backup' },
      { id: 'calls', label: 'Call history', description: 'Phone and FaceTime calls as CSV.', count: calls.count, bytes: 0, format: 'csv', available: calls.available && calls.count > 0, reason: calls.available ? undefined : notIn },
      { id: 'notes', label: 'Notes', description: 'Every note as a text file, plus an index. Includes notes in Recently Deleted.', count: notes.count, bytes: 0, format: 'txt', available: notes.available && notes.count > 0, reason: notes.available ? undefined : 'Notes are stored in iCloud and not in this backup' },
      { id: 'deleted-notes', label: 'Recently Deleted notes', description: 'Notes that were in the Recently Deleted folder.', count: deletedNotes.count, bytes: 0, format: 'txt', deleted: true, available: deletedNotes.count > 0, reason: deletedNotes.count ? undefined : 'None found' },
      { id: 'voicememos', label: 'Voice Memos', description: 'Recordings as .m4a audio files.', count: memos.length, bytes: this.sizeOf(memos), format: 'files', available: memos.length > 0, reason: memos.length ? undefined : notIn },
      { id: 'whatsapp', label: 'WhatsApp chats & media', description: 'Messages as CSV and transcripts per chat, plus photos, videos and voice notes.', count: waCount + waMedia.length, bytes: this.sizeOf(waMedia), format: 'csv + files', available: !!waDb, reason: waDb ? undefined : notIn },
      { id: 'all', label: 'All files (raw)', description: 'Every file in the backup, arranged by app domain. For experts.', count: allCount, bytes: 0, format: 'files', available: allCount > 0 },
    ];
  }

  async extract(ctx: JobContext, groupId: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true });
    switch (groupId) {
      case 'photos':
        return this.copyRefs(ctx, this.photoRefs(), path.join(dest, 'Photos'), (r) => r.relativePath.replace(/^Media\/DCIM\//, ''));
      case 'images':
        return this.copyRefs(ctx, this.photoRefs().filter((r) => mediaKind(r.relativePath) === 'image'), path.join(dest, 'Photos'), (r) => r.relativePath.replace(/^Media\/DCIM\//, ''));
      case 'videos':
        return this.copyRefs(ctx, this.photoRefs().filter((r) => mediaKind(r.relativePath) === 'video'), path.join(dest, 'Videos'), (r) => r.relativePath.replace(/^Media\/DCIM\//, ''));
      case 'deleted-photos':
        return this.copyRefs(ctx, this.deletedPhotoRefs(), path.join(dest, 'Recently Deleted Photos'), (r) => path.posix.basename(r.relativePath));
      case 'voicememos':
        return this.copyRefs(ctx, this.voiceMemoRefs(), path.join(dest, 'Voice Memos'), (r) => path.posix.basename(r.relativePath));
      case 'all':
        return this.copyRefs(ctx, this.files('1 = 1'), path.join(dest, 'All Files'), (r) => `${r.domain}/${r.relativePath}`);
      case 'contacts':
        return this.extractContacts(ctx, dest);
      case 'messages':
        return this.extractMessages(ctx, dest);
      case 'calls':
        return this.extractCalls(ctx, dest);
      case 'notes':
        return this.extractNotes(ctx, dest, false);
      case 'deleted-notes':
        return this.extractNotes(ctx, dest, true);
      case 'whatsapp':
        return this.extractWhatsApp(ctx, dest);
      default:
        throw new Error(`Unknown group ${groupId}`);
    }
  }

  private async copyRefs(ctx: JobContext, refs: FileRef[], dest: string, rel: (r: FileRef) => string) {
    fs.mkdirSync(dest, { recursive: true });
    let copied = 0;
    for (let i = 0; i < refs.length; i++) {
      if (i % 25 === 0) {
        ctx.check();
        ctx.progress(i / refs.length, `Copying ${i.toLocaleString()} of ${refs.length.toLocaleString()} files`);
        await new Promise((r) => setImmediate(r));
      }
      const src = this.blobPath(refs[i].fileID);
      if (!fs.existsSync(src)) continue;
      const parts = rel(refs[i]).split('/').map((p) => safeName(p, '_'));
      const out = path.join(dest, ...parts);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(src, out);
      copied++;
    }
    ctx.log(`Copied ${copied.toLocaleString()} files to ${dest}`);
  }

  private extractContacts(ctx: JobContext, dest: string) {
    const db = this.openDb(...DOMAINS.contacts);
    if (!db) throw new Error('No contacts database in this backup.');
    try {
      const labels = new Map(all(db, 'SELECT ROWID, value FROM ABMultiValueLabel').map((r) => [num(r.ROWID), appleLabel(str(r.value))]));
      const keys = new Map(all(db, 'SELECT ROWID, value FROM ABMultiValueEntryKey').map((r) => [num(r.ROWID), str(r.value)]));
      const people = new Map<number, ContactCard>();
      for (const p of all(db, 'SELECT ROWID, First, Last, Organization, Note, Birthday FROM ABPerson')) {
        const c = emptyCard();
        c.given = str(p.First) || undefined;
        c.family = str(p.Last) || undefined;
        c.name = [c.given, c.family].filter(Boolean).join(' ');
        c.org = str(p.Organization) || undefined;
        c.note = str(p.Note) || undefined;
        const bday = Number(str(p.Birthday));
        if (str(p.Birthday) && Number.isFinite(bday)) c.birthday = new Date(appleTime(bday)).toISOString().slice(0, 10);
        people.set(num(p.ROWID), c);
      }
      const entries = new Map<number, string[]>();
      for (const e of all(db, 'SELECT parent_id, key, value FROM ABMultiValueEntry')) {
        const list = entries.get(num(e.parent_id)) ?? [];
        const k = keys.get(num(e.key)) ?? '';
        if (['Street', 'City', 'State', 'ZIP', 'Country'].includes(k) && str(e.value)) list.push(str(e.value));
        entries.set(num(e.parent_id), list);
      }
      for (const mv of all(db, 'SELECT UID, record_id, property, label, value FROM ABMultiValue')) {
        const c = people.get(num(mv.record_id));
        if (!c) continue;
        const label = labels.get(num(mv.label)) ?? '';
        const v = str(mv.value);
        switch (num(mv.property)) {
          case 3:
            if (v) c.phones.push({ value: v, type: phoneTypeFromLabel(label) });
            break;
          case 4:
            if (v) c.emails.push({ value: v, type: /work/i.test(label) ? 'WORK' : /home/i.test(label) ? 'HOME' : 'INTERNET' });
            break;
          case 5: {
            const parts = entries.get(num(mv.UID));
            if (parts?.length) c.addresses.push(parts.join(', '));
            break;
          }
          case 22:
            if (v) c.urls.push(v);
            break;
        }
      }
      const cards = [...people.values()];
      fs.writeFileSync(path.join(dest, 'Contacts.vcf'), toVCard(cards));
      fs.writeFileSync(
        path.join(dest, 'Contacts.csv'),
        csv([['Name', 'Organization', 'Phones', 'Emails', 'Addresses', 'Birthday', 'Note'], ...cards.map((c) => [c.name, c.org, c.phones.map((p) => p.value).join('; '), c.emails.map((e) => e.value).join('; '), c.addresses.join(' | '), c.birthday, c.note])]),
      );
      ctx.log(`Exported ${cards.length} contacts`);
    } finally {
      db.close();
    }
  }

  private extractMessages(ctx: JobContext, dest: string) {
    const db = this.openDb(...DOMAINS.sms);
    if (!db) throw new Error('No messages database in this backup.');
    const outDir = path.join(dest, 'Messages');
    fs.mkdirSync(outDir, { recursive: true });
    try {
      ctx.progress(null, 'Reading conversations…');
      const rows = all(
        db,
        `SELECT m.ROWID AS id, m.text, m.attributedBody, m.date, m.is_from_me, m.service, h.id AS handle,
                c.chat_identifier, c.display_name
         FROM message m
         LEFT JOIN handle h ON m.handle_id = h.ROWID
         LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         LEFT JOIN chat c ON c.ROWID = cmj.chat_id
         ORDER BY m.date`,
      );
      const attachments = new Map<number, { filename: string; name: string }[]>();
      for (const a of all(db, 'SELECT maj.message_id, a.filename, a.transfer_name FROM attachment a JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID')) {
        const list = attachments.get(num(a.message_id)) ?? [];
        list.push({ filename: str(a.filename), name: str(a.transfer_name) });
        attachments.set(num(a.message_id), list);
      }
      const table: (string | number)[][] = [['Date', 'Chat', 'From', 'Direction', 'Service', 'Text', 'Attachments']];
      const chats = new Map<string, string[]>();
      let copied = 0;
      for (let i = 0; i < rows.length; i++) {
        if (i % 500 === 0) {
          ctx.check();
          ctx.progress(i / rows.length, `Exporting message ${i.toLocaleString()} of ${rows.length.toLocaleString()}`);
        }
        const r = rows[i];
        const text = str(r.text) || attributedBodyText(r.attributedBody as Uint8Array | null) || '';
        const chat = str(r.display_name) || str(r.chat_identifier) || str(r.handle) || 'Unknown';
        const fromMe = num(r.is_from_me) === 1;
        const when = isoTime(appleTime(num(r.date)));
        const files: string[] = [];
        for (const a of attachments.get(num(r.id)) ?? []) {
          const rel = a.filename.replace(/^~\//, '').replace(/^\/var\/mobile\//, '');
          const ref = this.find('MediaDomain', rel);
          if (!ref) continue;
          const src = this.blobPath(ref.fileID);
          if (!fs.existsSync(src)) continue;
          const folder = path.join(outDir, 'Attachments', safeName(chat, 'chat'));
          fs.mkdirSync(folder, { recursive: true });
          const out = path.join(folder, `${num(r.id)}-${safeName(a.name || path.posix.basename(rel), 'file')}`);
          fs.copyFileSync(src, out);
          files.push(path.relative(outDir, out));
          copied++;
        }
        table.push([when, chat, fromMe ? 'Me' : str(r.handle), fromMe ? 'Sent' : 'Received', str(r.service), text, files.join('; ')]);
        const lines = chats.get(chat) ?? [];
        lines.push(`[${when}] ${fromMe ? 'Me' : str(r.handle) || chat}: ${text}${files.length ? ` [${files.length} attachment(s)]` : ''}`);
        chats.set(chat, lines);
      }
      fs.writeFileSync(path.join(outDir, 'Messages.csv'), csv(table));
      const tDir = path.join(outDir, 'Conversations');
      fs.mkdirSync(tDir, { recursive: true });
      for (const [chat, lines] of chats) fs.writeFileSync(path.join(tDir, `${safeName(chat, 'chat')}.txt`), lines.join('\n') + '\n');
      ctx.log(`Exported ${rows.length.toLocaleString()} messages in ${chats.size} conversations and ${copied} attachments`);
    } finally {
      db.close();
    }
  }

  private extractCalls(ctx: JobContext, dest: string) {
    const db = this.openDb(...DOMAINS.calls);
    if (!db) throw new Error('No call history in this backup.');
    try {
      const rows = all(db, 'SELECT * FROM ZCALLRECORD ORDER BY ZDATE DESC');
      const table: (string | number)[][] = [['Date', 'Number', 'Name', 'Direction', 'Answered', 'Duration (s)', 'Service']];
      for (const r of rows) {
        table.push([
          isoTime(appleTime(num(r.ZDATE))),
          str(r.ZADDRESS),
          str(r.ZNAME),
          num(r.ZORIGINATED) === 1 ? 'Outgoing' : 'Incoming',
          num(r.ZANSWERED) === 1 ? 'yes' : 'no',
          Math.round(num(r.ZDURATION)),
          str(r.ZSERVICE_PROVIDER).replace('com.apple.', ''),
        ]);
      }
      fs.writeFileSync(path.join(dest, 'Call History.csv'), csv(table));
      ctx.log(`Exported ${rows.length} calls`);
    } finally {
      db.close();
    }
  }

  private extractNotes(ctx: JobContext, dest: string, onlyDeleted: boolean) {
    const db = this.openDb(...DOMAINS.notes);
    if (!db) throw new Error('No notes in this backup.');
    const outDir = path.join(dest, onlyDeleted ? 'Recently Deleted Notes' : 'Notes');
    fs.mkdirSync(outDir, { recursive: true });
    try {
      const trashFolders = new Set(all(db, 'SELECT Z_PK FROM ZICCLOUDSYNCINGOBJECT WHERE ZFOLDERTYPE = 1').map((r) => num(r.Z_PK)));
      const folders = new Map(all(db, 'SELECT Z_PK, ZTITLE2 FROM ZICCLOUDSYNCINGOBJECT WHERE ZTITLE2 IS NOT NULL').map((r) => [num(r.Z_PK), str(r.ZTITLE2)]));
      const rows = all(
        db,
        `SELECT n.Z_PK, n.ZTITLE1, n.ZSNIPPET, n.ZMODIFICATIONDATE1, n.ZCREATIONDATE1, n.ZMARKEDFORDELETION, n.ZFOLDER, d.ZDATA
         FROM ZICCLOUDSYNCINGOBJECT n LEFT JOIN ZICNOTEDATA d ON d.ZNOTE = n.Z_PK WHERE n.ZTITLE1 IS NOT NULL`,
      );
      const index: (string | number)[][] = [['Title', 'Folder', 'Created', 'Modified', 'Deleted', 'File']];
      let n = 0;
      for (const r of rows) {
        const deleted = num(r.ZMARKEDFORDELETION) === 1 || trashFolders.has(num(r.ZFOLDER));
        if (onlyDeleted && !deleted) continue;
        let body: string | null = null;
        const data = r.ZDATA as Uint8Array | null;
        if (data && data.length) {
          try {
            body = noteText(new Uint8Array(zlib.gunzipSync(data)));
          } catch {
            body = null;
          }
        }
        const title = str(r.ZTITLE1) || 'Untitled';
        const text = body ?? `${title}\n\n${str(r.ZSNIPPET)}\n\n(Only a preview was available for this note.)`;
        const file = `${String(++n).padStart(4, '0')} ${safeName(title, 'note').slice(0, 60)}.txt`;
        fs.writeFileSync(path.join(outDir, file), text);
        index.push([title, folders.get(num(r.ZFOLDER)) ?? '', isoTime(appleTime(num(r.ZCREATIONDATE1))), isoTime(appleTime(num(r.ZMODIFICATIONDATE1))), deleted ? 'yes' : 'no', file]);
      }
      fs.writeFileSync(path.join(outDir, 'Index.csv'), csv(index));
      ctx.log(`Exported ${n} notes`);
    } finally {
      db.close();
    }
  }

  private async extractWhatsApp(ctx: JobContext, dest: string) {
    const outDir = path.join(dest, 'WhatsApp');
    fs.mkdirSync(outDir, { recursive: true });
    const ref = this.files("domain LIKE 'AppDomainGroup-group.net.whatsapp.%' AND relativePath = 'ChatStorage.sqlite'")[0];
    const db = ref ? this.openDb(ref.domain, ref.relativePath) : null;
    if (db) {
      try {
        const rows = all(
          db,
          `SELECT m.ZMESSAGEDATE, m.ZISFROMME, m.ZTEXT, m.ZFROMJID, s.ZPARTNERNAME, s.ZCONTACTJID, mi.ZMEDIALOCALPATH
           FROM ZWAMESSAGE m LEFT JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
           LEFT JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK ORDER BY m.ZMESSAGEDATE`,
        );
        const table: (string | number)[][] = [['Date', 'Chat', 'From', 'Direction', 'Text', 'Media']];
        const chats = new Map<string, string[]>();
        for (const r of rows) {
          const chat = str(r.ZPARTNERNAME) || str(r.ZCONTACTJID) || 'Unknown';
          const me = num(r.ZISFROMME) === 1;
          const when = isoTime(appleTime(num(r.ZMESSAGEDATE)));
          const from = me ? 'Me' : str(r.ZFROMJID).split('@')[0] || chat;
          table.push([when, chat, from, me ? 'Sent' : 'Received', str(r.ZTEXT), str(r.ZMEDIALOCALPATH)]);
          const lines = chats.get(chat) ?? [];
          lines.push(`[${when}] ${from}: ${str(r.ZTEXT) || (str(r.ZMEDIALOCALPATH) ? `<media ${path.posix.basename(str(r.ZMEDIALOCALPATH))}>` : '')}`);
          chats.set(chat, lines);
        }
        fs.writeFileSync(path.join(outDir, 'WhatsApp Messages.csv'), csv(table));
        const tDir = path.join(outDir, 'Conversations');
        fs.mkdirSync(tDir, { recursive: true });
        for (const [chat, lines] of chats) fs.writeFileSync(path.join(tDir, `${safeName(chat, 'chat')}.txt`), lines.join('\n') + '\n');
        ctx.log(`Exported ${rows.length.toLocaleString()} WhatsApp messages in ${chats.size} chats`);
      } finally {
        db.close();
      }
    }
    await this.copyRefs(ctx, this.whatsappMediaRefs(), path.join(outDir, 'Media'), (r) => r.relativePath.replace(/^Message\/Media\//, ''));
  }
}
