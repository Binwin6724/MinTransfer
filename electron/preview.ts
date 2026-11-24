// Previews in Transfer: a file on the phone is copied into a private cache and shown in the app
// through the mt-preview:// scheme, which only serves files from that cache.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage, protocol } from 'electron';
import { log } from './logger';
import { serveFile } from './serve';
import { mediaKind } from '../shared/ios';
import type { CopyItem, RemoteFile } from '../shared/transfer';
import type { JobContext } from './jobs';

export const PREVIEW_SCHEME = 'mt-preview';
/** Previews bigger than this aren't copied automatically (a long 4K video can be several GB). */
export const PREVIEW_MAX = 2 * 1024 ** 3;
const CACHE_LIMIT = 3 * 1024 ** 3;

export interface Preview {
  /** URL the renderer can show (mt-preview://…), or null when only "open in another app" works. */
  url: string | null;
  kind: 'image' | 'video' | 'audio' | 'other';
  /** Cached copy on this computer, for "Open in another app". */
  localPath: string;
}

/** Must run before app ready. */
export function registerPreviewScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
}

export class PreviewCache {
  constructor(private readonly dir: string) {}

  /** Serves mt-preview://file/<name> from the cache folder only. */
  install() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    protocol.handle(PREVIEW_SCHEME, (req) => {
      const name = decodeURIComponent(new URL(req.url).pathname.replace(/^\//, ''));
      if (!/^[a-f0-9]{40}(\.[a-z0-9]{1,6})?$/i.test(name)) return new Response('Not found', { status: 404 });
      return serveFile(path.join(this.dir, name), req.headers.get('range'));
    });
  }

  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }

  /** Whether `p` is a file inside the cache (for "Open in another app"). */
  owns(p: string): boolean {
    const rel = path.relative(this.dir, p);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && fs.existsSync(p);
  }

  async get(deviceId: string, file: RemoteFile, copy: (ctx: JobContext, item: CopyItem) => Promise<void>, signal: AbortSignal): Promise<Preview> {
    if (file.dir) throw new Error('Folders can’t be previewed.');
    if (file.size > PREVIEW_MAX) throw new Error('This file is too big to preview. Copy it to the computer instead.');
    const ext = (path.posix.extname(file.path).slice(1).toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin').slice(0, 6);
    const id = crypto.createHash('sha1').update(`${deviceId}\n${file.path}\n${file.size}\n${file.mtime}`).digest('hex');
    const local = path.join(this.dir, `${id}.${ext}`);
    if (!fs.existsSync(local) || fs.statSync(local).size !== file.size) {
      this.trim(file.size);
      const ctx: JobContext = { signal, progress() {}, detail() {}, log: (l) => log.info('preview', l), check() {} };
      await copy(ctx, { remote: file.path, local, size: file.size, mtime: file.mtime });
      if (!fs.existsSync(local)) throw new Error('The phone didn’t send this file.');
    }
    const kind = mediaKind(file.path) ?? 'other';
    if (kind === 'image' && /^(heic|heif|dng|tif|tiff)$/.test(ext)) {
      // Chromium can't show HEIC (iPhone photos) or RAW. The system thumbnailer can (Quick Look on
      // macOS; on Windows when the HEIF extension is installed), so show a large JPEG made by it.
      const jpg = path.join(this.dir, `${id}.jpg`);
      if (!fs.existsSync(jpg)) {
        try {
          const img = await nativeImage.createThumbnailFromPath(local, { width: 2400, height: 2400 });
          if (!img.isEmpty()) fs.writeFileSync(jpg, img.toJPEG(90));
        } catch (err) {
          log.warn('preview conversion failed', String(err));
        }
      }
      return { url: fs.existsSync(jpg) ? `${PREVIEW_SCHEME}://file/${id}.jpg` : null, kind: 'image', localPath: local };
    }
    return { url: kind === 'other' ? null : `${PREVIEW_SCHEME}://file/${id}.${ext}`, kind, localPath: local };
  }

  /** Keeps the cache under its limit by removing the oldest previews. */
  private trim(incoming: number) {
    try {
      const files = fs
        .readdirSync(this.dir)
        .map((f) => {
          const p = path.join(this.dir, f);
          const s = fs.statSync(p);
          return { p, size: s.size, at: s.atimeMs };
        })
        .sort((a, b) => a.at - b.at);
      let total = files.reduce((n, f) => n + f.size, 0) + incoming;
      for (const f of files) {
        if (total <= CACHE_LIMIT) break;
        fs.rmSync(f.p, { force: true });
        total -= f.size;
      }
    } catch {
      /* cache is best effort */
    }
  }
}
