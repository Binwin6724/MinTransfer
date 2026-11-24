# Third-party notices

## Included in the installers

| Component | License | Source |
|---|---|---|
| libimobiledevice (idevice_id, ideviceinfo, idevicepair, idevicebackup2, ideviceenterrecovery) | LGPL-2.1-or-later (library), GPL-2.0-or-later (tools) | https://github.com/libimobiledevice/libimobiledevice |
| libimobiledevice-glue, libusbmuxd, libplist | LGPL-2.1-or-later | https://github.com/libimobiledevice |
| OpenSSL | Apache-2.0 | https://www.openssl.org/ |
| sql.js (SQLite compiled to WebAssembly) | MIT | https://github.com/sql-js/sql.js |
| plist | MIT | https://github.com/TooTallNate/plist.js |
| Electron, React | MIT | https://electronjs.org · https://react.dev |

The libimobiledevice tools are unmodified builds from Homebrew (macOS) and MSYS2 (Windows), run as
separate programs. Their license texts and exact versions are in `tools/libimobiledevice/licenses`
inside the installed app. To use your own build, choose its folder in Settings ▸ Custom tools folder.

## Downloaded on first launch (not included)

| Component | License | Source |
|---|---|---|
| Android SDK Platform-Tools (adb) | Android Software Development Kit License Agreement | https://developer.android.com/tools/releases/platform-tools |

Google's terms don't allow redistributing Platform-Tools, so MinTransfer downloads them directly from
Google when the app first starts (the installer shows these terms). This can be turned off in Settings.
