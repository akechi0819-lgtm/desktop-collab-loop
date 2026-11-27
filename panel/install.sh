#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
destination="$HOME/.gemini/config/plugins/ai-collab-panel"
if [ -e "$destination" ] || [ -L "$destination" ]; then
  echo "保留已有面板安装: $destination"
  exit 0
fi
node_bin=$(command -v node) || { echo '安装面板需要 Node.js' >&2; exit 1; }
command -v npm >/dev/null || { echo '安装面板需要 npm' >&2; exit 1; }
node_bin=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$node_bin")
mkdir -p "$(dirname "$destination")"
stage=$(mktemp -d "$(dirname "$destination")/.ai-collab-panel.XXXXXX")
trap 'rm -r "$stage"' EXIT HUP INT TERM
cp "$root/package.json" "$root/package-lock.json" "$root/plugin.json" "$root/build-ui.mjs" "$root/server.mjs" "$stage/"
cp -R "$root/src" "$stage/src"
cd "$stage"
npm ci
npm run build
python3 - "$node_bin" <<'PY'
import json
import sys
from pathlib import Path
config = {'mcpServers': {'panel': {'command': sys.argv[1], 'args': ['${PLUGIN_ROOT}/server.mjs']}}}
Path('mcp_config.json').write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
PY
mv "$stage" "$destination"
trap - EXIT HUP INT TERM
echo "面板已安装: $destination"
