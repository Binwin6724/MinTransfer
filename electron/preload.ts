// Exposes a narrow, typed API to the renderer. No Node access leaks through.
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function on(channel: string, cb: (payload: unknown) => void) {
  const listener = (_e: IpcRendererEvent, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  platform: process.platform,
  getState: () => call('state:get'),
  refreshDevices: () => call('devices:refresh'),
  pairIos: (udid: string) => call('ios:pair', udid),
  startBackup: (req: object) => call('backup:start', req),
  startRestore: (req: object) => call('restore:start', req),
  startTransfer: (req: object) => call('transfer:start', req),
  listMedia: (deviceId: string, view: string) => call('manage:media', deviceId, view),
  listDir: (deviceId: string, dir?: string) => call('manage:dir', deviceId, dir),
  exportFiles: (deviceId: string, view: string, files: object[], base?: string) => call('manage:export', deviceId, view, files, base),
  importFiles: (deviceId: string, view: string, dir?: string) => call('manage:import', deviceId, view, dir),
  deleteFiles: (deviceId: string, paths: string[]) => call('manage:delete', deviceId, paths),
  listApps: (deviceId: string) => call('manage:apps', deviceId),
  exportApps: (deviceId: string, ids: string[]) => call('manage:exportApps', deviceId, ids),
  installApps: (deviceId: string) => call('manage:installApps', deviceId),
  uninstallApp: (deviceId: string, id: string) => call('manage:uninstall', deviceId, id),
  openTransferFolder: (deviceId: string) => call('manage:openFolder', deviceId),
  startErase: (req: object) => call('erase:start', req),
  setIosEncryption: (udid: string, on: boolean, password: string) => call('ios:encryption', udid, on, password),
  scanTrash: (deviceId: string) => call('recover:scan', deviceId),
  pullTrash: (deviceId: string, items: object[], dest: string) => call('recover:pull', deviceId, items, dest),
  refreshLibrary: () => call('library:refresh'),
  backupGroups: (id: string) => call('library:groups', id),
  extract: (req: object) => call('library:extract', req),
  deleteBackup: (id: string) => call('library:delete', id),
  revealBackup: (id: string) => call('library:reveal', id),
  cancelJob: (id: string) => call('jobs:cancel', id),
  clearJobs: () => call('jobs:clear'),
  refreshTools: () => call('tools:refresh'),
  downloadAdb: () => call('tools:downloadAdb'),
  setSettings: (patch: object) => call('settings:set', patch),
  chooseFolder: (title: string, defaultPath?: string) => call('dialog:folder', title, defaultPath),
  reveal: (p: string) => call('app:reveal', p),
  openExternal: (url: string) => call('app:openExternal', url),
  openLogs: () => call('app:openLogs'),
  openFullDiskAccess: () => call('app:openFullDiskAccess'),
  openAppleDevicesStore: () => call('app:openAppleDevicesStore'),
  onState: (cb: (s: unknown) => void) => on('state', cb),
  onCapture: (cb: (p: unknown) => void) => on('capture', cb),
};

contextBridge.exposeInMainWorld('mintransfer', api);
