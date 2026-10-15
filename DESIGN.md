# Power Monitor — 设计与架构白皮书（DESIGN）

> 版本：v5　｜　平台：Android / KernelSU·ReSukiSU　｜　设备：SM8850（骁龙 8 Elite Gen 5），内核 6.12.69
>
> 本文档面向开发者 / 评审者，描述内部架构、数据契约、关键实现与设计权衡。
> 普通用户请看 [README.md](README.md)。

---

## 1. 定位

一个 **KernelSU / ReSukiSU 内核模块**，在骁龙设备上实时监测**功率、温度、充放电状态**，通过管理器内置 WebUI 展示曲线与统计，并带**持久化会话归档**。

- **技术栈**：POSIX Shell（mksh）+ 原生 HTML/CSS/JS（无框架、无依赖、无二进制）
- **模块体积**：约 36 KB
- **设计目标**：功能完整 + **待机功耗可忽略**（详见 §7）

---

## 2. 目录结构

```
/data/adb/modules/power_monitor/
├── module.prop                     模块元信息（id/name/version=v5）
├── service.sh                      开机自启：等 boot_completed 后拉起 daemon
├── README.md                       用户文档
├── DESIGN.md                       本文档
├── bin/
│   ├── power_daemon.sh             采样守护进程（常驻，~9 KB）
│   └── ctl.sh                      控制接口（按需调用）
└── webroot/
    ├── index.html                  界面骨架 + Canvas
    └── app.js                      前端逻辑（解析、绘图、统计、翻页）
```

**运行时文件**（均在 `/data/local/tmp/`）：

| 文件 | 内容 |
|------|------|
| `power_monitor.dat` | 实时环形缓冲（`MAX_LINES=900`，13 列） |
| `power_monitor_archive.log` | 永久归档（会话，10 列） |
| `power_monitor.lock/pid` | **PID 权威来源**（锁目录） |
| `power_monitor.pid` | PID 对外副本（供 ctl.sh 兼容读取） |

---

## 3. 数据流

```
sysfs (qpt / power_supply / thermal)
        │
        ▼
  power_daemon.sh ──每秒采样──► power_monitor.dat（13列，环形）
        │                              │
        │ 会话状态机                    │
        └──► power_monitor_archive.log（10列，永久）
                                       │
                    ctl.sh {start|stop|status|read|archive|archive-clear|domains}
                                       │
                                       ▼
              WebUI (index.html + app.js)
              每 2 秒调用 ctl.sh → Canvas 绘图 + 统计
```

---

## 4. 数据格式（外部契约）

### 4.1 实时数据（13 列）

```
ts soc cpum cpul gpu nsp batt chg cput gput battT cap st
```

| 列 | 含义 | 来源 | 单位 |
|----|------|------|------|
| ts | 时间戳 | `date +%s%3N` | ms |
| soc/cpum/cpul/gpu/nsp | 5 路 QPT 域功率 | `qpt:*/power_uw` | µW |
| batt | 整机功耗 | battery `current_now`×`voltage_now` | µW |
| chg | 充电功率 | battery `current_now`<0 时的 \|batt\| | µW |
| cput/gput/battT | CPU/GPU/电池温度 | thermal `cpullc-*`/`gpuss-*`/`batt_temp` 取最大 | 0.001℃ |
| cap | 电量 | `battery/capacity` | % |
| st | 状态 | 基于 `battery/current_now` 符号 | 0放电 1充电 |

### 4.2 归档（10 列）

```
kind startTs endTs n avgBatt maxBatt avgChg maxChg startCap endCap
```

> `kind` = `disch` / `chg`；`avgBatt/avgChg` 单位 µW；`n` = 会话采样点数。

### 4.3 关键路径事实

- **QPT 真实路径是 `/sys/class/powercap/qpt:0/...`**，**不是** `qpt:soc`。
  顶层为 `/sys/class/powercap/qpt:0`（含 `power_uw`、`name`），子域为 `qpt:0:N`。
  解析时通过遍历 `qpt:*` 并读 `name` 匹配（`soc`/`cpu-m`/`cpu-l`/`gpu`/`nsp`）。

---

## 5. 关键实现

### 5.1 核心思想：主循环零命令替换

**反面（旧版 v4，每秒 ~300 次 fork）：**
```sh
v=$(cat /sys/class/powercap/qpt:0/power_uw)          # fork+exec cat
m=$(awk -v a="$m" -v b="$v" 'BEGIN{print(a>b)?a:b}') # fork+exec awk
```

