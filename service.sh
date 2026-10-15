#!/system/bin/sh
# ============================================================
# Power Monitor - 开机自启
#   等开机完成后启动功率采样守护进程
# ============================================================

MODDIR=${0%/*}

# 等待开机完成
w=0
until [ "$(getprop sys.boot_completed)" = "1" ] || [ $w -ge 120 ]; do
    sleep 1
    w=$((w + 1))
done

# 启动守护进程(避免重复)
if [ -x "$MODDIR/bin/ctl.sh" ]; then
    sh "$MODDIR/bin/ctl.sh" start
fi