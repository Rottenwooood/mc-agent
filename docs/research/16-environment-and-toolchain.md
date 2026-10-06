# 16 · 环境与工具链 / 可复现运行

> `12` 的 B5。定版本矩阵、仓库脚手架、启动栈、可复位世界与开发/测试循环。日期:2026-10-05。

---

## 0. 本机事实(已探)

| 项 | 值 |
|---|---|
| CPU / 内存 | 16 核 / 14 GiB(可用 ~7 GiB) |
| 磁盘 | /home 175 GiB 可用 |
| Java | OpenJDK **21.0.11**(可编译 target 17;注意 `技术方案.md` 提到构建用 Java 25,本机无 25) |
| Node / npm / pnpm | **24.13.0 / 11.9.0 / 10.30.2** |
| Gradle | **未安装**(用 Fabric 的 **Gradle Wrapper**,无需系统级) |
| git | 2.43.0 |

> 内存偏紧:建议**无头服务器 + prismarine-viewer 出帧**为主;真实有头客户端按需开,不要常驻多开。

---

## 1. 版本矩阵(锁定策略;值待填,**尚无 hash**)

> 本项目的**权威版本决策**在 `../技术方案.md`(已定 **Fabric 1.20.x、只读**),本表须与之一致;
> 标 `TBD` 的必须在下一次提交前锁定为**具体版本号 + 锁文件 + 哈希**,否则**不得声称"已锁定"**。

| 组件 | 目标值 | 锁定机制 | 状态 |
|---|---|---|---|
| Minecraft | **1.20.x**(具体补丁见 `技术方案.md`) | `gradle.properties` | 待填具体补丁号 |
| Fabric Loader | TBD | `gradle.properties` | 待锁定 |
| Fabric API | TBD | `build.gradle` 依赖 | 待锁定 |
| mappings | **Yarn**(version TBD)或 Mojang | `gradle.properties` | 待定 |
| Java(mod) | **17**(按 `技术方案.md`) | toolchain / `gradle.properties` | 已定 |
| 构建 JDK | 本机 **21**(无 25,用 21 构建、target 17) | 文档 | 与现有方案待对齐 |
| Node | 24(或 LTS) | `.nvmrc` + `packageManager` | 待锁定 |
| mineflayer / pathfinder / viewer | TBD(与 MC 版本对应) | `pnpm-lock.yaml` + commit | 待锁定 |
| Gradle | 经 `gradlew`(校验 `distributionSha256Sum`) | wrapper | 待校验 |
| 依赖完整性 | — | `gradle.lockfile` / `pnpm-lock.yaml` / wrapper sha256 | **未建立** |

> **纪律**:只有"具体版本号 + 锁文件 + 哈希校验"三者齐备才算锁定;
> 本文档此前称"全部锁定"是**不成立的**,已改。版本升级=单独任务,先记兼容性。

---

## 2. 仓库脚手架(对齐 `minecraft-layering.md §1`)

```text
项目根/
├── apps/agent/            # Node 主程序:装配、连接、生命周期、MCP server
├── packages/
│   ├── contracts/         # 跨边界语义:谓词/结果/事件/快照 schema(§13/§14)
│   ├── foundation/        # 外部能力入口(bot、mod-http、viewer)
│   ├── world/             # 事实/关系/语义对象(§11)
│   ├── execution/         # 三速度闭环/调度/中断/验证(§15)
│   ├── tasks/             # 组合动作/模板/恢复(§10/§13)
│   ├── knowledge/         # 技能/模板库 + 适用条件 + 统计
│   ├── interfaces/mcp/    # MCP 工具暴露
│   └── adapters/{mineflayer,telemetry,vision}
├── mods/server-observer/  # Fabric Java:只读观测 + 事件 + 标记(§14)
├── scenarios/             # 场景定义、蓝图、配置、可复位世界脚本
├── tests/{semantics,replay,integration}/
├── tools/                 # 启动/构建/测试脚本
└── docs/
```

首版同进程内多包;`mods/` 单独语言/进程。

---

## 3. 启动栈(脚本化)

`tools/` 提供:
- `setup.sh`:装依赖(pnpm)、拉 Fabric 模板、构建 Mod。
- `server-up.sh`:起 Fabric 专用服务器(固定种子、可选 mod)。
- `bot-up.sh`:起 Node 主程序 + Mineflayer bot + MCP server。
- `view-up.sh`(可选):起 prismarine-viewer(浏览器/headless 出帧)。
- `client-up.sh`(可选):起有头客户端观看。
- `reset-world.sh`:按种子重置世界(可复现)。

---

## 4. 可复位世界与 fixtures

- **固定种子** + 干净世界模板;`reset-world.sh` 一键复原。
- 场景 fixture:预置地形/结构/容器/怪物(用于特定任务与扰动)。
- 记录 `server_tick`、Mod `revision`、种子,实验可复现。
- 默认**不暂停服务器**(与 Voyager 不同,见 `09 §15`)。

---

## 5. 开发/测试循环(对齐 `minecraft-layering.md §7`)

| 类型 | 证明 | 工具 |
|---|---|---|
| 语义测试 | 谓词/未知传播/契约求值 | Node 单测(纯函数) |
| 事件回放 | 用录制的事件序列测判定/中断/恢复 | 录制 Mod 事件 → 离线回放 |
| 真实集成 | 协议、控制、Mod、时间对齐 | Fabric 服务器 + bot 端到端 |
| Mod 单测 | 只读接口/事件 | Fabric 自动测试 / gametest |

- **先证明局部闭环**(选少量反馈特征不同的动作),再抽象组合(layering §6)。
- `contracts/` 以一致性测试对齐 Node 与 Java 两侧 schema。

---

## 6. 依赖获取(mappings/依赖)

- Fabric:经 Loom 自动拉依赖与 mappings(需联网)。
- Mineflayer/minecraft-data:pnpm 安装。
- 首次构建需下载 MC/Fabric 依赖(磁盘/网络注意)。

---

## 7. 风险
- 14 GiB 内存:服务器+bot 尚可,叠加真实客户端/多开吃紧 → 视觉优先 headless 出帧。
- 无系统 Gradle:务必用 `gradlew`(模板自带)。
- 版本漂移:全部锁小版本,升级走独立任务。

---

## 8. 待你拍板
1. **版本以 `技术方案.md` 的 1.20.x 为准**(本设计文档此前假设 1.21.1,已改说明)。mappings 用 **Yarn** 还是 Mojang?
2. **构建 JDK**:`技术方案.md` 用 Java 25,本机只有 21 —— 是装 25,还是改用 21 构建 + target 17?
3. 视觉首版就接 prismarine-viewer headless,还是先留接口?
4. 项目根目录 = `/home/c6h4o2/dev/mc-world-mcp`(已确认)?
