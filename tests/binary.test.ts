import { describe, expect, it } from 'vitest';
import { attributedBodyText, noteText, parseBplist } from '../shared/binary';

// Generated with: plutil -convert binary1 (see the XML in tests/fixtures comment below)
const BPLIST = 'YnBsaXN0MDDaAQIDBAUGBwgJCgsMDQ4PEBEVFhdSUGlXVmVyc2lvblRCbG9iU0JpZ1NOZWdUV2hlblRMaXN0VUNvdW50VE5hbWVbSXNFbmNyeXB0ZWQjQAwAAAAAAABUMTAuMEMBAgMTAAAAASoF8gAT//////////kzQcWh2lKAAACjEhMUUWEQAQgQKmwAWgBvAOsgGQBzACAAaQBQAGgAbwBuAGUJCB0gKC0xNTo/RUpWX2RocXqDh4mLjI6nAAAAAAAAAQEAAAAAAAAAGAAAAAAAAAAAAAAAAAAAAKg=';

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

describe('binary plist', () => {
  it('parses a plist written by plutil', () => {
    const v = parseBplist(new Uint8Array(Buffer.from(BPLIST, 'base64'))) as Record<string, unknown>;
    expect(v.IsEncrypted).toBe(true);
    expect(v.Version).toBe('10.0');
    expect(v.Count).toBe(42);
    expect(v.Big).toBe(5000000000);
    expect(v.Neg).toBe(-7);
    expect(v.Pi).toBe(3.5);
    expect((v.When as Date).toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(Array.from(v.Blob as Uint8Array)).toEqual([1, 2, 3]);
    expect(v.Name).toBe('Zoë’s iPhone');
    expect(v.List).toEqual(['a', 1, false]);
  });
  it('rejects non-plists', () => {
    expect(() => parseBplist(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toThrow();
  });
});

describe('Apple Notes protobuf', () => {
  it('extracts note text from document.note.note_text', () => {
    const text = new TextEncoder().encode('Shopping\nMilk, eggs ￼');
    const note = pbLen(2, text);
    const doc = new Uint8Array([0x10, 0x01, ...pbLen(3, note)]); // version varint + note
    const root = new Uint8Array([0x08, 0x00, ...pbLen(2, doc)]);
    expect(noteText(root)).toBe('Shopping\nMilk, eggs [attachment]');
  });
  it('returns null for garbage', () => {
    expect(noteText(new Uint8Array([0xff, 0xff, 0xff]))).toBeNull();
  });
});

describe('iMessage attributedBody', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('reads short strings', () => {
    const blob = new Uint8Array([4, 11, ...enc('streamtyped'), 0x81, 0xe8, 0x03, 0x84, 1, 0x40, 0x84, 0x84, 0x84, ...enc('NSString'), 1, 0x94, 0x84, 1, 0x2b, 5, ...enc('Hello'), 0x86]);
    expect(attributedBodyText(blob)).toBe('Hello');
  });
  it('reads long strings with a two-byte length', () => {
    const long = 'x'.repeat(300);
    const blob = new Uint8Array([...enc('streamtyped....NSString'), 1, 0x94, 0x84, 1, 0x2b, 0x81, 300 & 0xff, 300 >> 8, ...enc(long)]);
    expect(attributedBodyText(blob)).toBe(long);
  });
  it('returns null without NSString', () => {
    expect(attributedBodyText(enc('nothing to see here at all'))).toBeNull();
  });
});
