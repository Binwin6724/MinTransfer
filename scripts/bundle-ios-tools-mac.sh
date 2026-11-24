#!/usr/bin/env bash
# Copies libimobiledevice's command-line tools from Homebrew into vendor/tools/libimobiledevice,
# together with every non-system dylib they need, rewritten to load from ./lib.
# The result is self-contained and is shipped inside the app (Contents/Resources/tools).
#   brew install libimobiledevice dylibbundler && scripts/bundle-ios-tools-mac.sh
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=vendor/tools/libimobiledevice
TOOLS=(idevice_id ideviceinfo idevicepair idevicebackup2 ideviceenterrecovery)
BREW=$(brew --prefix)

rm -rf "$OUT"
mkdir -p "$OUT/lib" "$OUT/licenses"
args=()
for t in "${TOOLS[@]}"; do
  cp "$BREW/bin/$t" "$OUT/$t"
  chmod u+w,+x "$OUT/$t"
  args+=(-x "$OUT/$t")
done
dylibbundler -of -b -cd "${args[@]}" -d "$OUT/lib" -p @executable_path/lib/ >/dev/null

# install_name_tool invalidates signatures; arm64 refuses to run unsigned code, so ad-hoc sign everything.
codesign --force --sign - "$OUT"/lib/*.dylib "${TOOLS[@]/#/$OUT/}" 2>/dev/null

for f in libimobiledevice libimobiledevice-glue libusbmuxd libplist openssl@3 libtatsu; do
  d=$(brew --prefix "$f" 2>/dev/null) || continue
  for lic in COPYING COPYING.LESSER LICENSE LICENSE.txt; do
    [ -f "$d/$lic" ] && cp "$d/$lic" "$OUT/licenses/$f-${lic%.txt}.txt"
  done
done
brew list --versions libimobiledevice libimobiledevice-glue libusbmuxd libplist openssl@3 > "$OUT/licenses/VERSIONS.txt" 2>/dev/null || true

# Fail the build if anything still points into Homebrew.
if otool -L "$OUT"/idevice* "$OUT"/lib/*.dylib | grep -E "$BREW|/usr/local/(opt|Cellar)" ; then
  echo "✗ bundled tools still reference Homebrew paths" >&2
  exit 1
fi
"$OUT/idevicebackup2" --version
echo "✓ libimobiledevice bundled in $OUT ($(du -sh "$OUT" | cut -f1))"
