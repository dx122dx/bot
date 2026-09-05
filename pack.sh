#!/usr/bin/env bash
# mineflayer 分发包打包脚本（CI / 本地通用）
#
# 用法: ./pack.sh [标签] [-m slim|full]
#   标签          产物名后缀，默认 dev；CI 可传 run 号 / commit sha
#   -m slim       精简包（默认）：dist + package.json/lock + config.example.json + texture-src
#   -m full       自包含包：精简包内容 + node_modules（排除可选依赖 canvas，纯 JS 跨平台）
#
# 产物（输出目录 build/，zip 根 = 项目根）:
#   mineflayer-dist-<标签>.zip            精简包（-m slim）
#   mineflayer-dist-<标签>-with-deps.zip  自包含包（-m full）
#
# 包内 INSTALL.txt 由 pack-assets/<模式>/install.txt.template 渲染，
# 支持占位符 {{VERSION}} / {{BUILT_AT}} / {{TAG}}。
# 改依赖、构建步骤或启动方式时，记得同步更新对应模板。
set -euo pipefail
cd "$(dirname "$0")"

command -v zip >/dev/null 2>&1 || { echo "错误: 未找到 zip 命令" >&2; exit 1; }

TAG="dev"
MODE="slim"
while [ $# -gt 0 ]; do
  case "$1" in
    -m) shift; MODE="${1:-}" ;;
    -m*) MODE="${1#-m}" ;;
    -*) echo "未知参数: $1" >&2; exit 1 ;;
    *) TAG="$1" ;;
  esac
  shift
done

if [ "$MODE" != "slim" ] && [ "$MODE" != "full" ]; then
  echo "错误: -m 只接受 slim 或 full（当前: ${MODE:-空}）" >&2
  exit 1
fi

# 白名单（沿用 export.sh 约定：排除 config.json / *.log / .codebuddy / legacy / local /
# 以及 viewer-assets 生成产物 blocksStates、textures —— 首次启动由 viewer-patch.cjs 自动重建）
INCLUDE=(
  dist
  package.json
  package-lock.json
  config.example.json
  viewer-assets/texture-src
)

for f in "${INCLUDE[@]}"; do
  if [ ! -e "$f" ]; then
    echo "错误: 缺少 '$f'（请先执行 npm run build）" >&2
    exit 1
  fi
done

TEMPLATE="$PWD/pack-assets/${MODE}/install.txt.template"
if [ ! -f "$TEMPLATE" ]; then
  echo "错误: 缺少安装说明模板 '$TEMPLATE'" >&2
  exit 1
fi

VERSION="$(node -p "require('./package.json').version")"
BUILT_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"
OUT_DIR="$PWD/build"
mkdir -p "$OUT_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 渲染安装说明：占位符替换后写入临时目录，保证以 INSTALL.txt 落在 zip 根
sed -e "s|{{VERSION}}|${VERSION}|g" \
    -e "s|{{BUILT_AT}}|${BUILT_AT}|g" \
    -e "s|{{TAG}}|${TAG}|g" \
    "$TEMPLATE" > "$TMP/INSTALL.txt"

# 打包：zip 根 = 项目根；INSTALL.txt 从临时目录追加
pack() { # $1 = 产物绝对路径，其余 = 追加到白名单后的 zip 参数
  local dest="$1"; shift
  rm -f "$dest"
  zip -r -9 -q "$dest" "${INCLUDE[@]}" "$@"
  ( cd "$TMP" && zip -q "$dest" INSTALL.txt )
}

if [ "$MODE" = "slim" ]; then
  pack "$OUT_DIR/mineflayer-dist-${TAG}.zip"
  echo "已生成: $OUT_DIR/mineflayer-dist-${TAG}.zip"
else
  if [ ! -d node_modules ]; then
    echo "错误: 缺少 node_modules（请先执行 npm ci）" >&2
    exit 1
  fi
  # 排除可装依赖 canvas：让自包含包保持纯 JS，不绑定操作系统与 Node ABI
  pack "$OUT_DIR/mineflayer-dist-${TAG}-with-deps.zip" node_modules \
    -x 'node_modules/canvas/*' -x 'node_modules/canvas'
  echo "已生成: $OUT_DIR/mineflayer-dist-${TAG}-with-deps.zip"
fi