**正面（v5，0 fork）：**
```sh
read -r v < "$F" 2>/dev/null     # 内建 read
[ "$v" -gt "$m" ] 2>/dev/null && m=$v   # 内建 test
```

> **铁律**：主循环内**禁止出现任何 `$(...)`** —— 命令替换本身就是一次 fork，哪怕里面是内建命令。

### 5.2 启动时缓存路径

不再每轮遍历 97 个 `thermal_zone`，只在启动时扫一次：

```sh
CPU_ZONES=""; GPU_ZONES=""; BATT_TEMP_FILE=""
for d in /sys/class/thermal/thermal_zone*; do
    t=""; read -r t < "$d/type" 2>/dev/null
    case "$t" in
        cpullc-*) CPU_ZONES="$CPU_ZONES $d/temp" ;;
        gpuss-*)  GPU_ZONES="$GPU_ZONES $d/temp" ;;
        batt_temp|battery) [ -z "$BATT_TEMP_FILE" ] && BATT_TEMP_FILE="$d/temp" ;;
    esac
done
```

### 5.3 32 位溢出规避（关键坑）

**Android mksh 的 `$(( ))` 是 32 位**：`1861000 × 3833000` 直接乘会溢出成负数。

```sh
# µA × µV / 1e6 = µW，改为 (µA/1e3)×(µV/1e3)，数值等价且不溢出
bp=$(( (cur/1000) * (vol/1000) ))
```

会话累加同理（900 点 × ~1e7 会溢出）：
```sh
SESS_SB=$((SESS_SB + ab/1000))    # 累加时缩放到 mW
avgB=$(( SESS_SB / n * 1000 ))    # 归档时还原为 µW
```

### 5.4 主循环骨架

```sh
while :; do
    ts=$(date +%s%3N 2>/dev/null)       # 唯一残留 fork（1次/秒）

    soc=0; [ -n "$QPT_SOC" ] && { read -r soc < "$QPT_SOC" 2>/dev/null; }
    case "$soc" in ''|*[!0-9-]*) soc=0 ;; esac   # 容错：空/非法归零
    # ... 其余数据项

    echo "$ts $soc ... $st" >>"$DATA_FILE"
    LINES=$((LINES+1))                   # 自维护计数，避免 wc -l

    # 会话状态机（见 5.5）

    # 批量裁剪（见 5.6）
    sleep "$INTERVAL"
done
```

### 5.5 会话状态机 + 归档

```sh
kind=""
[ "$st" = "0" ] && kind="disch"
[ "$st" = "1" ] && kind="chg"

if [ -z "$kind" ]; then
    [ "$SESS_KIND" != "" ] && flush_session ...     # 进入"其他" → 结束会话
else
    if [ "$SESS_KIND" != "$kind" ]; then
        [ "$SESS_KIND" != "" ] && flush_session ... # 类型切换 → 归档旧、开新
        SESS_KIND="$kind"; SESS_START="$ts"; ...
    fi
    SESS_N=$((SESS_N+1))
    SESS_SB=$((SESS_SB + ab/1000))
    [ "$ab" -gt "$SESS_MB" ] && SESS_MB="$ab"
fi
```

归档**仅在会话结束时写一次**（非每秒）：
```sh
flush_session() {
    local k="$1" st="$2" et="$3" n="$4" sb="$5" mb="$6" ...
    [ "$n" -lt 2 ] && return            # 少于2点不归档
    local ab=$(( sb / n * 1000 ))       # mW→µW 还原
    echo "$k $st $et $n $ab $mb ..." >>"$ARCHIVE"
}
```

#### 会话去抖（避免单点抖动切碎会话）

状态切换需**连续 `DEBOUNCE` 个采样点一致**才生效：

```sh
DEBOUNCE="${PM_DEBOUNCE:-3}"        # 默认连续 3 点确认

if [ "$kind" = "$SESS_KIND" ]; then
    PEND_KIND=""; PEND_N=0          # 状态未变, 清空候选
else
    if [ "$kind" = "$PEND_KIND" ]; then PEND_N=$((PEND_N+1))
    else PEND_KIND="$kind"; PEND_N=1; fi
    if [ "$PEND_N" -ge "$DEBOUNCE" ]; then   # 连续确认才切换
        flush_session ...; SESS_KIND="$kind"; ...
    fi
fi
```

> 这正是修复"一次充电被切成好几段"的关键。

#### 状态判定：基于电流方向（而非 battery/status）

```sh
# battery/current_now: 正值=放电, 负值=充电
if [ "$cur" -lt 0 ]; then st=1; else st=0; fi
```

