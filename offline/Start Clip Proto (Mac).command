#!/bin/bash
# Double-click to start Clip Proto. Keep the Terminal window open while you use
# it; close it (or press Ctrl+C) to stop.
DIR="$(cd "$(dirname "$0")" && pwd)"
xattr -dr com.apple.quarantine "$DIR" 2>/dev/null  # downloaded files are flagged; clear it for the bundled Node
case "$(uname -m)" in
  arm64) NODE="$DIR/runtime/mac-arm64/node" ;;
  *)     NODE="$DIR/runtime/mac-x64/node" ;;
esac
chmod +x "$NODE" 2>/dev/null
cd "$DIR/app" || exit 1
echo
echo "  Clip Proto is starting. Your browser will open in a moment."
echo "  Keep this window open while you use it; close it to stop Clip Proto."
echo
CLIP_PROTO_OPEN=1 exec "$NODE" server.js
