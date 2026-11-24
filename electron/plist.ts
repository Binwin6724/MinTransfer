// Reads XML or binary property lists from disk.
import fs from 'node:fs';
import plist from 'plist';
import { parseBplist, PlistValue } from '../shared/binary';

export function parsePlist(buf: Buffer): PlistValue {
  if (buf.subarray(0, 7).toString('latin1') === 'bplist0') return parseBplist(new Uint8Array(buf));
  return plist.parse(buf.toString('utf8')) as unknown as PlistValue;
}

export function readPlistFile(file: string): PlistValue | null {
  if (!fs.existsSync(file)) return null;
  return parsePlist(fs.readFileSync(file));
}
