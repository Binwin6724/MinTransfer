// Small binary decoders used by the iOS backup reader:
//  - Apple binary property lists (bplist00)
//  - the text of an Apple Notes protobuf
//  - the plain text inside an iMessage `attributedBody` (NSArchiver typedstream)
// Pure functions over Uint8Array, unit-tested.

export type PlistValue = null | boolean | number | bigint | string | Date | Uint8Array | PlistValue[] | { [k: string]: PlistValue } | { UID: number };

const APPLE_EPOCH = 978307200;

function readUInt(b: Uint8Array, off: number, size: number): number {
  let v = 0;
  for (let i = 0; i < size; i++) v = v * 256 + b[off + i];
  return v;
}

/** Parses a binary plist. Throws on malformed input. */
export function parseBplist(buf: Uint8Array): PlistValue {
  const magic = String.fromCharCode(...buf.subarray(0, 8));
  if (!magic.startsWith('bplist0')) throw new Error('Not a binary plist');
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = readUInt(buf, t + 8, 8);
  const top = readUInt(buf, t + 16, 8);
  const tableOff = readUInt(buf, t + 24, 8);
  if (numObjects > 5_000_000 || tableOff >= buf.length) throw new Error('Corrupt binary plist');
  const offsets = new Array<number>(numObjects);
  for (let i = 0; i < numObjects; i++) offsets[i] = readUInt(buf, tableOff + i * offSize, offSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const depthGuard = new Set<number>();

  const lengthAt = (off: number, low: number): [number, number] => {
    if (low !== 0x0f) return [low, off + 1];
    const marker = buf[off + 1];
    const size = 1 << (marker & 0x0f);
    return [readUInt(buf, off + 2, size), off + 2 + size];
  };

  const parse = (idx: number): PlistValue => {
    if (depthGuard.has(idx)) throw new Error('Cyclic binary plist');
    const off = offsets[idx];
    const marker = buf[off];
    const hi = marker >> 4;
    const low = marker & 0x0f;
    switch (hi) {
      case 0x0:
        return low === 0x8 ? false : low === 0x9 ? true : null;
      case 0x1: {
        const size = 1 << low;
        if (size === 8) {
          const v = view.getBigInt64(off + 1);
          return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        }
        if (size === 16) return Number(view.getBigUint64(off + 9));
        return readUInt(buf, off + 1, size);
      }
      case 0x2:
        return low === 2 ? view.getFloat32(off + 1) : view.getFloat64(off + 1);
      case 0x3:
        return new Date((view.getFloat64(off + 1) + APPLE_EPOCH) * 1000);
      case 0x4: {
        const [len, start] = lengthAt(off, low);
        return buf.slice(start, start + len);
      }
      case 0x5: {
        const [len, start] = lengthAt(off, low);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(buf[start + i]);
        return s;
      }
      case 0x6: {
        const [len, start] = lengthAt(off, low);
        let s = '';
        for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint16(start + i * 2));
        return s;
      }
      case 0x8:
        return { UID: readUInt(buf, off + 1, low + 1) };
      case 0xa: {
        const [len, start] = lengthAt(off, low);
        depthGuard.add(idx);
        const arr: PlistValue[] = [];
        for (let i = 0; i < len; i++) arr.push(parse(readUInt(buf, start + i * refSize, refSize)));
        depthGuard.delete(idx);
        return arr;
      }
      case 0xd: {
        const [len, start] = lengthAt(off, low);
        depthGuard.add(idx);
        const obj: { [k: string]: PlistValue } = {};
        for (let i = 0; i < len; i++) {
          const k = parse(readUInt(buf, start + i * refSize, refSize));
          const v = parse(readUInt(buf, start + (len + i) * refSize, refSize));
          obj[String(k)] = v;
        }
        depthGuard.delete(idx);
        return obj;
      }
      default:
        throw new Error(`Unsupported bplist marker 0x${marker.toString(16)}`);
    }
  };
  return parse(top);
}