**为什么不用 `battery/status`**：该节点在充电时会频繁抖动
（`Charging` ↔ `Not charging` ↔ `Full`），每次抖到非预期值都会切断会话，
导致一段完整充电被拆成多个小段（如 n=2/5/17 的碎片）。

**为什么充电功率不用 `usb/current_now`**：该节点在充电时读数恒为 0，
导致充电功率永远显示 0。改用 `battery/current_now < 0` 时取 `|batt|`：

```sh
bp=$(( (cur/1000) * (vol/1000) ))    # 整机功率, 充正放负
cp=0
[ "$cur" -lt 0 ] && cp=$(( 0 - bp )) # 充电功率 = |batt|
```

### 5.6 批量裁剪（含竞态说明）

```sh
MAX_LINES=900
TRIM_SLACK=300
TRIM_AT=$((MAX_LINES + TRIM_SLACK))     # 涨到 1200 才裁一次，降低 mv 频率

# 主循环内：
if [ "$LINES" -gt "$TRIM_AT" ]; then
    tail -n "$MAX_LINES" "$DATA_FILE" >"$DATA_FILE.tmp" 2>/dev/null &&
        mv -f "$DATA_FILE.tmp" "$DATA_FILE"
    LINES=$MAX_LINES
fi
```

**竞态分析**：`mv` 在同一 tmpfs 内是 `rename(2)`，**原子**。读方（`ctl.sh read`）要么看到旧完整文件、要么看到新完整文件，**不会读到半截**。此外前端对每行做了三重容错（见 §5.8），即使读到空/异常也安全跳过。

### 5.7 优雅停止（保证归档）

`ctl.sh stop` **必须 SIGTERM → 等待 → SIGKILL**，因为 `kill -9` 会让 daemon 的 `trap cleanup` 无法执行，导致会话不归档：

```sh
stop)
    pid=$(get_pid)
    if [ -n "$pid" ]; then
        kill "$pid" 2>/dev/null            # SIGTERM（可捕获）
        i=0
        while kill -0 "$pid" 2>/dev/null && [ $i -lt 15 ]; do
            sleep 0.2; i=$((i+1))
        done
        kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null  # 兜底
    fi
    rm -f "$PID_FILE" "$DATA_FILE.tmp"
    rm -rf "$LOCK_DIR"
    ;;
```

### 5.8 前端容错（app.js）

```js
for (const line of out.split(/\r?\n/)){
    const s = line.trim(); if (!s) continue;       // 跳过空行
    const a = s.split(/\s+/);
    if (a.length < 13) continue;                    // 列数不足
    const nums = a.map(Number);
    if (nums.some(isNaN)) continue;                 // 非数字
    pts.push(nums);
}
```

### 5.9 原子锁 + PID（防重复启动 + 防 /proc 扫描卡死）

```sh
if ! mkdir "$LOCK_DIR" 2>/dev/null; then      # mkdir 原子性
    old=""; read -r old < "$LOCK_DIR/pid" 2>/dev/null
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        exit 0                                 # 已有实例
    fi
    rm -rf "$LOCK_DIR"; mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
# PID 唯一权威来源: $LOCK_DIR/pid; $PID_FILE 为对外副本
printf '%s' "$$" >"$LOCK_DIR/pid"
printf '%s' "$$" >"$PID_FILE"
```

`ctl.sh` 读 PID 时优先取权威来源：
```sh
get_pid() {
    for f in "$LOCK_DIR/pid" "$PID_FILE"; do
        if [ -f "$f" ]; then
            p=""; read -r p < "$f" 2>/dev/null
            [ -n "$p" ] && { echo "$p"; return; }
        fi
    done
}
```

> 早期版本用 `for p in /proc/[0-9]*` 扫描进程，**在进程多的设备上会卡死**，已改为 PID 文件。

---

## 6. 控制接口（ctl.sh）

```sh
sh /data/adb/modules/power_monitor/bin/ctl.sh {start|stop|status|read [n]|archive|archive-clear|domains}
```

| 命令 | 说明 |
|------|------|
| `start` | 启动（已运行则幂等返回） |
| `stop` | 停止（SIGTERM 优雅退出以保证归档） |
| `status` | 输出 `SUPPORTED/RUNNING/POINTS` |
| `read [n]` | 输出最近 n 行（默认 300） |
| `archive` | 输出归档会话 |
| `archive-clear` | 清空归档 |
| `domains` | 列出 QPT 域 |

---

## 7. 性能与功耗（实测）

### 7.1 单点读取代价

| 方式 | 单次耗时 |
|------|---------|
| `$(cat f)` | 8 ms |
| `$(awk max)` | 6 ms |
| **`read -r v < f`** | **<0.1 ms** |
| **shell `[ a -gt b ]`** | **<0.1 ms** |

