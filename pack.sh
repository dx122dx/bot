#!/usr/bin/env bash
# mineflayer 分发包打包脚本（CI / 本地通用）
#
# 用法: ./pack.sh [标签] [--skip-full]
#   标签         产物名后缀，默认 dev；CI 可传 run 号 / commit sha
#   --skip-full  只产精简包，不打自包含包（含 node_modules 的那份）
#
# 产物（输出目录 build/，zip 根 = 项目根）:
#   mineflayer-dist-<标签>.zip            精简包：目标机 npm ci --omit=dev 后 npm start
#   mineflayer-dist-<标签>-with-deps.zip  自包含包：含 node_modules（已排除可选依赖 canvas），纯 JS 跨平台解压即跑
set -euo pipefail
cd "$(dirname "$0")"

command -v zip >/dev/null 2>&1 || { echo "错误: 未找到 zip 命令" >&2; exit 1; }

TAG="dev"
SKIP_FULL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-full) SKIP_FULL=1 ;;
    -*) echo "未知参数: $1" >&2; exit 1 ;;
    *) TAG="$1" ;;
  esac
  shift
done

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

VERSION="$(node -p "require('./package.json').version")"
BUILT_AT="$(date '+%Y-%m-%d %H:%M:%S %Z')"
OUT_DIR="$PWD/build"
mkdir -p "$OUT_DIR"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 打包：zip 根 = 项目根；INSTALL.txt 从临时目录追加，保证落在 zip 根且文件名正确。
# 始终排除可选依赖 canvas：自包含包保持纯 JS，不被原生二进制绑死平台与 Node ABI。
pack() { # $1 = 产物绝对路径，其余 = 追加到白名单后的顶级条目
  local dest="$1"; shift
  rm -f "$dest"
  zip -r -9 -q "$dest" "${INCLUDE[@]}" "$@" -x 'node_modules/canvas/*' -x 'node_modules/canvas'
  ( cd "$TMP" && zip -q "$dest" INSTALL.txt )
}

# ---------- 精简包 ----------
cat > "$TMP/INSTALL.txt" <<EOF
mineflayer 精简分发包 v${VERSION}
构建时间: ${BUILT_AT}
构建标签: ${TAG}

内容：
  dist/                       已编译产物（npm run build 的输出）
  package.json                依赖清单
  package-lock.json           锁定版本
  config.example.json         配置模板
  viewer-assets/texture-src/  纹理源（118 个 PNG）

使用：
  1) npm ci --omit=dev                     # 需要网络
  2) cp config.example.json config.json    # 填写账号密码等配置
  3) npm start

说明：
  - 无需再执行 npm run build，dist/ 已就位。
  - canvas 是可装依赖（optionalDependencies），只有 !view 可视化用到：
    装不上只会被跳过，不影响机器人其余功能；若 !view 提示缺少 canvas，执行：
      npm i canvas
  - viewer-assets/blocksStates 与 viewer-assets/textures 是生成产物，不随包分发，
    首次启动时由 dist/src/viewer-patch.cjs 从 texture-src 自动重建。
EOF
pack "$OUT_DIR/mineflayer-dist-${TAG}.zip"
echo "已生成: $OUT_DIR/mineflayer-dist-${TAG}.zip"

# ---------- 自包含包 ----------
if [ "$SKIP_FULL" -eq 1 ]; then
  echo "已跳过自包含包（--skip-full）"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "错误: 缺少 node_modules（请先执行 npm ci）" >&2
  exit 1
fi

cat > "$TMP/INSTALL.txt" <<EOF
mineflayer 自包含分发包 v${VERSION}
构建时间: ${BUILT_AT}
构建标签: ${TAG}

内容：
  精简包的全部内容 + node_modules（已 npm prune --omit=dev，不含 devDependencies）
  注意：已排除可装依赖 canvas，因此本包为纯 JS 依赖树，不绑定操作系统与 Node ABI。

运行环境：
  - 任意装了 Node.js 的平台（linux / macOS / Windows 均可），建议 Node 18+（本项目在 Node 26 上构建）
  - 无需网络、无需 npm install、无需 npm run build

使用：
  1) cp config.example.json config.json    # 填写账号密码等配置
  2) npm start

说明：
  - 本包不含 canvas，因此 !view 可视化不可用（控制台会给出提示，机器人其余功能不受影响）。
    若需要可视化，在本目录执行（需网络与对应平台的编译/预编译支持）：
      npm i canvas
  - viewer-assets/blocksStates 与 viewer-assets/textures 是生成产物，不随包分发，
    首次启动时由 dist/src/viewer-patch.cjs 从 texture-src 自动重建。
EOF
pack "$OUT_DIR/mineflayer-dist-${TAG}-with-deps.zip" node_modules
echo "已生成: $OUT_DIR/mineflayer-dist-${TAG}-with-deps.zip"
