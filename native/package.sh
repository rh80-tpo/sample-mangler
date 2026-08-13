#!/usr/bin/env bash
#
# Build a universal VST3 and zip it with instructions, ready to send to someone.
#
# The zip is deliberately built with `ditto`, not `zip`: a .vst3 is a bundle, and
# plain zip can mangle the symlinks and resource layout inside one. ditto is what
# Apple's own tooling uses.
set -euo pipefail
cd "$(dirname "$0")"

NAME="HAZEN Sampler"
VERSION="${1:-0.16}"
OUT="dist"
# Named, because this is the folder name the recipient sees when they unzip.
STAGE="$OUT/HAZEN Sampler $VERSION"

echo "==> building universal (arm64 + x86_64)"
cmake -B build -S plugin -DCMAKE_BUILD_TYPE=Release -DHAZEN_ARCHS="arm64;x86_64" > /dev/null
cmake --build build --config Release --target HazenSampler_VST3 --parallel 8 > /dev/null

BUILT="build/HazenSampler_artefacts/Release/VST3/$NAME.vst3"
[ -d "$BUILT" ] || { echo "build did not produce $BUILT"; exit 1; }

echo "==> checking the binary"
lipo -info "$BUILT/Contents/MacOS/$NAME"
codesign -v "$BUILT" && echo "signature: ok (ad-hoc)"

rm -rf "$STAGE"
mkdir -p "$STAGE"
ditto "$BUILT" "$STAGE/$NAME.vst3"
cp SHARING.md "$STAGE/READ ME FIRST.md"

ZIP="$OUT/HAZEN-Sampler-$VERSION-macOS.zip"
rm -f "$ZIP"
ditto -c -k --sequesterRsrc --keepParent "$STAGE" "$ZIP"
rm -rf "$STAGE"

echo
echo "==> $ZIP"
du -h "$ZIP"
