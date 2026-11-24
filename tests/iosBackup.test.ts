// Builds a small but structurally real iOS backup (Manifest.db + hashed files + the app
// databases iOS uses) and checks that browsing and extraction recover the right data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import plist from 'plist';
import initSqlJs, { Database } from 'sql.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IosBackupReader } from '../electron/iosBackup';
import type { JobContext } from '../electron/jobs';

const APPLE = 978307200;
let root: string;
let backup: string;

const ctx: JobContext = { signal: new AbortController().signal, progress() {}, detail() {}, log() {}, check() {} };

function pbLen(no: number, payload: Uint8Array): Uint8Array {
  const out = [no * 8 + 2];
  let n = payload.length;
  while (n > 127) {
    out.push((n & 0x7f) | 0x80);
    n >>= 7;
  }
  out.push(n);
  return new Uint8Array([...out, ...payload]);
}

beforeAll(async () => {
  const SQL = await initSqlJs();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-ios-'));
  backup = path.join(root, '00008110-TEST');
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(path.join(backup, 'Manifest.plist'), plist.build({ IsEncrypted: false, Version: '10.0' }));
  fs.writeFileSync(path.join(backup, 'Info.plist'), plist.build({ 'Device Name': 'Test iPhone', 'Product Type': 'iPhone15,2', 'Product Version': '17.5', 'Target Identifier': '00008110-TEST', 'Last Backup Date': new Date('2026-01-01T00:00:00Z') }));

  const manifest = new SQL.Database();
  manifest.run('CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)');
  const add = (domain: string, rel: string, data: Uint8Array | string) => {
    const id = crypto.createHash('sha1').update(`${domain}-${rel}`).digest('hex');
    fs.mkdirSync(path.join(backup, id.slice(0, 2)), { recursive: true });
    fs.writeFileSync(path.join(backup, id.slice(0, 2), id), data);
    manifest.run('INSERT INTO Files VALUES (?, ?, ?, 1, NULL)', [id, domain, rel]);
  };
  const dbBytes = (db: Database) => {
    const b = db.export();
    db.close();
    return b;
  };

  add('CameraRollDomain', 'Media/DCIM/100APPLE/IMG_0001.JPG', 'jpeg-1');
  add('CameraRollDomain', 'Media/DCIM/100APPLE/IMG_0002.JPG', 'jpeg-2-deleted');
  manifest.run("INSERT INTO Files VALUES ('dir', 'CameraRollDomain', 'Media/DCIM', 2, NULL)");

  const photos = new SQL.Database();
  photos.run('CREATE TABLE ZASSET (Z_PK INTEGER, ZDIRECTORY TEXT, ZFILENAME TEXT, ZTRASHEDSTATE INTEGER)');
  photos.run("INSERT INTO ZASSET VALUES (1, 'DCIM/100APPLE', 'IMG_0001.JPG', 0), (2, 'DCIM/100APPLE', 'IMG_0002.JPG', 1)");
  add('CameraRollDomain', 'Media/PhotoData/Photos.sqlite', dbBytes(photos));

  const ab = new SQL.Database();
  ab.run('CREATE TABLE ABPerson (ROWID INTEGER, First TEXT, Last TEXT, Organization TEXT, Note TEXT, Birthday TEXT)');
  ab.run('CREATE TABLE ABMultiValue (UID INTEGER, record_id INTEGER, property INTEGER, identifier INTEGER, label INTEGER, value TEXT)');
  ab.run('CREATE TABLE ABMultiValueLabel (ROWID INTEGER, value TEXT)');
  ab.run('CREATE TABLE ABMultiValueEntry (parent_id INTEGER, key INTEGER, value TEXT)');
  ab.run('CREATE TABLE ABMultiValueEntryKey (ROWID INTEGER, value TEXT)');
  ab.run("INSERT INTO ABPerson VALUES (1, 'Grace', 'Hopper', 'Navy', NULL, NULL), (2, 'Alan', 'Turing', NULL, 'Note, with comma', NULL)");
  ab.run("INSERT INTO ABMultiValueLabel VALUES (1, '_$!<Mobile>!$_'), (2, '_$!<Home>!$_')");
  ab.run("INSERT INTO ABMultiValue VALUES (10, 1, 3, 0, 1, '+1 555 0100'), (11, 1, 4, 0, 2, 'grace@example.com'), (12, 2, 5, 0, 2, NULL)");
  ab.run("INSERT INTO ABMultiValueEntryKey VALUES (1, 'Street'), (2, 'City')");
  ab.run("INSERT INTO ABMultiValueEntry VALUES (12, 1, '1 Bletchley Park'), (12, 2, 'Milton Keynes')");
  add('HomeDomain', 'Library/AddressBook/AddressBook.sqlitedb', dbBytes(ab));

  const sms = new SQL.Database();
  sms.run('CREATE TABLE message (ROWID INTEGER, text TEXT, attributedBody BLOB, date INTEGER, is_from_me INTEGER, service TEXT, handle_id INTEGER)');
  sms.run('CREATE TABLE handle (ROWID INTEGER, id TEXT)');
  sms.run('CREATE TABLE chat (ROWID INTEGER, chat_identifier TEXT, display_name TEXT)');
  sms.run('CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)');
  sms.run('CREATE TABLE attachment (ROWID INTEGER, filename TEXT, transfer_name TEXT)');
  sms.run('CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER)');
  const enc = (s: string) => new TextEncoder().encode(s);
  const body = new Uint8Array([...enc('streamtyped NSString'), 1, 0x94, 0x84, 1, 0x2b, 14, ...enc('From iOS 16 :)')]);
  const ns = (sec: number) => (sec - APPLE) * 1e9;
  sms.run("INSERT INTO handle VALUES (1, '+15550100')");
  sms.run("INSERT INTO chat VALUES (1, '+15550100', '')");
  sms.run("INSERT INTO message VALUES (1, 'Hello, world', NULL, ?, 0, 'iMessage', 1)", [ns(1767225600)]);
  sms.run("INSERT INTO message VALUES (2, NULL, ?, ?, 1, 'iMessage', 1)", [body, ns(1767225660)]);
  sms.run('INSERT INTO chat_message_join VALUES (1, 1), (1, 2)');
  sms.run("INSERT INTO attachment VALUES (1, '~/Library/SMS/Attachments/ab/01/IMG_9.HEIC', 'IMG_9.HEIC')");
  sms.run('INSERT INTO message_attachment_join VALUES (1, 1)');
  add('HomeDomain', 'Library/SMS/sms.db', dbBytes(sms));
  add('MediaDomain', 'Library/SMS/Attachments/ab/01/IMG_9.HEIC', 'heic-bytes');

  const calls = new SQL.Database();
  calls.run('CREATE TABLE ZCALLRECORD (Z_PK INTEGER, ZADDRESS TEXT, ZNAME TEXT, ZDATE REAL, ZDURATION REAL, ZORIGINATED INTEGER, ZANSWERED INTEGER, ZSERVICE_PROVIDER TEXT)');
  calls.run("INSERT INTO ZCALLRECORD VALUES (1, '+15550100', 'Grace', ?, 61.4, 1, 1, 'com.apple.Telephony')", [1767225600 - APPLE]);
  add('HomeDomain', 'Library/CallHistoryDB/CallHistory.storedata', dbBytes(calls));

  const notes = new SQL.Database();
  notes.run('CREATE TABLE ZICCLOUDSYNCINGOBJECT (Z_PK INTEGER, ZTITLE1 TEXT, ZTITLE2 TEXT, ZSNIPPET TEXT, ZMODIFICATIONDATE1 REAL, ZCREATIONDATE1 REAL, ZMARKEDFORDELETION INTEGER, ZFOLDER INTEGER, ZFOLDERTYPE INTEGER)');
  notes.run('CREATE TABLE ZICNOTEDATA (Z_PK INTEGER, ZNOTE INTEGER, ZDATA BLOB)');
  notes.run("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (100, NULL, 'Notes', NULL, NULL, NULL, 0, NULL, 0), (101, NULL, 'Recently Deleted', NULL, NULL, NULL, 0, NULL, 1)");
  notes.run("INSERT INTO ZICCLOUDSYNCINGOBJECT VALUES (1, 'Groceries', NULL, 'milk', 0, 0, 0, 100, NULL), (2, 'Old secret', NULL, 'gone', 0, 0, 0, 101, NULL)");
  const proto = (t: string) => zlib.gzipSync(Buffer.from(pbLen(2, pbLen(3, pbLen(2, enc(t))))));
  notes.run('INSERT INTO ZICNOTEDATA VALUES (1, 1, ?), (2, 2, ?)', [proto('Groceries\nmilk, bread'), proto('Old secret\nthe deleted body')]);
  add('AppDomainGroup-group.com.apple.notes', 'NoteStore.sqlite', dbBytes(notes));

  add('MediaDomain', 'Media/Recordings/20260101 101010.m4a', 'audio');

  fs.writeFileSync(path.join(backup, 'Manifest.db'), manifest.export());
  manifest.close();
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('iOS backup reader', () => {
  it('lists what can be recovered', async () => {
    const r = await IosBackupReader.open(backup);
    const groups = Object.fromEntries(r.groups().map((g) => [g.id, g]));
    r.close();
    expect(groups.photos.count).toBe(2);
    expect(groups['deleted-photos'].count).toBe(1);
    expect(groups.contacts.count).toBe(2);
    expect(groups.messages.count).toBe(2);
    expect(groups.calls.count).toBe(1);
    expect(groups.notes.count).toBe(2);
    expect(groups['deleted-notes'].count).toBe(1);
    expect(groups.voicememos.count).toBe(1);
    expect(groups.whatsapp.available).toBe(false);
  });

  it('extracts photos, deleted photos, contacts, messages, calls and notes', async () => {
    const out = path.join(root, 'out');
    const r = await IosBackupReader.open(backup);
    for (const g of ['photos', 'deleted-photos', 'contacts', 'messages', 'calls', 'notes', 'deleted-notes', 'voicememos']) await r.extract(ctx, g, out);
    r.close();
    expect(fs.readFileSync(path.join(out, 'Photos', '100APPLE', 'IMG_0001.JPG'), 'utf8')).toBe('jpeg-1');
    expect(fs.readdirSync(path.join(out, 'Recently Deleted Photos'))).toEqual(['IMG_0002.JPG']);

    const vcf = fs.readFileSync(path.join(out, 'Contacts.vcf'), 'utf8');
    expect(vcf).toContain('FN:Grace Hopper');
    expect(vcf).toContain('TEL;TYPE=CELL:+1 555 0100');
    expect(vcf).toContain('EMAIL;TYPE=HOME:grace@example.com');
    expect(vcf).toContain('ADR:;;1 Bletchley Park\\, Milton Keynes;;;;');
    expect(vcf).toContain('NOTE:Note\\, with comma');

    const msgs = fs.readFileSync(path.join(out, 'Messages', 'Messages.csv'), 'utf8');
    expect(msgs).toContain('2026-01-01 00:00:00Z,+15550100,+15550100,Received,iMessage,"Hello, world"');
    expect(msgs).toContain('From iOS 16 :)');
    const att = fs.readdirSync(path.join(out, 'Messages', 'Attachments', '+15550100'));
    expect(att).toEqual(['1-IMG_9.HEIC']);
    expect(fs.readFileSync(path.join(out, 'Messages', 'Conversations', '+15550100.txt'), 'utf8')).toMatch(/Me: From iOS 16/);

    expect(fs.readFileSync(path.join(out, 'Call History.csv'), 'utf8')).toContain('2026-01-01 00:00:00Z,+15550100,Grace,Outgoing,yes,61,Telephony');

    const notes = fs.readdirSync(path.join(out, 'Notes')).sort();
    expect(notes).toContain('Index.csv');
    expect(fs.readFileSync(path.join(out, 'Notes', notes.find((n) => n.includes('Groceries'))!), 'utf8')).toBe('Groceries\nmilk, bread');
    const deleted = fs.readdirSync(path.join(out, 'Recently Deleted Notes')).filter((f) => f.endsWith('.txt'));
    expect(deleted).toHaveLength(1);
    expect(fs.readFileSync(path.join(out, 'Recently Deleted Notes', deleted[0]), 'utf8')).toContain('the deleted body');
    expect(fs.existsSync(path.join(out, 'Voice Memos', '20260101 101010.m4a'))).toBe(true);
  });

  it('refuses encrypted backups for browsing', async () => {
    const enc = path.join(root, 'enc');
    fs.mkdirSync(enc);
    fs.writeFileSync(path.join(enc, 'Manifest.plist'), plist.build({ IsEncrypted: true }));
    fs.writeFileSync(path.join(enc, 'Manifest.db'), 'encrypted-bytes');
    await expect(IosBackupReader.open(enc)).rejects.toThrow(/encrypted/);
    expect(IosBackupReader.isEncrypted(enc)).toBe(true);
  });
});
