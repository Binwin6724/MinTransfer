// Electron main process: window, device discovery loop, IPC and job orchestration.
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, powerSaveBlocker, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { AndroidService } from './android';
import { freeSpace } from './fsutil';
import { IosService } from './ios';
import { JobContext, JobRunner } from './jobs';
import { Library } from './library';
import { log } from './logger';
import { JsonStore } from './store';
import { APPLE_DEVICES_STORE, PLATFORM_TOOLS_TERMS, Tools } from './tools';
import { backupFolderName, formatBytes } from '../shared/export';
import type { AppSettings, AppState, JobKind, BackupRequest, EraseRequest, ExtractRequest, PhoneDevice, RestoreRequest, TrashItem } from '../shared/types';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const args = process.argv.slice(1);
const captureDir = argValue('--capture-screenshots');
export const ERASE_PHRASE = 'ERASE';

/** Sample phones shown only in --capture-screenshots mode when nothing is plugged in. */
const DEMO_DEVICES: PhoneDevice[] = [
  { id: '00008130-001A2B3C4D5E6F70', platform: 'ios', state: 'ready', name: 'Demo iPhone', manufacturer: 'Apple', model: 'iPhone 15 Pro', osName: 'iOS', osVersion: '18.1', wireless: false, battery: 82, charging: true, storageTotal: 256e9, storageFree: 141e9, backupEncryption: false, serial: 'F2LXDEMO0001' },
  { id: 'R5CW30DEMO', platform: 'android', state: 'ready', name: 'Demo Galaxy', manufacturer: 'Samsung', model: 'Samsung Galaxy S24', osName: 'Android', osVersion: '15', wireless: false, battery: 64, storageTotal: 128e9, storageFree: 52e9, serial: 'R5CW30DEMO' },
];

function argValue(flag: string): string | null {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

let mainWindow: BrowserWindow | null = null;
let store: JsonStore<{ settings: AppSettings }>;
let tools: Tools;
let android: AndroidService;
let ios: IosService;
let jobs: JobRunner;
let library: Library;
let devices: PhoneDevice[] = [];
let pollTimer: NodeJS.Timeout | null = null;
let polling = false;
let lastSent = '';
let blocker: number | null = null;

function defaultSettings(): AppSettings {
  return {
    theme: 'system',
    backupDir: path.join(app.getPath('documents'), 'MinTransfer Backups'),
    showSystemBackups: true,
    customToolDir: '',
    pollMs: 2000,
    autoSetupAndroid: true,
  };
}

const settings = () => store.get().settings;

// ---------------------------------------------------------------- state

function state(): AppState {
  return {
    platform: process.platform,
    version: app.getVersion(),
    devices,
    tools: tools.status,
    backups: library.backups,
    jobs: jobs.jobs,
    settings: settings(),
  };
}

function push(force = false) {
  const s = state();
  const json = JSON.stringify(s);
  if (!force && json === lastSent) return;
  lastSent = json;
  mainWindow?.webContents.send('state', s);
  // Keep the computer awake while something is running.
  const busy = jobs.running.length > 0;
  if (busy && blocker == null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!busy && blocker != null) {
    powerSaveBlocker.stop(blocker);
    blocker = null;
  }
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const [a, i] = await Promise.all([android.list(), ios.list()]);
    devices = [...i, ...a];
    if (captureDir && !devices.length) devices = DEMO_DEVICES;
  } catch (err) {
    log.warn('poll failed', err);
  } finally {
    polling = false;
    push();
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(poll, Math.max(1000, settings().pollMs));
  poll();
}

function device(id: string): PhoneDevice {
  const d = devices.find((x) => x.id === id);
  if (!d) throw new Error('That phone is no longer connected.');
  if (d.state !== 'ready') throw new Error(d.stateDetail ?? 'The phone is not ready yet.');
  return d;
}

/** Runs a job and resolves with its typed result (used for scans the UI waits on). */
function jobWithResult<T>(kind: JobKind, title: string, deviceId: string | undefined, fn: (ctx: JobContext) => Promise<T>) {
  return new Promise<T>((resolve, reject) => {
    let value: T;
    const job = jobs.start(kind, title, deviceId, async (ctx) => {
      value = await fn(ctx);
    });
    const check = setInterval(() => {
      if (job.status === 'running') return;
      clearInterval(check);
      if (job.status === 'done') resolve(value);
      else reject(new Error(job.error ?? job.detail));
    }, 200);
  });
}

// ---------------------------------------------------------------- window

function rendererUrl(hash: string) {
  if (DEV_URL) return `${DEV_URL}#${hash}`;
  return `file://${path.join(__dirname, '..', 'renderer', 'index.html')}#${hash}`;
}

function createWindow() {
  const mac = process.platform === 'darwin';
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    title: 'MinTransfer',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d12' : '#f4f5f8',
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 18, y: 18 },
    titleBarOverlay: mac ? undefined : { color: '#00000000', symbolColor: nativeTheme.shouldUseDarkColors ? '#e5e7eb' : '#111827', height: 44 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
  mainWindow.loadURL(rendererUrl('/'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (e) => {
    if (jobs.running.length === 0 || captureDir) return;
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Keep running', 'Cancel and quit'],
      defaultId: 0,
      cancelId: 0,
      message: 'A transfer is still running.',
      detail: 'Quitting now cancels it. Partial backups are kept but marked incomplete.',
    });
    if (choice === 0) e.preventDefault();
    else jobs.cancelAll();
  });
  mainWindow.on('closed', () => (mainWindow = null));
}

