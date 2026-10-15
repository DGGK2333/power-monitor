#!/system/bin/sh
# ============================================================
# 功率 / 温度采样 + 会话归档守护进程 (Power Monitor Daemon) v5
# ------------------------------------------------------------
# v5 核心优化: 彻底消除 fork 风暴
#   1) cat  ->  read -r var < file   (Shell 内建, 0 fork)
#   2) awk  ->  shell 整数比较/除法 (0 fork, 且防 32 位溢出)
#   3) 所有 sysfs 路径启动时一次性缓存, 主循环不再遍历目录
#   4) 主循环内**没有任何 $(...) 命令替换**(包括函数), 避免隐式 fork
#      唯一残留 fork: date(1次/秒)、wc(1次/秒用于裁剪计数)
#   注意: Android sh(mksh) 的 $(( )) 是 32 位, 大数运算须先缩放
# ------------------------------------------------------------
# 数据源:
#   功率 : /sys/class/powercap/qpt:*/power_uw      (µW)
#   整机 : battery/current_now(µA) * voltage_now(µV)
#   充电 : usb/current_now(µA) * voltage_now(µV)
#   温度 : thermal_zone* cpullc-*/gpuss-*/batt_temp (0.001℃, 取最大)
#   状态 : battery/status -> 0放电/1充电/2满/3其他
# 实时(环形900点): /data/local/tmp/power_monitor.dat
#   13 列: ts soc cpum cpul gpu nsp batt chg cput gput battT cap st
# 归档(永久):      /data/local/tmp/power_monitor_archive.log
#   10 列: kind startTs endTs n avgBatt maxBatt avgChg maxChg startCap endCap
#   (batt 单位 µW; 单位与原版一致, WebUI 按 µW 解析)
# ============================================================

DATA_FILE="/data/local/tmp/power_monitor.dat"
ARCHIVE="/data/local/tmp/power_monitor_archive.log"
PID_FILE="/data/local/tmp/power_monitor.pid"
LOCK_DIR="/data/local/tmp/power_monitor.lock"
MAX_LINES=900
# 裁剪阈值: 实时缓冲允许涨到 MAX_LINES+TRIM_SLACK 才批量裁剪一次,
# 减少 tail+mv 频率(同时给 WebUI 留出更长的可视窗口)
TRIM_SLACK=300
TRIM_AT=$((MAX_LINES + TRIM_SLACK))
INTERVAL="${PM_INTERVAL:-1}"

BATT_DIR="/sys/class/power_supply/battery"
USB_DIR="/sys/class/power_supply/usb"

if [ -d /sys/class/powercap/qpt ]; then
    echo 1 > /sys/class/powercap/qpt/enabled 2>/dev/null
fi

# ============================================================
# 启动阶段: 一次性解析并缓存全部 sysfs 路径
#   (此处允许 fork, 因为只执行一次)
# ============================================================
QPT_SOC=""; QPT_CM=""; QPT_CL=""; QPT_GPU=""; QPT_NSP=""
for d in /sys/class/powercap/qpt:*; do
    [ -f "$d/power_uw" ] || continue
    nm=""; read -r nm < "$d/name" 2>/dev/null
    case "$nm" in
        soc)   QPT_SOC="$d/power_uw" ;;
        cpu-m) QPT_CM="$d/power_uw" ;;
        cpu-l) QPT_CL="$d/power_uw" ;;
        gpu)   QPT_GPU="$d/power_uw" ;;
        nsp)   QPT_NSP="$d/power_uw" ;;
    esac
done

# 温度路径列表(空格分隔), 启动时扫描一次
CPU_ZONES=""; GPU_ZONES=""; BATT_TEMP_FILE=""
for d in /sys/class/thermal/thermal_zone*; do
    t=""; read -r t < "$d/type" 2>/dev/null
    case "$t" in
        cpullc-*) CPU_ZONES="$CPU_ZONES $d/temp" ;;
        gpuss-*)  GPU_ZONES="$GPU_ZONES $d/temp" ;;
        batt_temp|battery) [ -z "$BATT_TEMP_FILE" ] && BATT_TEMP_FILE="$d/temp" ;;
    esac
done
[ -z "$CPU_ZONES" ] && for d in /sys/class/thermal/thermal_zone*; do
    t=""; read -r t < "$d/type" 2>/dev/null
    case "$t" in cpu-*) CPU_ZONES="$CPU_ZONES $d/temp" ;; esac
done

# ============================================================
# 原子锁
# ============================================================
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    old=""; read -r old < "$LOCK_DIR/pid" 2>/dev/null
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        exit 0
    fi
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
# PID 唯一权威来源: $LOCK_DIR/pid; $PID_FILE 为对外副本(供 ctl.sh 读取)
printf '%s' "$$" >"$LOCK_DIR/pid"
printf '%s' "$$" >"$PID_FILE"

