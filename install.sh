#!/usr/bin/env bash
# dsh-mcp-manager 安装脚本：把插件装进一个 DSH profile（默认为桌面 profile）。
#
# 做的事（幂等，可重复执行用于升级）：
#   1. 备份 <profile>/package.json；
#   2. 复制本目录到 <profile>/node_modules/dsh-mcp-manager；
#   3. 在 <profile>/package.json 的 dsh.profile.bundles 末尾登记 dsh-mcp-manager。
#
# 不修改 cordis.patch.yml、不改 profile 依赖版本、不执行 pnpm。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE="${1:-$HOME/.dsh/profiles/desktop}"
PROFILE="$(cd "$PROFILE" 2>/dev/null && pwd || true)"

if [[ -z "$PROFILE" || ! -f "$PROFILE/package.json" ]]; then
  echo "错误：找不到 profile，或它没有 package.json：${1:-$HOME/.dsh/profiles/desktop}" >&2
  echo "用法：$0 [profile 目录]" >&2
  exit 1
fi

BUNDLE="dsh-mcp-manager"
TARGET="$PROFILE/node_modules/$BUNDLE"
case "$TARGET" in
  */node_modules/dsh-mcp-manager) ;;
  *) echo "错误：目标路径异常：$TARGET" >&2; exit 1 ;;
esac

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$PROFILE/package.json.bak-mcp-manager-$STAMP"
cp "$PROFILE/package.json" "$BACKUP"
echo "已备份 package.json → $BACKUP"

mkdir -p "$TARGET/locale" "$TARGET/test"
cp "$PLUGIN_DIR/package.json" "$PLUGIN_DIR/index.js" "$PLUGIN_DIR/client.js" \
   "$PLUGIN_DIR/cordis.patch.yml" "$PLUGIN_DIR/icon.svg" "$PLUGIN_DIR/README.md" "$TARGET/"
cp "$PLUGIN_DIR/locale/"*.json "$TARGET/locale/"
cp "$PLUGIN_DIR/test/"*.mjs "$TARGET/test/" 2>/dev/null || true
echo "已复制插件文件 → $TARGET"

node - "$PROFILE/package.json" "$BUNDLE" <<'NODE'
const fs = require('node:fs');
const [file, bundle] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.dsh ??= {};
data.dsh.profile ??= {};
const bundles = (data.dsh.profile.bundles ??= []);
if (!bundles.includes(bundle)) bundles.push(bundle);
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
console.log('bundles:', bundles.join(', '));
NODE

echo
echo "安装完成。请重启 DeepSeek Harness，然后在 设置 → MCP 服务 查看，或在对话里说「列出我的 MCP 服务」。"
echo "卸载：$PLUGIN_DIR/uninstall.sh \"$PROFILE\""