// ---------------------------------------------------------------- IPC

type Handler = (...a: any[]) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
function handle(channel: string, fn: Handler) {
  ipcMain.handle(channel, async (_e, ...a) => {
    try {
      return { ok: true, value: await fn(...a) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`ipc ${channel} failed`, msg);
      return { ok: false, error: msg };
    }
  });
}

function registerIpc() {
  handle('state:get', () => state());
  handle('devices:refresh', async () => {
    for (const d of devices) (d.platform === 'ios' ? ios : android).invalidate(d.id);
    await poll();
  });
  handle('ios:pair', (udid: string) => ios.pair(udid));

  handle('backup:start', (req: BackupRequest) => {
    const d = device(req.deviceId);
    const when = new Date();
    const dir = path.join(settings().backupDir, backupFolderName(d.name, when));
    const free = freeSpace(settings().backupDir);
    const used = d.storageTotal && d.storageFree != null ? d.storageTotal - d.storageFree : null;
    const job = jobs.start('backup', `Back up ${d.name}`, d.id, async (ctx) => {
      if (free != null && used != null && free < used * 0.25) ctx.log(`⚠ Only ${formatBytes(free)} free on the backup drive; the phone uses ${formatBytes(used)}.`);
      if (d.platform === 'ios' && req.iosItems) await ios.backupItems(ctx, d, dir, req.iosItems, { keepFull: req.keepFull, label: req.label });
      else if (d.platform === 'ios') await ios.backup(ctx, d, dir, { encryptPassword: req.encryptPassword, label: req.label });
      else {
        if (!req.categories.length) throw new Error('Choose at least one thing to back up.');
        await android.backup(ctx, d, req.categories, dir, req.label);
      }
      library.scan();
      return dir;
    });
    return job.id;
  });

  handle('restore:start', (req: RestoreRequest) => {
    const d = device(req.deviceId);
    const rec = library.get(req.backupId);
    if (rec.kind === 'items')
      throw new Error('This backup holds only the items you chose, saved as ordinary files, so it can’t be restored onto a phone. Open it in Recover or the Backups folder instead.');
    if (rec.platform !== d.platform) throw new Error(`This is ${rec.platform === 'ios' ? 'an iPhone' : 'an Android'} backup and can't be restored to ${d.platform === 'ios' ? 'an iPhone' : 'an Android phone'}. Use Recover to extract its files instead.`);
    const job = jobs.start('restore', `Restore ${rec.deviceName} → ${d.name}`, d.id, async (ctx) => {
      if (d.platform === 'ios') await ios.restore(ctx, d.id, rec, req.ios ?? { system: false, settings: true, reboot: true, copy: true });
      else await android.restore(ctx, d.id, rec, req.categories);
    });
    return job.id;
  });

  handle('erase:start', (req: EraseRequest) => {
    const d = device(req.deviceId);
    if (req.confirmation !== ERASE_PHRASE) throw new Error(`Type ${ERASE_PHRASE} to confirm.`);
    const job = jobs.start('erase', `Erase ${d.name}`, d.id, async (ctx) => {
      if (d.platform === 'ios') await ios.enterRecovery(ctx, d.id);
      else await android.erase(ctx, d.id, req.android ?? { wipeFolders: [], uninstallApps: false, rebootToRecovery: false });
    });
    return job.id;
  });

  handle('ios:encryption', (udid: string, on: boolean, password: string) => {
    const d = device(udid);
    const job = jobs.start('tools', on ? `Encrypt backups of ${d.name}` : `Stop encrypting backups of ${d.name}`, d.id, (ctx) => ios.setEncryption(ctx, udid, on, password));
    return job.id;
  });

  handle('recover:scan', (deviceId: string) => {
    const d = device(deviceId);
    if (d.platform !== 'android') throw new Error('Scanning the phone directly is only possible on Android. For iPhone, make a backup and browse it.');
    return jobWithResult<TrashItem[]>('scan', `Scan ${d.name} for deleted files`, d.id, (ctx) => android.scanTrash(ctx, d.id));
  });
  handle('recover:pull', (deviceId: string, items: TrashItem[], dest: string) => {
    const d = device(deviceId);
    const out = path.join(dest, `${d.name.replace(/[<>:"/\\|?*]/g, '_')} - recovered ${new Date().toISOString().slice(0, 10)}`);
    return jobs.start('recover', `Recover ${items.length} file(s) from ${d.name}`, d.id, async (ctx) => {
      await android.pullFiles(ctx, d.id, items, out);
      return out;
    }).id;
  });

  handle('library:refresh', () => library.scan());
  handle('library:groups', (id: string) => library.groups(id));
  handle('library:extract', (req: ExtractRequest) => {
    const rec = library.get(req.backupId);
    return jobs.start('extract', `Extract from ${rec.deviceName} backup`, undefined, (ctx) => library.extract(ctx, req.backupId, req.groups, req.dest)).id;
  });
  handle('library:delete', async (id: string) => {
    const rec = library.get(id);
    const r = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Delete backup', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: `Delete the backup of ${rec.deviceName}?`,
      detail: `${formatBytes(rec.sizeBytes)} will be moved to the ${process.platform === 'darwin' ? 'Trash' : 'Recycle Bin'}.`,
    });
    if (r.response !== 0) return false;
    if (rec.source !== 'mintransfer') throw new Error('Backups made by Finder or iTunes can only be deleted there.');
    try {
      await shell.trashItem(rec.path);
    } catch {
      library.remove(id);
    }
    library.scan();
    return true;
  });
  handle('library:reveal', (id: string) => shell.showItemInFolder(library.get(id).dataPath));

  handle('jobs:cancel', (id: string) => jobs.cancel(id));
  handle('jobs:clear', () => jobs.clearFinished());

  handle('tools:refresh', async () => {
    await tools.refresh();
    startPolling();
  });
  handle('tools:downloadAdb', () =>
    jobs.start('tools', 'Download Android Platform-Tools', undefined, async (ctx) => {
      ctx.log(`Source: Google (dl.google.com). License: ${PLATFORM_TOOLS_TERMS}`);
      const adb = await tools.downloadPlatformTools((f, d) => ctx.progress(f, d), ctx.signal);
      startPolling();
      return path.dirname(adb);
    }).id,
  );

  handle('settings:set', async (patch: Partial<AppSettings>) => {
    const allowed: (keyof AppSettings)[] = ['theme', 'backupDir', 'showSystemBackups', 'customToolDir', 'pollMs', 'autoSetupAndroid'];
    const clean: Partial<AppSettings> = {};
    for (const k of allowed) if (k in patch) (clean as Record<string, unknown>)[k] = patch[k];
    store.set({ settings: { ...settings(), ...clean } });
    if (clean.theme) nativeTheme.themeSource = clean.theme;
    if ('customToolDir' in clean) {
      await tools.refresh();
      startPolling();
    }
    if ('backupDir' in clean || 'showSystemBackups' in clean) library.scan();
    if ('pollMs' in clean) startPolling();
    push(true);
  });

  handle('dialog:folder', async (title: string, defaultPath?: string) => {
    const r = await dialog.showOpenDialog(mainWindow!, { title, defaultPath, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  handle('app:reveal', (p: string) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) throw new Error('That folder no longer exists.');
    shell.showItemInFolder(p);
  });
  handle('app:openExternal', (url: string) => {
    if (!/^https:\/\//.test(url)) throw new Error('Only https links can be opened.');
    return shell.openExternal(url);
  });
  handle('app:openLogs', () => log.path && shell.showItemInFolder(log.path));
  handle('app:openAppleDevicesStore', () => shell.openExternal(APPLE_DEVICES_STORE));
  handle('app:openFullDiskAccess', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'));
}

/** First launch (or tools deleted): fetch Google's Platform-Tools without the user having to ask. */
function autoSetupAndroid() {
  if (tools.paths.adb || !settings().autoSetupAndroid || captureDir) return;
  log.info('Android tools missing; setting them up automatically');
  try {
    jobs.start('tools', 'Set up Android tools', undefined, async (ctx) => {
      ctx.log(`Downloading Android SDK Platform-Tools from Google. License: ${PLATFORM_TOOLS_TERMS}`);
      const adb = await tools.downloadPlatformTools((f, d) => ctx.progress(f, d), ctx.signal);
      startPolling();
      ctx.progress(1, 'Android tools are ready');
      return path.dirname(adb);
    });
  } catch (err) {
    log.warn('auto setup failed to start', err);
  }
}

// ---------------------------------------------------------------- screenshots (README)

async function captureScreenshots(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await wait(2500);
  const routes: [string, string, 'dark' | 'light'][] = [
    ['/', 'devices', 'dark'],
    ['/backup', 'backup', 'dark'],
    ['/restore', 'restore', 'dark'],
    ['/recover', 'recover', 'dark'],
    ['/erase', 'erase', 'dark'],
    ['/library', 'library', 'dark'],
    ['/settings', 'settings', 'dark'],
    ['/', 'devices-light', 'light'],
  ];
  for (const [route, name, theme] of routes) {
    nativeTheme.themeSource = theme;
    mainWindow?.webContents.send('capture', { route, theme });
    await wait(1500);
    const img = await mainWindow!.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
    log.info(`captured ${name}`);
  }
  app.quit();
}

// ---------------------------------------------------------------- lifecycle

app.whenReady().then(async () => {
  log.init(path.join(app.getPath('userData'), 'logs'));
  log.info('MinTransfer starting', { version: app.getVersion(), platform: process.platform, arch: process.arch });
  store = new JsonStore(path.join(app.getPath('userData'), 'mintransfer.json'), { settings: defaultSettings() }, (e) => log.error('store', e));
  store.set({ settings: { ...defaultSettings(), ...store.get().settings } });
  nativeTheme.themeSource = settings().theme;
  tools = new Tools(path.join(app.getPath('userData'), 'tools'), process.resourcesPath ?? '', () => settings().customToolDir);
  android = new AndroidService(() => tools.paths.adb);
  ios = new IosService(() => tools.paths.ios);
  jobs = new JobRunner(() => push());
  library = new Library(() => settings().backupDir, () => settings().showSystemBackups);
  registerIpc();
  await tools.refresh();
  library.scan();
  createWindow();
  startPolling();
  autoSetupAndroid();
  if (captureDir) mainWindow?.webContents.once('did-finish-load', () => captureScreenshots(path.resolve(captureDir)));
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  jobs?.cancelAll();
  store?.flush();
});