: >"$DATA_FILE"

# 会话累计(单位: µW 累加可能溢出 32 位, 故累加时缩放到 mW)
SESS_KIND=""; SESS_START=0; SESS_END=0; SESS_N=0
SESS_SB=0; SESS_MB=0; SESS_SC=0; SESS_MC=0; SESS_SCAP=0; SESS_ECAP=0
# 去抖: 状态切换需连续 DEBOUNCE 个采样点一致才生效, 避免单点抖动切碎会话
DEBOUNCE="${PM_DEBOUNCE:-3}"
PEND_KIND=""; PEND_N=0

# 自行维护数据行数(避免每秒 wc -l fork); 启动时数据文件已清空
LINES=0

flush_session() {
    # 参数: kind st et n sumBatt_mW maxBatt_uW sumChg_mW maxChg_uW scap ecap
    # 归档时把 sum(mW) 还原成均值 µW: avg = sum_mW*1000/n
    local k="$1" st="$2" et="$3" n="$4" sb="$5" mb="$6" sc="$7" mc="$8" sa="$9" ea="${10}"
    [ "$n" -lt 2 ] && return
    local ab ac
    # sb 单位 mW, n 为点数 -> 均值 µW = sb*1000/n; 先除 n 再乘 1000 防溢出
    ab=$(( sb / n * 1000 ))
    ac=$(( sc / n * 1000 ))
    echo "$k $st $et $n $ab $mb $ac $mc $sa $ea" >>"$ARCHIVE"
}

