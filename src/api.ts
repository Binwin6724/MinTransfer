// Typed access to the preload bridge plus a tiny external store for app state.
import { useSyncExternalStore } from 'react';
import type { AppSettings, AppState, BackupRequest, EraseRequest, ExtractRequest, RecoverGroup, RestoreRequest, TrashItem } from '../shared/types';

export interface MintransferApi {
  platform: string;
  getState(): Promise<AppState>;
  refreshDevices(): Promise<void>;
  pairIos(udid: string): Promise<string>;
  startBackup(req: BackupRequest): Promise<string>;
  startRestore(req: RestoreRequest): Promise<string>;
  startErase(req: EraseRequest): Promise<string>;
  setIosEncryption(udid: string, on: boolean, password: string): Promise<string>;
  scanTrash(deviceId: string): Promise<TrashItem[]>;
  pullTrash(deviceId: string, items: TrashItem[], dest: string): Promise<string>;
  refreshLibrary(): Promise<void>;
  backupGroups(id: string): Promise<RecoverGroup[]>;
  extract(req: ExtractRequest): Promise<string>;
  deleteBackup(id: string): Promise<boolean>;
  revealBackup(id: string): Promise<void>;
  cancelJob(id: string): Promise<void>;
  clearJobs(): Promise<void>;
  refreshTools(): Promise<void>;
  downloadAdb(): Promise<string>;
  setSettings(patch: Partial<AppSettings>): Promise<void>;
  chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
  reveal(p: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  openLogs(): Promise<void>;
  openFullDiskAccess(): Promise<void>;
  openAppleDevicesStore(): Promise<void>;
  onState(cb: (s: AppState) => void): () => void;
  onCapture(cb: (p: { route: string; theme: string }) => void): () => void;
}

export const api = (window as unknown as { mintransfer: MintransferApi }).mintransfer;

let current: AppState | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

api.getState().then((s) => {
  current = s;
  emit();
});
api.onState((s) => {
  current = s;
  emit();
});

export function useAppState(): AppState | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

// ---------------------------------------------------------------- toasts

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
}
const toastListeners = new Set<(t: Toast) => void>();
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const t = { id: ++toastId, kind, text };
  toastListeners.forEach((l) => l(t));
}
export function onToast(cb: (t: Toast) => void) {
  toastListeners.add(cb);
  return () => {
    toastListeners.delete(cb);
  };
}

/** Runs an API call and turns a failure into an error toast. */
export async function run<T>(p: Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const v = await p;
    if (success) toast(success, 'success');
    return v;
  } catch (err) {
    toast(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err), 'error');
    return undefined;
  }
}

export function navigate(route: string) {
  location.hash = route;
}
