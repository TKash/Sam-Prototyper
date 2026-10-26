#!/usr/bin/env bash
# Builds the offline package: a folder (and zip) the client unzips and starts
# with a double-click on Windows or Mac. Nothing to install, no internet needed
# (except for the phone remote, whose relay is online).
#
#   offline/build.sh [out-dir]       (default: dist)
#
# It bundles Node.js for Windows and Mac, local copies of the CDN libraries
# (ffmpeg, mp4-muxer, qrcode), and copies every prototype in the hosted
# client gallery with all its videos. Needs curl, tar, unzip, zip, python3, npm.
set -euo pipefail

HOSTED=${CLIP_PROTO_HOSTED:-https://clip-proto.clip-proto.workers.dev}
NODE_VERSION=v22.23.3
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$(mkdir -p "${1:-$REPO/dist}" && cd "${1:-$REPO/dist}" && pwd)
PKG="$OUT/Clip Proto"
CACHE="$OUT/.cache"
mkdir -p "$CACHE"
rm -rf "$PKG"
mkdir -p "$PKG/app" "$PKG/runtime"

echo "• App"
cp -R "$REPO/server.js" "$REPO/package.json" "$REPO/public" "$PKG/app/"
cp "$REPO/offline/Start Clip Proto (Windows).bat" "$REPO/offline/Start Clip Proto (Mac).command" "$REPO/offline/How to use.txt" "$PKG/"
chmod +x "$PKG/Start Clip Proto (Mac).command"

fetch() { [ -s "$CACHE/$2" ] || curl -fsSL "$1" -o "$CACHE/$2"; }

echo "• Node.js $NODE_VERSION (Windows x64, Mac Apple silicon, Mac Intel)"
fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-win-x64.zip" win.zip
fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz" mac-arm64.tar.gz
fetch "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-x64.tar.gz" mac-x64.tar.gz
mkdir -p "$PKG/runtime/windows" "$PKG/runtime/mac-arm64" "$PKG/runtime/mac-x64"
unzip -q -j -o "$CACHE/win.zip" "node-$NODE_VERSION-win-x64/node.exe" "node-$NODE_VERSION-win-x64/LICENSE" -d "$PKG/runtime/windows"
for a in arm64 x64; do
  tar -xzf "$CACHE/mac-$a.tar.gz" -C "$PKG/runtime/mac-$a" --strip-components=1 "node-$NODE_VERSION-darwin-$a/bin/node" "node-$NODE_VERSION-darwin-$a/LICENSE"
  mv "$PKG/runtime/mac-$a/bin/node" "$PKG/runtime/mac-$a/node" && rmdir "$PKG/runtime/mac-$a/bin"
done

echo "• Libraries (ffmpeg, mp4-muxer, qrcode)"
( cd "$CACHE" && for p in @ffmpeg/core@0.12.10 mp4-muxer@5.1.3 qrcode-generator@1.4.4; do
    f=$(echo "$p" | sed 's/^@//; s/\//-/; s/@/-/'); [ -s "$f.tgz" ] || npm pack -s "$p" >/dev/null; done )
V="$PKG/app/vendor"; mkdir -p "$V/ffmpeg"
tar -xzf "$CACHE/ffmpeg-core-0.12.10.tgz" -C "$V/ffmpeg" --strip-components=3 package/dist/esm/ffmpeg-core.js package/dist/esm/ffmpeg-core.wasm
tar -xzf "$CACHE/mp4-muxer-5.1.3.tgz" -O package/build/mp4-muxer.mjs > "$V/mp4-muxer.mjs"
tar -xzf "$CACHE/qrcode-generator-1.4.4.tgz" -O package/qrcode.js > "$V/qrcode.min.js"

echo "• Prototypes in the client gallery at $HOSTED"
python3 -I - "$HOSTED" "$PKG/app/data" "$CACHE/media" <<'EOF'
import json, os, re, shutil, sys, urllib.error, urllib.request
host, data, cache = sys.argv[1:4]
UA = {'User-Agent': 'Mozilla/5.0 (Clip Proto offline build)'}
get = lambda path: urllib.request.urlopen(urllib.request.Request(host + path, headers=UA), timeout=600)
os.makedirs(f'{data}/projects', exist_ok=True); os.makedirs(f'{data}/media', exist_ok=True); os.makedirs(cache, exist_ok=True)
MEDIA = re.compile(r'^[\w-]{6,64}\.(mp4|m4v|mov|webm|jpg|png|webp)$')
def files_in(v):  # every media file name anywhere in a project
    if isinstance(v, dict): return [f for k, x in v.items() if k != 'name' for f in files_in(x)] + [k for k in v if MEDIA.match(k)]
    if isinstance(v, list): return [f for x in v for f in files_in(x)]
    return [v] if isinstance(v, str) and MEDIA.match(v) else []
total = 0
for g in json.load(get('/api/gallery')):
    p = json.load(get(f"/api/projects/{g['id']}"))
    for k in ('pagesProject', 'publicUrl', 'publishedAt'): p.pop(k, None)  # the hosted publish info isn't this copy's
    files = sorted(set(files_in(p)))
    for f in files:
        dst = f'{cache}/{f}'
        if not os.path.exists(dst):
            try:
                with get(f'/media/{f}') as r, open(dst + '.part', 'wb') as out: shutil.copyfileobj(r, out)
            except urllib.error.HTTPError as e:
                print(f'    ! {f} is referenced but missing on the hosted site ({e.code}), skipped'); continue
            os.replace(dst + '.part', dst)
        shutil.copy(dst, f'{data}/media/{f}'); total += os.path.getsize(dst)
    json.dump(p, open(f"{data}/projects/{p['id']}.json", 'w'), indent=2)
    print(f"    {p['name'].strip()}: {len(files)} files")
print(f'    {total / 1e6:.0f} MB of media')
EOF

echo "• Zips (one for Windows, one for Mac)"
rm -f "$OUT/Clip Proto.zip" "$OUT/Clip Proto (Windows).zip" "$OUT/Clip Proto (Mac).zip"
# Mac: Unix permissions, so the starter and Node stay executable after unzipping.
( cd "$OUT" && zip -qr -X "Clip Proto (Mac).zip" "Clip Proto" -x "Clip Proto/runtime/windows/*" "Clip Proto/Start Clip Proto (Windows).bat" )
# Windows: plain DOS-style entries (what Windows' own zip folders expect), no Mac files.
python3 -I - "$OUT" <<'PY'
import os, sys, time, zipfile
out = sys.argv[1]; root = 'Clip Proto'
skip = lambda rel: rel.startswith(f'{root}/runtime/mac-') or rel.endswith('.command')
stored = ('.mp4', '.m4v', '.mov', '.webm', '.jpg', '.png', '.webp', '.zip')
with zipfile.ZipFile(f'{out}/Clip Proto (Windows).zip', 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for d, dirs, files in os.walk(f'{out}/{root}'):
        dirs.sort()
        rel = os.path.relpath(d, out).replace(os.sep, '/')
        if skip(rel + '/'): continue
        for name in sorted(files):
            r = f'{rel}/{name}'
            if skip(r): continue
            path = f'{d}/{name}'
            info = zipfile.ZipInfo(r, time.localtime(os.path.getmtime(path))[:6])
            info.create_system = 0; info.external_attr = 0x20  # MS-DOS, "archive"
            info.compress_type = zipfile.ZIP_STORED if name.lower().endswith(stored) else zipfile.ZIP_DEFLATED
            with open(path, 'rb') as f: z.writestr(info, f.read())
PY
unzip -tq "$OUT/Clip Proto (Windows).zip" && unzip -tq "$OUT/Clip Proto (Mac).zip"
du -sh "$PKG" "$OUT/Clip Proto (Windows).zip" "$OUT/Clip Proto (Mac).zip"