cleanup() {
    if [ "$SESS_KIND" != "" ] && [ "$SESS_N" -ge 2 ]; then
        flush_session "$SESS_KIND" "$SESS_START" "$SESS_END" "$SESS_N" \
            "$SESS_SB" "$SESS_MB" "$SESS_SC" "$SESS_MC" "$SESS_SCAP" "$SESS_ECAP"
    fi
    rm -f "$PID_FILE"; rm -rf "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

# ============================================================
# 主循环 —— 零命令替换(除 date/wc)
# ============================================================
while :; do
    # 时间戳(1 fork/秒): date 有 %3N 则用毫秒, 否则秒*1000
    ts=$(date +%s%3N 2>/dev/null)
    [ -z "$ts" ] && ts=$(date +%s) && ts=$((ts*1000))

    # ---- 5 路 qpt 功率(直接 read 赋值, 零 fork) ----
    soc=0; [ -n "$QPT_SOC" ] && { read -r soc < "$QPT_SOC" 2>/dev/null; }
    cm=0;  [ -n "$QPT_CM" ]  && { read -r cm  < "$QPT_CM"  2>/dev/null; }
    cl=0;  [ -n "$QPT_CL" ]  && { read -r cl  < "$QPT_CL"  2>/dev/null; }
    gpu=0; [ -n "$QPT_GPU" ] && { read -r gpu < "$QPT_GPU" 2>/dev/null; }
    nsp=0; [ -n "$QPT_NSP" ] && { read -r nsp < "$QPT_NSP" 2>/dev/null; }
    # 容错: 空值归零; 数字可能被 read 吃掉, 保险起见校验
    case "$soc" in ''|*[!0-9-]*) soc=0 ;; esac
    case "$cm"  in ''|*[!0-9-]*) cm=0  ;; esac
    case "$cl"  in ''|*[!0-9-]*) cl=0  ;; esac
    case "$gpu" in ''|*[!0-9-]*) gpu=0 ;; esac
    case "$nsp" in ''|*[!0-9-]*) nsp=0 ;; esac
    # ---- 整机功率 (µA*µV/1e6=µW, 先 /1000 防 32 位溢出) ----
    # battery/current_now: 正值=放电, 负值=充电
    cur=0; vol=0
    read -r cur < "$BATT_DIR/current_now" 2>/dev/null
    read -r vol < "$BATT_DIR/voltage_now" 2>/dev/null
    case "$cur" in ''|*[!0-9-]*) cur=0 ;; esac
    case "$vol" in ''|*[!0-9-]*) vol=0 ;; esac
    bp=$(( (cur/1000) * (vol/1000) ))       # 有符号: 放电为正, 充电为负

    # ---- 充电功率: 充电时 = |整机功率|, 放电时为 0 ----
    # (不再用 usb/current_now, 该节点在本设备恒为 0)
    cp=0
    if [ "$cur" -lt 0 ]; then
        cp=$(( 0 - bp ))                     # bp 为负, 取正值
    fi


    # ---- CPU / GPU 温度(取最大, 纯整数比较) ----
    ct=0
    for f in $CPU_ZONES; do
        v=0; read -r v < "$f" 2>/dev/null
        case "$v" in ''|*[!0-9-]*) v=0 ;; esac
        [ "$v" -gt "$ct" ] 2>/dev/null && ct=$v
    done
    gt=0
    for f in $GPU_ZONES; do
        v=0; read -r v < "$f" 2>/dev/null
        case "$v" in ''|*[!0-9-]*) v=0 ;; esac
        [ "$v" -gt "$gt" ] 2>/dev/null && gt=$v
    done

    # ---- 电池温度 / 电量 / 状态 ----
    bt=0
    [ -n "$BATT_TEMP_FILE" ] && { read -r bt < "$BATT_TEMP_FILE" 2>/dev/null; }
    case "$bt" in ''|*[!0-9-]*) bt=0 ;; esac

    bc=0; read -r bc < "$BATT_DIR/capacity" 2>/dev/null
    case "$bc" in ''|*[!0-9-]*) bc=0 ;; esac

    # ---- 状态: 基于电流方向(比 battery/status 更稳定, 不抖动) ----
    # cur < 0 = 充电(st=1); cur >= 0 = 放电(st=0)
    # 说明: battery/status 在充电时会频繁抖动(Charging/Not charging/Full),
    #       会导致会话被切成很多小段; 改用电流方向判定后稳定得多。
    if [ "$cur" -lt 0 ]; then
        st=1
    else
        st=0
    fi

    # ---- 落盘 ----
    echo "$ts $soc $cm $cl $gpu $nsp $bp $cp $ct $gt $bt $bc $st" >>"$DATA_FILE"
    LINES=$((LINES+1))

    # ---- 会话检测(带去抖: 连续 DEBOUNCE 点同状态才切换) ----
    kind=""
    [ "$st" = "0" ] && kind="disch"
    [ "$st" = "1" ] && kind="chg"

    if [ "$kind" = "$SESS_KIND" ]; then
        # 状态未变: 清空候选计数
        PEND_KIND=""; PEND_N=0
    else
        # 状态与当前会话不同: 累积候选计数
        if [ "$kind" = "$PEND_KIND" ]; then
            PEND_N=$((PEND_N+1))
        else
            PEND_KIND="$kind"; PEND_N=1
        fi

        if [ "$PEND_N" -ge "$DEBOUNCE" ]; then
            # 连续 DEBOUNCE 点确认切换 -> 归档旧会话, 开新会话
            if [ "$SESS_KIND" != "" ]; then
                flush_session "$SESS_KIND" "$SESS_START" "$SESS_END" "$SESS_N" \
                    "$SESS_SB" "$SESS_MB" "$SESS_SC" "$SESS_MC" "$SESS_SCAP" "$SESS_ECAP"
            fi
            SESS_KIND="$kind"; SESS_START="$ts"; SESS_N=0
            SESS_SB=0; SESS_MB=0; SESS_SC=0; SESS_MC=0
            SESS_SCAP="$bc"
            PEND_KIND=""; PEND_N=0
        fi
    fi

    # 只要当前处于某个有效会话, 就累计数据(含去抖等待期的点)
    if [ "$SESS_KIND" != "" ]; then
        SESS_END="$ts"; SESS_N=$((SESS_N+1))
        # batt: 取绝对值后 /1000 累加(单位 mW), 防 32 位溢出
        ab=$bp; [ "$ab" -lt 0 ] && ab=$((0-ab))
        SESS_SB=$((SESS_SB + ab/1000))
        [ "$ab" -gt "$SESS_MB" ] && SESS_MB="$ab"
        SESS_SC=$((SESS_SC + cp/1000))
        [ "$cp" -gt "$SESS_MC" ] && SESS_MC="$cp"
        SESS_ECAP="$bc"
    fi

    # ---- 裁剪实时缓冲(用自维护计数, 零 fork; 批量裁剪降低 mv 频率) ----
    # 保留余量: 涨到 MAX_LINES+TRIM_SLACK 才裁一次, 减少 tail+mv 频率
    if [ "$LINES" -gt "$TRIM_AT" ]; then
        # 先写临时文件, 再原子 mv(rename 在同一 tmpfs 内是原子的,
        # 读方要么看到旧完整文件, 要么看到新完整文件, 不会读到半截)
        tail -n "$MAX_LINES" "$DATA_FILE" >"$DATA_FILE.tmp" 2>/dev/null &&
            mv -f "$DATA_FILE.tmp" "$DATA_FILE"
        LINES=$MAX_LINES
    fi

    sleep "$INTERVAL"
done