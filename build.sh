#!/system/bin/sh
# ============================================================
# Power Monitor — 打包脚本
#   把仓库当前内容打成一个可直接刷入的 Magisk/KernelSU 模块 zip
#
#   用法：sh build.sh [输出目录]
#   例：  sh build.sh dist
# ============================================================
set -e

SRC=${0%/*}
[ "$SRC" = "$0" ] && SRC=.
OUT=${1:-dist}
VER=$(sed -n 's/^version=//p' "$SRC/module.prop" | tr -d '\r')
NAME="power_monitor_${VER:-unknown}.zip"

mkdir -p "$OUT"
rm -f "$OUT/$NAME"

# META-INF 必须排在最前，且不打包仓库自身的元文件
cd "$SRC"
zip -r -9 "$OLDPWD/$OUT/$NAME" \
    META-INF module.prop service.sh README.md DESIGN.md bin webroot \
    -x '*.zip' -x '.git/*' -x 'dist/*' >/dev/null

echo "built: $OUT/$NAME"
