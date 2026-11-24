# Limitations

## Both platforms
* **Permanently deleted data can't be brought back.** Modern phones use file-based encryption, so once a
  file is purged its key is destroyed. MinTransfer recovers what still exists: Recently Deleted, trash and
  recycle bins, thumbnail caches and older backups.
* Data that lives only in iCloud / Google (iCloud Photos "Optimise storage", Messages in iCloud, Google
  Contacts) is not on the phone and therefore not in a local backup.

## iPhone / iPad
* Requires libimobiledevice. On Windows it also needs Apple's USB driver (Apple Devices app or iTunes).
* Encrypted backups can be made and restored but not yet browsed in Recover.
* Restore requires **Find My** to be off. Erase leaves Activation Lock in place if Find My is on.
* Backups from iOS 9 and earlier (`Manifest.mbdb`) can be restored but not browsed.

## Android
* Needs **USB debugging**. App data is not accessible without root (Android removed `adb backup` for
  most apps), so apps are backed up as APKs only.
* Many phones on Android 10+ block reading SMS and call logs over USB debugging; MinTransfer reports this
  per category instead of failing the whole backup.
* Contacts are restored by handing a `.vcf` to the phone's Contacts app; you confirm the import on the phone.
* `Android/data` and `Android/obb` are private to apps on Android 11+ and are skipped.
* Android can't be factory-reset from a computer without root. Erase wipes shared storage and user apps and
  restarts into recovery, where you confirm the reset with the phone's buttons.
