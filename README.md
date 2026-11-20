# mc-agent

一个 Minecraft agent:**Mineflayer 控制(只做玩家合法动作)+ 自研 Fabric 服务端 Mod 只读特权观测**。
目标:不用视觉(视觉可选、且不进反应回路)、反应快、能力接近人类。

当前状态:**里程碑 0 已打通**——"仅生存模式,砍树取木"端到端验证通过
(程序断言在**服务端权威状态**上判定,输出 `pass/ambiguous/fail`)。

## 目录

```text
mc-agent/
├── env.sh                 # source 后激活 JDK 25(Fabric/Loom 运行需要)
├── mods/mcagent/          # 一个 Fabric Mod,两个环境:
│                          #   main   = 服务端只读观测 HTTP(127.0.0.1:8765)
│                          #   client = 真实客户端本地玩家控制 HTTP(127.0.0.1:8766)
├── packages/              # 框架(后端无关):contracts / world / execution / tasks / knowledge / interfaces/mcp
├── apps/agent/            # 常驻进程(身体 owner)+ MCP 桥
├── tools/                 # server-up/down · reset-world · agent-up/down · launch-client …
└── docs/                  # 设计契约与运行指南
```

## 环境(已配置)

- JDK 25(`~/.local/share/jdk/25`,跑 Gradle/Loom 必需)、JDK 17(`~/.local/share/jdk/17`)。
- `source ./env.sh` 把 `JAVA_HOME` 指向 25。
- 版本:MC **1.20.1** · Loader **0.19.5** · Fabric API **0.92.12+1.20.1** · Loom **1.18.2** · Gradle **9.7.1** · **Mojang 官方映射** · 源码目标 Java 17。
- Gradle 走腾讯镜像;首次构建依赖 `~/.gradle` 缓存。

## 运行

```sh
# 1) 起服务器(带只读观测 Mod),开发用
tools/server-up.sh

# 2) 另一个终端:起常驻 agent(默认 mineflayer 后端)
tools/agent-up.sh --server 127.0.0.1:25565 --user Bot
```

换后端 / 服务器 / 名字:

```sh
tools/agent-up.sh --backend client-mod --user Agent    # 真实客户端本地玩家(需先开客户端)
tools/agent-up.sh --server 10.0.0.5:25566 --user Bot   # 别的服务器
tools/agent-up.sh --help                                # 全部参数
```

停止:

```sh
tools/agent-down.sh    # 停常驻进程(身体)
tools/server-down.sh   # 停 server(优雅退出,会存档)
```

> 完整手动测试流程(起 server → 重置世界 → 起 agent → 测试场景 → OP → 清理)见
> `docs/manual-test-mineflayer.md`。

## 文档

- `docs/mcp-implementation-framework.md` — 实现框架:铁律、契约、动作库、进程形态与累计决策。
- `docs/world-map-and-composition.md` — 感知/地图/编排:表面壳、发现图、句柄与罗盘、有界编排词表。
- `docs/client-controller.md` — 真实客户端控制后端(只替换 `ControlPort`)。
- `docs/running-the-agent.md` — **跑 agent 的三种方式**(自定义 prompt / 一键 benchmark / 交互 session)。
- `docs/manual-test-mineflayer.md` — 手动测试指南(起 server → 重置世界 → 起 agent → 场景 → OP → 清理)。

## 观测 Mod 的 HTTP 接口(只读,`127.0.0.1:8765`)

| 端点 | 说明 |
|---|---|
| `GET /health` | `{ok, tick, mc, event_seq}` |
| `GET /self?player=<name>` | 玩家位置/血量/饥饿/维度等(服务端权威) |
| `GET /block?x&y&z` | 单方块(注册 id,如 `minecraft:mangrove_log`) |
| `GET /blocks?x&y&z&r&limit` | 区域非空气方块(有界) |
| `GET /nearest?player&block&r` | 最近的某类方块 |
| `GET /inventory?player` | 玩家背包(服务端权威,用于断言合成/采集结果) |
| `GET /events?since&max` | 方块变化事件(seq/tick/pos/before/after/actor) |

Mod **只读**,不做任何世界写操作。

## 里程碑 0 的验证结果(真实游戏)

场景"砍 3 个红树林原木"(生存、无 cheat):

```json
RESULT {"intent":"chop_tree","target":"minecraft:mangrove_log","want":3,
 "effect_status":"pass","control_status":"completed","note":"chop ok",
 "evidence":{"dug_count":3,"inventory_count":3,
   "block_checks":[{"pos":[7,83,26],"now":"minecraft:air","ok":true},
                   {"pos":[7,82,26],"now":"minecraft:air","ok":true},
                   {"pos":[5,83,26],"now":"minecraft:air","ok":true}],
   "observer_events":[{"pos":[7,83,26],"tick":2118,"actor":"Bot"},
                      {"pos":[7,82,26],"tick":2178,"actor":"Bot"},
                      {"pos":[5,83,26],"tick":2238,"actor":"Bot"}]}}
```

关键:**判定用的是 Mod 的服务端权威状态**(方块已变 air)+ **事件归因**(actor=Bot),
不是 bot 自己的乐观预测。找不到目标 → `fail`;方块挖掉但没捡到 → `ambiguous`(部分成功)。

### 组合意图:砍树 → 合木板

```sh
node agent/src/scenarios/chop_then_planks.js
```

复用原子意图 `chopTree`,再加合成;判定同样用**服务端权威背包**:

```json
RESULT {"intent":"chop_then_planks","effect_status":"pass","control_status":"completed",
 "evidence":{"server_logs_before":3,"server_logs_after":0,
             "server_planks_after":28,"dug":3}}
```

## 下一步(见 docs)

- 更多意图与组合动作;断言细化(`ambiguous/unobservable` 细分、归因分级);
- 反射/中断;`mineflayer-pathfinder` 作基础移动图 → 后续多层表面图;
- 见 `docs/research/12-gap-register.md`。
