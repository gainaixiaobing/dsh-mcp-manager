#!/usr/bin/env bash
# dsh-mcp-manager 卸载脚本：从指定 profile 移除插件登记与插件目录。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-$HOME/.dsh/profiles/desktop}"
PROFILE="$(cd "$PROFILE" 2>/dev/null && pwd || true)"

if [[ -z "$PROFILE" || ! -f "$PROFILE/package.json" ]]; then
  echo "错误：找不到 profile，或它没有 package.json：${1:-$HOME/.dsh/profiles/desktop}" >&2
  exit 1
fi

BUNDLE="dsh-mcp-manager"
TARGET="$PROFILE/node_modules/$BUNDLE"
case "$TARGET" in
  */node_modules/dsh-mcp-manager) ;;
  *) echo "错误：目标路径异常：$TARGET" >&2; exit 1 ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
cp "$PROFILE/package.json" "$PROFILE/package.json.bak-mcp-manager-uninstall-$STAMP"
echo "已备份 package.json → $PROFILE/package.json.bak-mcp-manager-uninstall-$STAMP"

node - "$PROFILE/package.json" "$BUNDLE" <<'NODE'
const fs = require('node:fs');
const [file, bundle] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const bundles = data?.dsh?.profile?.bundles;
if (Array.isArray(bundles)) {
  data.dsh.profile.bundles = bundles.filter((name) => name !== bundle);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log('剩余 bundles:', data.dsh.profile.bundles.join(', ') || '(空)');
} else {
  console.log('package.json 中没有 dsh.profile.bundles，跳过登记移除');
}
NODE

if [[ -d "$TARGET" ]]; then
  rm -rf "$TARGET"
  echo "已删除 $TARGET"
else
  echo "未找到 $TARGET，跳过目录删除"
fi

echo
echo "卸载完成。请重启 DeepSeek Harness 使改动生效。"
echo "（插件源码仍在：$PLUGIN_DIR）"
