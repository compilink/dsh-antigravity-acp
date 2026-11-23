#!/bin/zsh
set -u
umask 077
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
root_dir="${0:A:h:h}"
login_script="$root_dir/data/profiles/web/local-packages/dsh-bundle-antigravity-official-acp/scripts/official-macos-login.mjs"
profile_dir="$root_dir/data/home"
if [[ ! -r "$login_script" || ! -d "$profile_dir" ]]; then
  print -u2 '未找到已安装的 Antigravity ACP 插件或其 DSH 数据目录。请从 DSH 的 bin 目录打开此登录器。'
  exit 1
fi
if ! command -v node >/dev/null; then
  print -u2 '登录器需要 macOS 上的 Node.js 22.19 或更新版本。'
  exit 1
fi
exec node "$login_script" --home "$profile_dir" --cache-dir "$profile_dir/.cache/dsh-antigravity-host" "$@"
