# Power Monitor

骁龙设备的实时 **功率 + 温度 + 充放电** 监测模块，带 ReSukiSU / KernelSU WebUI。

> 开发/评审请看 [DESIGN.md](DESIGN.md)（架构白皮书）。

---

## 功能

- 📈 **实时曲线**（双 Y 轴）
  - 左轴功率：soc / cpu-m / cpu-l / gpu / nsp / 整机功耗 / 充电功率
  - 右轴温度：CPU / GPU / 电池
- 🔋 **放电统计栏**：起始时间、持续时间、平均/峰值功率
- 🔌 **充电统计栏**：同上
- 🗂️ **持久化归档**：会话记录永久保留，可翻页查看
- 🕐 横轴时间轴，曲线可单独显隐

---

## 使用

打开 **ReSukiSU / KernelSU 管理器 → 模块 → Power Monitor → 打开 WebUI** 即可。

数据每秒采样，界面每 2 秒刷新，实时缓冲约 15 分钟（900 点），更早的会话自动归档。

### 命令行（可选）

```sh
CTL=/data/adb/modules/power_monitor/bin/ctl.sh
sh $CTL status          # 查看状态
sh $CTL start           # 启动
sh $CTL stop            # 停止（会归档当前会话）
sh $CTL read 300        # 查看最近 300 条原始数据
sh $CTL archive         # 查看归档会话
sh $CTL archive-clear   # 清空归档
sh $CTL domains         # 列出 QPT 电源域
```

---

## 安装

### 方式一：直接用模块 zip

管理器 → 模块 → 从本地安装 → 选择 `power_monitor_v5.1.zip` → 重启。

### 方式二：从本仓库打包

仓库内容就是模块根目录，用 `build.sh` 打成可刷入的 zip：

```sh
sh build.sh          # 产物在 dist/power_monitor_v5.1.zip
sh build.sh out      # 也可指定输出目录
```

---

## 目录结构

```
power_monitor/
├── module.prop             模块元信息（id / name / version）
├── service.sh              开机自启：等 boot_completed 后拉起 daemon
├── README.md               用户文档（本文）
├── DESIGN.md               架构白皮书（数据契约 / 功耗优化 / 权衡）
├── build.sh                打包脚本
├── bin/
│   ├── power_daemon.sh     采样守护进程（常驻）
│   └── ctl.sh              控制接口（按需调用）
├── webroot/
│   ├── index.html          WebUI 骨架 + Canvas
│   └── app.js              前端逻辑（解析 / 绘图 / 统计 / 翻页）
└── META-INF/               模块安装脚本
```

---

## 开机自启

模块通过 `service.sh` 在开机完成后自动拉起守护进程，无需手动操作。

---

## 要求

- 设备 / 内核支持 **QPT 电源遥测**（`/sys/class/powercap/qpt*`）
  - 骁龙 8 Elite Gen 5 等较新平台通常支持
- KernelSU / ReSukiSU（支持模块 WebUI）

---

## 说明

- 采样间隔默认 1 秒，可用环境变量 `PM_INTERVAL` 调整（如 `PM_INTERVAL=2`）
- 待机额外功耗仅 **约 0.2–0.5 mW**（已做充分优化）
- 数据文件在 `/data/local/tmp/`，重启后清空

---

## 已知问题

- 设备/内核不支持 QPT 时，WebUI 显示「设备不支持」

---

## 许可

[MIT](LICENSE) © 2026 DGGK2333

> 免责声明：修改内核 / 电源相关节点存在风险，请在理解原理后自行评估，作者不对设备损坏负责。