/** Size recorded in an iOS 10+ Manifest.db `file` blob (an NSKeyedArchiver MBFile). */
export function mbFileSize(blob: Uint8Array | null | undefined): number | null {
  if (!blob || blob.length < 40) return null;
  try {
    const root = parseBplist(blob) as { $objects?: PlistValue[] };
    const objs = root.$objects;
    if (!Array.isArray(objs)) return null;
    for (const o of objs) {
      if (o && typeof o === 'object' && !Array.isArray(o) && 'Size' in o) {
        const s = (o as Record<string, PlistValue>).Size;
        return typeof s === 'number' ? s : typeof s === 'bigint' ? Number(s) : null;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

// ------------------------------------------------------------------ protobuf (Apple Notes)

interface PbField {
  no: number;
  wire: number;
  value: number | Uint8Array;
}

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let mul = 1;
  for (let i = 0; i < 10; i++) {
    const byte = b[pos++];
    if (byte === undefined) throw new Error('truncated varint');
    result += (byte & 0x7f) * mul;
    if ((byte & 0x80) === 0) return [result, pos];
    mul *= 128;
  }
  throw new Error('varint too long');
}

export function pbFields(b: Uint8Array): PbField[] {
  const out: PbField[] = [];
  let pos = 0;
  while (pos < b.length) {
    const [key, p1] = readVarint(b, pos);
    pos = p1;
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) {
      const [v, p2] = readVarint(b, pos);
      out.push({ no, wire, value: v });
      pos = p2;
    } else if (wire === 2) {
      const [len, p2] = readVarint(b, pos);
      if (p2 + len > b.length) throw new Error('truncated field');
      out.push({ no, wire, value: b.subarray(p2, p2 + len) });
      pos = p2 + len;
    } else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  }
  return out;
}

function pbChild(b: Uint8Array, no: number): Uint8Array | null {
  const f = pbFields(b).find((x) => x.no === no && x.wire === 2);
  return f ? (f.value as Uint8Array) : null;
}

/** Text of a decompressed NoteStore `ZICNOTEDATA.ZDATA` protobuf: NoteStoreProto.document(2).note(3).note_text(2). */
export function noteText(decompressed: Uint8Array): string | null {
  try {
    const doc = pbChild(decompressed, 2);
    const note = doc && pbChild(doc, 3);
    const text = note && pbChild(note, 2);
    return text ? new TextDecoder().decode(text).replace(/￼/g, '[attachment]') : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ iMessage attributedBody

/**
 * iOS 16+ often stores message text only in `attributedBody`, an NSArchiver typedstream.
 * The string follows the "NSString" class entry as `+` <length> <utf8 bytes>, where the length
 * is one byte, or 0x81 followed by a little-endian uint16, or 0x82 + uint32.
 */
export function attributedBodyText(blob: Uint8Array | null | undefined): string | null {
  if (!blob || blob.length < 16) return null;
  const marker = new TextEncoder().encode('NSString');
  let at = -1;
  outer: for (let i = 0; i <= blob.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) if (blob[i + j] !== marker[j]) continue outer;
    at = i + marker.length;
    break;
  }
  if (at < 0) return null;
  const plus = blob.indexOf(0x2b, at); // '+'
  if (plus < 0 || plus - at > 12) return null;
  let pos = plus + 1;
  let len = blob[pos++];
  if (len === 0x81) {
    len = blob[pos] | (blob[pos + 1] << 8);
    pos += 2;
  } else if (len === 0x82) {
    len = (blob[pos] | (blob[pos + 1] << 8) | (blob[pos + 2] << 16) | (blob[pos + 3] << 24)) >>> 0;
    pos += 4;
  }
  if (!len || pos + len > blob.length) return null;
  return new TextDecoder().decode(blob.subarray(pos, pos + len));
}
