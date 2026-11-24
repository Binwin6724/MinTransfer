import { describe, expect, it } from 'vitest';
import { androidContactsToCards, appleLabel, backupFolderName, csv, formatBytes, safeName, toVCard } from '../shared/export';

describe('exports', () => {
  it('escapes CSV', () => {
    expect(csv([['a', 'b,c', 'say "hi"', null, 3]])).toBe('a,"b,c","say ""hi""",,3\r\n');
    expect(csv([['line\nbreak']])).toBe('"line\nbreak"\r\n');
  });
  it('builds vCards from Android contact rows', () => {
    const cards = androidContactsToCards([
      { raw_contact_id: '1', mimetype: 'vnd.android.cursor.item/name', data1: 'Ada Lovelace', data2: 'Ada', data3: 'Lovelace' },
      { raw_contact_id: '1', mimetype: 'vnd.android.cursor.item/phone_v2', data1: '+44 20 1234', data2: '2' },
      { raw_contact_id: '1', mimetype: 'vnd.android.cursor.item/phone_v2', data1: '+44 20 1234', data2: '2' },
      { raw_contact_id: '1', mimetype: 'vnd.android.cursor.item/email_v2', data1: 'ada@example.com', data2: '2' },
      { raw_contact_id: '2', mimetype: 'vnd.android.cursor.item/organization', data1: 'Acme; Inc' },
      { raw_contact_id: '3', mimetype: 'vnd.android.cursor.item/name', data1: '' },
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0].phones).toHaveLength(1);
    const v = toVCard(cards);
    expect(v).toContain('FN:Ada Lovelace');
    expect(v).toContain('N:Lovelace;Ada;;;');
    expect(v).toContain('TEL;TYPE=CELL:+44 20 1234');
    expect(v).toContain('EMAIL;TYPE=WORK:ada@example.com');
    expect(v.split('BEGIN:VCARD')).toHaveLength(2);
  });
  it('escapes vCard values and falls back to organisation', () => {
    const v = toVCard([{ name: '', org: 'Acme; Inc', phones: [], emails: [], addresses: [], urls: [], note: 'a\nb' }]);
    expect(v).toContain('FN:Acme\\; Inc');
    expect(v).toContain('NOTE:a\\nb');
  });
  it('cleans Apple labels', () => {
    expect(appleLabel('_$!<Mobile>!$_')).toBe('Mobile');
    expect(appleLabel('Custom')).toBe('Custom');
  });
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.50 KB');
    expect(formatBytes(128 * 1024 ** 3)).toBe('128 GB');
    expect(formatBytes(undefined)).toBe('—');
  });
  it('makes Windows-safe names', () => {
    expect(safeName('a<b>:c?.')).toBe('a_b__c_');
    expect(safeName('   ')).toBe('item');
    expect(backupFolderName('Ana’s iPhone', new Date(2026, 10, 23, 9, 5, 7))).toBe('Ana’s iPhone 2026-11-23 090507');
  });
});
