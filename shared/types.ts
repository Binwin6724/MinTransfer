// Types shared by the Electron main process and the React UI.

export type PhonePlatform = 'android' | 'ios';

/** Connection state reported by adb / lockdownd, normalised across platforms. */
export type ConnectionState =
  | 'ready' // trusted, unlocked enough to talk to
  | 'unauthorized' // Android: USB debugging prompt not accepted yet
  | 'untrusted' // iOS: "Trust This Computer?" not accepted yet
  | 'locked' // iOS: passcode locked, pairing pending
  | 'offline'
  | 'recovery' // Android recovery / sideload, iOS recovery mode
  | 'unknown';

export interface PhoneDevice {
  /** adb serial or iOS UDID. */
  id: string;
  platform: PhonePlatform;
  state: ConnectionState;
  /** Human-readable reason when state is not "ready". */
  stateDetail?: string;
  name: string;
  model: string;
  manufacturer: string;
  osName: string;
  osVersion: string;
  battery?: number;
  charging?: boolean;
  storageTotal?: number;
  storageFree?: number;
  serial?: string;
  /** iOS only: whether the device itself will encrypt backups. */
  backupEncryption?: boolean;
  /** Connected over Wi-Fi rather than USB. */
  wireless?: boolean;
}

export type ToolId = 'adb' | 'libimobiledevice';

export interface ToolStatus {
  id: ToolId;
  label: string;
  found: boolean;
  path?: string;
  version?: string;
  source?: 'downloaded' | 'bundled' | 'system' | 'custom';
  /** Executables of the suite that could not be found. */
  missing: string[];
  installHint: string;
}

export type JobKind = 'backup' | 'restore' | 'recover' | 'erase' | 'extract' | 'scan' | 'tools';
export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  deviceId?: string;
  status: JobStatus;
  /** 0..1, or null when the step's length is unknown. */
  progress: number | null;
  detail: string;
  log: string[];
  startedAt: number;
  endedAt?: number;
  /** A folder or file the user can reveal when the job finished. */
  resultPath?: string;
  error?: string;
}

/** What an Android backup can contain. */
export type AndroidCategoryId =
  | 'photos'
  | 'videos'
  | 'music'
  | 'documents'
  | 'downloads'
  | 'whatsapp'
  | 'apps'
  | 'contacts'
  | 'calls'
  | 'messages'
  | 'storage';

export interface CategoryInfo {
  id: AndroidCategoryId;
  label: string;
  description: string;
  /** Paths below /sdcard pulled for file categories. */
  paths?: string[];
  kind: 'files' | 'apps' | 'provider' | 'all';
}

export interface CategoryResult {
  id: string;
  label: string;
  files: number;
  bytes: number;
  /** Non-fatal problem, e.g. "permission denied by Android". */
  warning?: string;
}

export interface BackupRecord {
  id: string;
  platform: PhonePlatform;
  /** "mintransfer" = made by this app; "system" = Finder / iTunes / Apple Devices. */
  source: 'mintransfer' | 'system';
  deviceId: string;
  deviceName: string;
  deviceModel: string;
  osVersion: string;
  createdAt: number;
  /** Folder that holds the backup. For iOS this contains the <UDID> folder. */
  path: string;
  /** For iOS: path to the folder with Manifest.db (path/<udid>). */
  dataPath: string;
  sizeBytes: number;
  categories: CategoryResult[];
  encrypted: boolean;
  complete: boolean;
  note?: string;
}

/** One logical item group inside a backup that can be extracted. */
export interface RecoverGroup {
  id: string;
  label: string;
  description: string;
  count: number;
  bytes: number;
  /** Export format produced when extracting, e.g. "vcf", "csv", "files". */
  format: string;
  /** true for items the user deleted on the phone (Recently Deleted / trash). */
  deleted?: boolean;
  available: boolean;
  reason?: string;
}

/** A file found on an Android device that is still recoverable (trash, thumbnails). */
export interface TrashItem {
  path: string;
  name: string;
  size: number;
  mtime: number;
  source: string;
}

export type ThemePref = 'system' | 'dark' | 'light';

export interface AppSettings {
  theme: ThemePref;
  backupDir: string;
  /** Show Finder / iTunes / Apple Devices backups in the library. */
  showSystemBackups: boolean;
  /** Custom folder containing adb or libimobiledevice executables. */
  customToolDir: string;
  /** Poll interval for device discovery in ms. */
  pollMs: number;
}

export interface AppState {
  platform: string;
  version: string;
  devices: PhoneDevice[];
  tools: ToolStatus[];
  backups: BackupRecord[];
  jobs: Job[];
  settings: AppSettings;
}

// ------------------------------------------------------------------ requests

export interface BackupRequest {
  deviceId: string;
  /** Android categories; ignored for iOS. */
  categories: AndroidCategoryId[];
  /** iOS: password to turn encryption on before the backup (optional). */
  encryptPassword?: string;
  label?: string;
}

export interface RestoreRequest {
  deviceId: string;
  backupId: string;
  /** Android: categories to restore. */
  categories: string[];
  /** iOS options. */
  ios?: { system: boolean; settings: boolean; reboot: boolean; password?: string; copy: boolean };
}

export interface EraseRequest {
  deviceId: string;
  /** Android actions. */
  android?: { wipeFolders: string[]; uninstallApps: boolean; rebootToRecovery: boolean };
  /** Must equal the phrase shown in the UI. */
  confirmation: string;
}

export interface ExtractRequest {
  backupId: string;
  groups: string[];
  dest: string;
}
