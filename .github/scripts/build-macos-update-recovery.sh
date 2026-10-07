#!/usr/bin/env bash
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
set -euo pipefail

app="${1:?expected signed Screenpipe app}"
output="${2:?expected companion output directory}"
identity="${APPLE_SIGNING_IDENTITY:?expected signing identity}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
codesign --verify --deep --strict "$app"
requirement="$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')"
[[ -n "$requirement" ]] || { echo 'app has no designated signing requirement' >&2; exit 1; }
helper="$output/Open updated Screenpipe.app"
mkdir -p "$helper/Contents/MacOS"

python3 - "$app" "$helper" "$requirement" <<'PY'
import pathlib, plistlib, sys
app, helper = map(pathlib.Path, sys.argv[1:3])
source = plistlib.loads((app / 'Contents/Info.plist').read_bytes())
plist = {
    'CFBundleIdentifier': source['CFBundleIdentifier'] + '.update-recovery',
    'CFBundleName': 'Open updated Screenpipe',
    'CFBundleExecutable': 'update-recovery',
    'CFBundlePackageType': 'APPL',
    'CFBundleVersion': source['CFBundleVersion'],
    'CFBundleShortVersionString': source['CFBundleShortVersionString'],
    'LSMinimumSystemVersion': '12.0',
    'LSUIElement': True,
    'ScreenpipeTargetRequirement': sys.argv[3],
    'ScreenpipeTargetBundleName': app.name,
    'ScreenpipeManualHandoffProtocol': source['ScreenpipeManualHandoffProtocol'],
}
(helper / 'Contents/Info.plist').write_bytes(plistlib.dumps(plist))
PY
executable="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app/Contents/Info.plist")"
architectures="$(lipo -archs "$app/Contents/MacOS/$executable")"
objects=()
for architecture in $architectures; do
  object="$output/update-recovery-$architecture"
  xcrun swiftc -O -swift-version 5 -target "$architecture-apple-macos12.0" \
    "$script_dir/macos-update-recovery.swift" -o "$object"
  objects+=("$object")
done
lipo -create "${objects[@]}" -output "$helper/Contents/MacOS/update-recovery"
rm "${objects[@]}"
timestamp=(--timestamp)
# VM development certificates cannot obtain Apple's production timestamp.
[[ "${SCREENPIPE_RECOVERY_DEVELOPMENT:-0}" == 1 ]] && timestamp=(--timestamp=none)
codesign --force --options runtime "${timestamp[@]}" --sign "$identity" "$helper"
codesign --verify --deep --strict "$helper"
