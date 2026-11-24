// Finds (and for Android, downloads) the helper tools MinTransfer drives:
//   Android: adb from Google's Android SDK Platform-Tools
//   iOS:     libimobiledevice (idevice_id, ideviceinfo, idevicepair, idevicebackup2)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './exec';
import { log } from './logger';
import type { ToolId, ToolStatus } from '../shared/types';

const EXE = process.platform === 'win32' ? '.exe' : '';
export const IOS_TOOLS = ['idevice_id', 'ideviceinfo', 'idevicepair', 'idevicebackup2'] as const;
export type IosTool = (typeof IOS_TOOLS)[number];

export const PLATFORM_TOOLS_TERMS = 'https://developer.android.com/studio/releases/platform-tools';
export function platformToolsUrl(): string {
  const p = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  return `https://dl.google.com/android/repository/platform-tools-latest-${p}.zip`;
}

export interface ToolPaths {
  adb?: string;
  ios: Partial<Record<IosTool, string>>;
}

export class Tools {
  paths: ToolPaths = { ios: {} };
  status: ToolStatus[] = [];

  constructor(
    private readonly userToolsDir: string,
    private readonly resourcesDir: string,
    private customDir: () => string,
  ) {}

  get downloadedPlatformTools() {
    return path.join(this.userToolsDir, 'platform-tools');
  }

  private searchDirs(kind: ToolId): { dir: string; source: ToolStatus['source'] }[] {
    const home = os.homedir();
    const dirs: { dir: string; source: ToolStatus['source'] }[] = [];
    const custom = this.customDir();
    if (custom) dirs.push({ dir: custom, source: 'custom' }, { dir: path.join(custom, 'platform-tools'), source: 'custom' });
    if (kind === 'adb') {
      dirs.push({ dir: this.downloadedPlatformTools, source: 'downloaded' });
      dirs.push({ dir: path.join(this.resourcesDir, 'tools', 'platform-tools'), source: 'bundled' });
      const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
      if (sdk) dirs.push({ dir: path.join(sdk, 'platform-tools'), source: 'system' });
      if (process.platform === 'darwin') dirs.push({ dir: path.join(home, 'Library/Android/sdk/platform-tools'), source: 'system' });
      if (process.platform === 'win32' && process.env.LOCALAPPDATA)
        dirs.push({ dir: path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools'), source: 'system' });
    } else {
      dirs.push({ dir: path.join(this.userToolsDir, 'libimobiledevice'), source: 'downloaded' });
      dirs.push({ dir: path.join(this.resourcesDir, 'tools', 'libimobiledevice'), source: 'bundled' });
    }
    if (process.platform === 'darwin') {
      dirs.push({ dir: '/opt/homebrew/bin', source: 'system' }, { dir: '/usr/local/bin', source: 'system' }, { dir: '/opt/local/bin', source: 'system' });
    }
    for (const d of (process.env.PATH ?? '').split(path.delimiter)) if (d) dirs.push({ dir: d, source: 'system' });
    return dirs;
  }

  private locate(kind: ToolId, name: string): { file: string; source: ToolStatus['source'] } | null {
    for (const { dir, source } of this.searchDirs(kind)) {
      const file = path.join(dir, name + EXE);
      try {
        if (fs.statSync(file).isFile()) return { file, source };
      } catch {
        /* keep looking */
      }
    }
    return null;
  }

  async refresh(): Promise<ToolStatus[]> {
    const adb = this.locate('adb', 'adb');
    let adbVersion: string | undefined;
    if (adb) {
      try {
        const r = await run(adb.file, ['version'], { timeoutMs: 8000 });
        adbVersion = /Version ([\d.]+[^\s]*)/.exec(r.all)?.[1] ?? /version ([\d.]+)/i.exec(r.all)?.[1];
      } catch (err) {
        log.warn('adb version failed', err);
      }
    }
    const ios: ToolPaths['ios'] = {};
    const missing: string[] = [];
    let iosSource: ToolStatus['source'];
    for (const t of IOS_TOOLS) {
      const hit = this.locate('libimobiledevice', t);
      if (hit) {
        ios[t] = hit.file;
        iosSource ??= hit.source;
      } else missing.push(t);
    }
    let iosVersion: string | undefined;
    if (ios.ideviceinfo) {
      try {
        const r = await run(ios.ideviceinfo, ['--version'], { timeoutMs: 8000 });
        iosVersion = /([\d]+\.[\d.]+[^\s]*)/.exec(r.all)?.[1];
      } catch {
        /* old builds have no --version */
      }
    }
    this.paths = { adb: adb?.file, ios };
    this.status = [
      {
        id: 'adb',
        label: 'Android Platform-Tools (adb)',
        found: !!adb,
        path: adb?.file,
        version: adbVersion,
        source: adb?.source,
        missing: adb ? [] : ['adb'],
        installHint: 'MinTransfer can download Google’s official Platform-Tools for you, or point it at an existing Android SDK.',
      },
      {
        id: 'libimobiledevice',
        label: 'libimobiledevice (iPhone & iPad)',
        found: missing.length === 0,
        path: ios.idevicebackup2 ?? ios.ideviceinfo,
        version: iosVersion,
        source: iosSource,
        missing,
        installHint:
          process.platform === 'darwin'
            ? 'Install with Homebrew: brew install libimobiledevice'
            : process.platform === 'win32'
              ? 'Install the Apple Devices app (or iTunes) for the USB driver, then download a libimobiledevice build for Windows and choose its folder in Settings.'
              : 'Install the libimobiledevice-utils package and usbmuxd.',
      },
    ];
    return this.status;
  }

  /** Downloads and unpacks Google's Platform-Tools into the app's data folder. */
  async downloadPlatformTools(onProgress: (fraction: number | null, detail: string) => void, signal: AbortSignal): Promise<string> {
    const url = platformToolsUrl();
    fs.mkdirSync(this.userToolsDir, { recursive: true });
    const zip = path.join(this.userToolsDir, 'platform-tools.zip');
    log.info('downloading platform-tools', { url });
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length') ?? 0);
    const out = fs.createWriteStream(zip);
    let got = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        onProgress(total ? got / total : null, `Downloading Platform-Tools… ${(got / 1048576).toFixed(1)} MB`);
      }
    } finally {
      await new Promise<void>((r) => out.end(r));
    }
    onProgress(null, 'Unpacking…');
    fs.rmSync(this.downloadedPlatformTools, { recursive: true, force: true });
    const extract =
      process.platform === 'win32'
        ? await run('tar', ['-xf', zip, '-C', this.userToolsDir], { timeoutMs: 120000, signal })
        : await run('/usr/bin/unzip', ['-q', '-o', zip, '-d', this.userToolsDir], { timeoutMs: 120000, signal });
    fs.rmSync(zip, { force: true });
    if (extract.code !== 0) throw new Error(`Could not unpack Platform-Tools: ${extract.all.trim()}`);
    const adb = path.join(this.downloadedPlatformTools, 'adb' + EXE);
    if (!fs.existsSync(adb)) throw new Error('The download did not contain adb.');
    if (process.platform !== 'win32') fs.chmodSync(adb, 0o755);
    await this.refresh();
    return adb;
  }
}
