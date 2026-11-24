// Serves preview files with HTTP range support (separate from preview.ts so it can be unit-tested without Electron).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
};

/** Serves a file with HTTP range support, so videos and audio can seek. */
export function serveFile(file: string, range: string | null): Response {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return new Response('Not found', { status: 404 });
  }
  const type = MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    start = Math.max(0, start);
    end = Math.max(start, end);
    const body = Readable.toWeb(fs.createReadStream(file, { start, end })) as unknown as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { 'Content-Type': type, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes' },
    });
  }
  const body = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' } });
}