### 7.2 v4 → v5 对比

| 指标 | v4 旧版 | **v5 新版** | 改善 |
|------|---------|-------------|------|
| 每秒 fork+exec | ~300 | **~1.3** | ↓ ~230× |
| CPU 占用 | 80–150 ms/秒 | **~3 ms/秒（0.3%）** | ↓ ~40× |
| RSS | 4–8 MB | **2.7 MB** | ↓ |
| 额外待机功耗 | +200–450 mW | **+0.2–0.5 mW** | ↓ ~1000× |
| 8h 额外掉电 | 8–18% | **0.05–0.2%** | — |

> 残留 fork 仅为 `date`（每秒 1 次，用于时间戳）。

### 7.3 是否需要用 C 重写？

**结论：不必要。**

- C 相比优化后的 Shell，理论收益仅 **~0.2–0.4 mW**（约 0.19% / 8h），已到"测不出来"量级。
- 代价：数天开发 + NDK 交叉编译 + 每次改动重编译。
- 优化后的 Shell 已能压到 0.3% CPU、1.3 fork/秒，且完全可读可维护。
- 若要再省电，**把 `PM_INTERVAL` 从 1 调到 2** 比上 C 简单划算得多。

### 7.4 关于息屏（重要澄清）

- Android 的自动休眠（AP Suspend）是**在无 Wakelock、无活跃任务时**才进入 Suspend-to-RAM。
- 但常驻进程里的 `sleep 1` 会向内核注册单调时钟定时器（`nanosleep`），**即使息屏，进程仍会每秒唤醒一次**，频繁打断 SoC 的最深低功耗态（Rail-gating）。
- 系统**不会**因为用户息屏就"自动绕过"该脚本——它仍在忠实唤醒。
- 好在 v5 把每秒工作量压到 ~3ms，额外功耗仅 0.2–0.5mW，对 5000+ mAh 电池完全可接受。
- **如需极境待机**：在循环开头判断背光即可无缝挂起（当前未实现，属可选增强）。

---

## 8. 已知约束 / 坑清单

| 项 | 说明 |
|----|------|
| **mksh 32 位算术** | 大数必须缩放（先除后乘） |
| **QPT 真实路径** | `/sys/class/powercap/qpt:0/`，非 `qpt:soc` |
| **主循环禁 `$(...)`** | 命令替换 = fork，会抵消优化 |
| **停止用 SIGTERM** | 否则 trap 不执行、会话不归档 |
| **禁 `/proc` 全量扫描** | 用 PID 文件 + `kill -0` |
| **调试勿用 `timeout` 跑 daemon** | 会被 trap 卡住；用 `nohup`/`setsid &` |
| **调试残留进程会伪装成 bug** | 排查能耗/写入异常前先确认无僵尸实例 |
| **SELinux** | daemon 由 service.sh 拉起，上下文与交互 shell 不同 |

---

## 9. 部署与回滚

- **开机自启**：`service.sh` 等 `sys.boot_completed` 后 `setsid` 拉起 daemon（不阻塞开机）。
- **数据文件在 `/data/local/tmp`**：重启后清空（异常退出时会话可能不归档）。
- **备份**：
  - `/data/local/tmp/power_daemon.sh.bak.*`（旧版时间戳备份）
  - `/storage/emulated/0/脚本/power_daemon.sh.forkstorm-backup`（fork 风暴版备份）
- **回滚**：
  ```sh
  cp <备份> /data/adb/modules/power_monitor/bin/power_daemon.sh
  sh /data/adb/modules/power_monitor/bin/ctl.sh start
  ```

---

## 10. 可调参数

| 参数 | 默认 | 说明 |
|------|------|------|
| `PM_INTERVAL` | 1 | 采样间隔（秒）。调 2 可再减半待机耗电 |
| `MAX_LINES` | 900 | 实时环形缓冲上限（≈15 分钟 @1s） |
| `TRIM_SLACK` | 300 | 裁剪余量，涨到 `MAX_LINES+SLACK` 才裁一次 |

---

## 11. 可选增强方向（未实现）

1. `PM_INTERVAL` 默认调 2 秒
2. 息屏降频 / 暂停（读 `/sys/class/backlight/panel0-backlight/brightness`）
3. 归档导出 CSV
4. `date` → `/proc/uptime`（收益仅 ~0.05mW，不建议）

---

*本文档最后更新：v5 封版。任何对数据格式（§4）或外部契约（§6）的修改，均需同步更新 README 与 WebUI 解析逻辑。*