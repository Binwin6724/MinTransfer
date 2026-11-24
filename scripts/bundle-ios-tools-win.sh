#!/usr/bin/env bash
# Run inside an MSYS2 UCRT64 shell (CI uses msys2/setup-msys2).
# Copies libimobiledevice's command-line tools and their DLLs into vendor/tools/libimobiledevice.
#   pacman -S mingw-w64-ucrt-x86_64-libimobiledevice && scripts/bundle-ios-tools-win.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=vendor/tools/libimobiledevice
TOOLS=(idevice_id ideviceinfo idevicepair idevicebackup2 ideviceenterrecovery)
PREFIX=${MINGW_PREFIX:-/ucrt64}

rm -rf "$OUT"
mkdir -p "$OUT/licenses"
for t in "${TOOLS[@]}"; do cp "$PREFIX/bin/$t.exe" "$OUT/"; done
# Every DLL from the MSYS2 prefix that the tools load (directly or indirectly).
ldd "$OUT"/*.exe | awk '{print $3}' | grep -i "^$PREFIX/bin/" | sort -u | while read -r dll; do cp "$dll" "$OUT/"; done
for pkg in libimobiledevice libimobiledevice-glue libusbmuxd libplist openssl; do
  [ -d "$PREFIX/share/licenses/$pkg" ] && cp -r "$PREFIX/share/licenses/$pkg" "$OUT/licenses/" || true
done
pacman -Q | grep -E "libimobiledevice|libusbmuxd|libplist|openssl" > "$OUT/licenses/VERSIONS.txt" || true
"$OUT/idevice_id.exe" --version || true
echo "✓ libimobiledevice bundled in $OUT ($(du -sh "$OUT" | cut -f1))"
