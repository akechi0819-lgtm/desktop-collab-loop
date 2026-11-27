#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agy_cli=$(command -v agy || true)
[ -n "$agy_cli" ] || agy_cli=agy
if [ -x /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex ]; then
  codex_cli=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
else
  codex_cli=$(command -v codex || true)
  [ -n "$codex_cli" ] || codex_cli=codex
fi
with_panel=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --agy-cli|--codex-cli)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "$1 需要非空参数" >&2; exit 2; }
      case "$1" in --agy-cli) agy_cli=$2;; --codex-cli) codex_cli=$2;; esac
      shift 2;;
    --with-panel) with_panel=1; shift;;
    --help|-h)
      echo '用法: ./install.sh [--agy-cli 路径或命令名] [--codex-cli 路径或命令名] [--with-panel]'
      echo '默认使用 PATH 中的 agy，优先使用 ChatGPT 内置 codex；已有文件不会覆盖。'
      exit 0;;
    *) echo "未知参数: $1" >&2; exit 2;;
  esac
done

install_file() {
  source=$1
  destination=$2
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "保留已有文件: $destination"
  else
    mkdir -p "$(dirname "$destination")"
    cp -p "$source" "$destination"
    echo "已安装: $destination"
  fi
}
for name in agy-ask codex-ask night-run collab-history; do
  install_file "$root/bin/$name" "$HOME/.local/bin/$name"
done
for name in audit-prompt.md handoff-template.md; do
  install_file "$root/share/$name" "$HOME/.local/share/ai-collab/$name"
done
install_file "$root/skills/collab-loop/SKILL.md" "$HOME/.codex/skills/collab-loop/SKILL.md"
install_file "$root/skills/collab-loop/agents/openai.yaml" "$HOME/.codex/skills/collab-loop/agents/openai.yaml"
install_file "$root/skills/collab-loop/SKILL.md" "$HOME/.gemini/config/skills/collab-loop/SKILL.md"
config="$HOME/.local/share/ai-collab/config.json"
if [ -e "$config" ] || [ -L "$config" ]; then
  echo "保留已有配置: ${config}（CLI 参数仅用于新配置）"
else
  mkdir -p "$(dirname "$config")"
  python3 - "$root/share/config.example.json" "$config" "$agy_cli" "$codex_cli" <<'PY'
import json
import sys
from pathlib import Path
source, destination, agy, codex = sys.argv[1:]
config = json.loads(Path(source).read_text())
config['cli_paths'] = {'agy': agy, 'codex': codex}
Path(destination).write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n')
PY
  echo "已安装: $config"
fi
if [ "$with_panel" -eq 1 ]; then
  "$root/panel/install.sh"
fi
