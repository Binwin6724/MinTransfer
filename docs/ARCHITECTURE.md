# Architecture

MinTransfer is an Electron app. The renderer (React) never touches Node: it calls a small typed
API exposed by `electron/preload.ts`, and the main process does all device and file work.

## Main process

| File | Role |
|---|---|
| `main.ts` | Window, IPC handlers, device polling loop (every 2 s), state broadcast, power-save blocker while jobs run. |
| `tools.ts` | Finds `adb` and libimobiledevice (custom folder → downloaded → bundled → Android SDK / Homebrew → `PATH`) and downloads Google's Platform-Tools. |
| `exec.ts` | Spawns tools **without a shell**, with timeouts, cancellation (kills the process tree on Windows) and line callbacks for progress. |
| `jobs.ts` | Job runner: one running job per phone, progress / detail / log, cancel, throttled updates to the UI. |
| `android.ts` | adb device discovery and info, category backups (`adb pull -a`), apps (`pm path` + split APKs), contacts / calls / SMS via `content query`, restore (`push --sync`, `install-multiple`), trash scan and erase. |
| `ios.ts` | `idevice_id`/`ideviceinfo` discovery, pairing, `idevicebackup2` backup / restore / encryption / erase. Passwords go through `BACKUP_PASSWORD*` environment variables, never the command line. |
| `iosBackup.ts` | Opens `Manifest.db` with sql.js (WebAssembly SQLite) and extracts groups from the app databases inside the backup. |
| `library.ts` | Lists MinTransfer backups (`mintransfer.json`) and Finder / iTunes backups (`Info.plist`), browsing and extraction, safe deletion. |

## Shared logic (`shared/`)

Pure functions with no Electron or Node dependencies, covered by unit tests:
adb / libimobiledevice output parsers, content-provider row parsing (values may contain commas
and newlines), vCard and CSV writers, Apple timestamp conversion, a binary plist parser,
a minimal protobuf reader for Apple Notes, and the iMessage `attributedBody` text extractor.

## iOS backup format (iOS 10+)

* `Manifest.db` — table `Files(fileID, domain, relativePath, flags, file)`; `flags = 1` is a file.
* Each file is stored at `<first two hex chars of fileID>/<fileID>`; `fileID = SHA-1(domain + "-" + relativePath)`.
* `Manifest.plist` — `IsEncrypted`. Encrypted backups also encrypt `Manifest.db`.

| Group | Source |
|---|---|
| Photos | `CameraRollDomain`, `Media/DCIM/…` |
| Recently Deleted photos | `Photos.sqlite` → `ZASSET.ZTRASHEDSTATE = 1` |
| Contacts | `HomeDomain/Library/AddressBook/AddressBook.sqlitedb` |
| Messages | `HomeDomain/Library/SMS/sms.db`, attachments in `MediaDomain/Library/SMS/Attachments` |
| Call history | `HomeDomain/Library/CallHistoryDB/CallHistory.storedata` |
| Notes | `AppDomainGroup-group.com.apple.notes/NoteStore.sqlite`, `ZICNOTEDATA.ZDATA` = gzip(protobuf) |
| WhatsApp | `AppDomainGroup-group.net.whatsapp.*/ChatStorage.sqlite` and `Message/Media/` |
