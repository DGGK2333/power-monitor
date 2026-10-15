#!/system/bin/sh
# ============================================================
# 功率监测 - 控制脚本 (供 WebUI 调用)
#   用法:
#     ctl.sh start     启动守护进程
#     ctl.sh stop      停止
#     ctl.sh status    输出 key=value 状态
#     ctl.sh read [n]  输出最近 n 行数据(默认300)
#     ctl.sh domains   输出可用域列表
# ============================================================

MODDIR="${MODDIR:-/data/adb/modules/power_monitor}"
DAEMON="$MODDIR/bin/power_daemon.sh"
DATA_FILE="/data/local/tmp/power_monitor.dat"
ARCHIVE="/data/local/tmp/power_monitor_archive.log"
PID_FILE="/data/local/tmp/power_monitor.pid"
LOCK_DIR="/data/local/tmp/power_monitor.lock"

# 读取 daemon PID: 优先权威来源 $LOCK_DIR/pid, 回退 $PID_FILE
# (不做 /proc 全量扫描, 避免卡死)
get_pid() {
    for f in "$LOCK_DIR/pid" "$PID_FILE"; do
        if [ -f "$f" ]; then
            p=""; read -r p < "$f" 2>/dev/null
            [ -n "$p" ] && { echo "$p"; return; }
        fi
    done
}

# 用 kill -0 判断该 pid 是否存活
is_running() {
    pid=$(get_pid)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

case "$1" in
start)
    if is_running; then
        echo "RUNNING=1"
        echo "STARTED=0"
        exit 0
    fi
    # 清理陈旧锁/pid
    rm -rf "$LOCK_DIR" "$PID_FILE"
    # 后台化启动，脱离当前会话
    setsid sh "$DAEMON" >/dev/null 2>&1 </dev/null &
    sleep 1.5
    if is_running; then
        echo "RUNNING=1"
        echo "STARTED=1"
    else
        echo "RUNNING=0"
        echo "STARTED=0"
    fi
    ;;
stop)
    pid=$(get_pid)
    if [ -n "$pid" ]; then
        # 先发 SIGTERM 让 daemon 的 trap cleanup 执行(归档未结束会话)
        kill "$pid" 2>/dev/null
        # 等最多 3 秒优雅退出
        i=0
        while kill -0 "$pid" 2>/dev/null && [ $i -lt 15 ]; do
            sleep 0.2
            i=$((i+1))
        done
        # 仍未退出则强杀(此时无法再归档, 但实时数据文件还在)
        if kill -0 "$pid" 2>/dev/null; then
            kill -9 "$pid" 2>/dev/null
        fi
    fi
    rm -f "$PID_FILE" "$DATA_FILE.tmp"
    rm -rf "$LOCK_DIR"
    echo "RUNNING=0"
    echo "STOPPED=1"
    ;;
status)
    # 设备支持性
    if [ -d /sys/class/powercap/qpt ]; then
        echo "SUPPORTED=1"
    else
        echo "SUPPORTED=0"
    fi
    if is_running; then echo "RUNNING=1"; else echo "RUNNING=0"; fi
    if [ -f "$DATA_FILE" ]; then
        echo "POINTS=$(wc -l <"$DATA_FILE" 2>/dev/null | tr -d ' ')"
    else
        echo "POINTS=0"
    fi
    ;;
read)
    n="${2:-300}"
    if [ -f "$DATA_FILE" ]; then
        tail -n "$n" "$DATA_FILE" 2>/dev/null
    fi
    ;;
archive)
    # 输出归档的会话记录(最新在后)
    if [ -f "$ARCHIVE" ]; then
        cat "$ARCHIVE" 2>/dev/null
    fi
    ;;
archive-clear)
    : >"$ARCHIVE"
    echo "ARCHIVE_CLEARED=1"
    ;;
domains)
    for f in /sys/class/powercap/qpt:*; do
        [ -e "$f" ] || continue
        cat "$f/name" 2>/dev/null
        echo
    done
    ;;
*)
    echo "usage: $0 {start|stop|status|read [n]|archive|archive-clear|domains}"
    ;;
esac