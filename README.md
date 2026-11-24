# mc-agent

**An embodied Minecraft agent whose every action is judged on server-authoritative evidence.**

A real LLM drives a player-legal body over MCP. A server-side read-only Fabric mod supplies
authoritative world facts. Each action declares its own postcondition and is judged by a program
(not by the model) against a causal-neighbourhood diff. Actions compose through a bounded,
declarative vocabulary instead of generated code, and compositions that survive real use are
promoted to versioned, gated *secondary actions*.

一个 Minecraft 具身智能体：**Mineflayer 协议客户端（或真实客户端里的本地玩家）当身体，自研 Fabric 服务端只读 Mod 当权威感知**。动作预声明后置条件，由程序按服务端证据判定；组合用有界词表而非任意代码；好用的组合沉淀为带版本与在线门禁的二级动作。

> 研究原型，不是生产系统。能力边界与已知缺陷见 [§7](#7-状态与限制)。

---

## 1. 它解决什么问题

LLM 在游戏里最常见的失败不是"不会规划"，而是**误报成功**：工具返回了、动作发出去了，世界其实没变。
本项目把"动作有没有生效"从模型手里拿走，交给一个基于服务端真值的判定层：

| 命题 | 做法 |
|---|---|
| 证据优先 | 判定读服务端权威状态；客户端只读只作补充，并标记 `observed` |
| 三态 + 两级别 | `pass / fail / ambiguous / unobservable`，外加 `no_op`（已满足且没变化，**不算成功**） |
| `pass ⇒ changed` | 写类动作判 `pass` 时，因果邻域必须真的变了；空真后置会被降级为 `no_op` |
| 不静默 | 每次工具返回都附带自上次以来的世界变化（`changes`），含事件与背包差 |
| 可归因 | 事件带 `actor`；判定保留 `attribution` 轴（当前实现仍是时间归因，见 §7） |

---

## 2. 架构

```
[LLM / MCP client]
   │ stdio (JSON-RPC)
   ▼
[thin bridge]  one per session, reconnects on demand
   │ Unix socket, newline-delimited JSON
   ▼
[resident]  single body owner: world client + executor + tool registry
   ├── ControlPort ──► mineflayer bot ──► [Minecraft server]
   │                └► client-mod HTTP :8766 ──► [real Fabric client, local player]
   └── WorldPort   ◄── HTTP :8765 ── [read-only observer mod] ◄── reads ── [server]
```

| 层 | 包 | 职责 |
|---|---|---|
| L0 具身 | `packages/adapters/*`, `packages/world` | 端口实现、世界查询、表面壳、发现图 |
| L1 反射 | `packages/execution/src/reflex.ts` | 动作前拦截 + 执行期监视（唯一能拦截的一层） |
| L2 原子 | `packages/execution/src/actions` | 43 个原子动作 |
| L3 契约 | `packages/execution/src/contract` | 因果邻域签名、diff、对账、判定 |
| L4 组合/知识 | `packages/tasks`, `packages/knowledge` | `run_method`、二级动作库、skill 文本 |
| L5 评测 | `tests/eval`, `tools` | 独立验收、指标、消融 |

依赖方向：`contracts ← foundation ← world/execution ← tasks/knowledge ← interfaces/mcp ← apps/agent`。
`adapters/*` 只实现 `contracts` 的端口；换控制/观测后端时上层零改动。

---

## 3. 快速开始

**要求**：Node.js ≥ 24、pnpm 10、JDK 25（Gradle/Loom 运行需要）、Minecraft 1.20.1 + Fabric。

```sh
pnpm install
pnpm build
pnpm test          # 语义测试；integration 需要真实服务器，默认跳过
```

起开发服务器（Fabric dev server + 观测 Mod，HTTP `127.0.0.1:8765`）：

```sh
tools/server-up.sh
```

起 agent（常驻进程，Unix socket `/tmp/opencode/mc-agent.sock`）：

```sh
tools/agent-up.sh --server 127.0.0.1:25565 --user Bot
```

把 MCP 桥接到你的客户端（以 OpenCode 为例）：

```json
{
  "mcp": {
    "mc-agent": {
      "command": ["node", "<path-to-repo>/apps/agent/dist/main-bridge.js"],
      "enabled": true
    }
  }
}
```

桥连不上 socket 时会自动拉起 resident；多个会话共享同一个身体。

**换真实客户端后端**（需要已安装 Fabric 1.20.1 客户端与对应 launcher profile）：

```sh
MCAGENT_PROFILE="<launcher>/profiles/1.20.1-Fabric 0.19.5" tools/client-up.sh
tools/agent-up.sh --backend client-mod --user Agent
```

常用环境变量：`MCAGENT_OBSERVER`、`MCAGENT_CONTROL=mineflayer|client-mod`、`MCAGENT_CONTROL_URL`、
`MCAGENT_SOCK`、`MCAGENT_ACTIONS`、`MCAGENT_SKILLS`、`MCAGENT_REFLEX=0`。

---

## 4. 工具面

LLM 实际看到 **53 个静态工具**；种子库再注册 2 个 active 二级动作，运行时共 **55 个**。

- **43 个原子动作**：感知 15、移动 6、方块 2、实体 3、背包 6、容器/生产 7、元 4。
  核心方块原语是 `set_block`（两状态替换：已是 B 跳过；air→放置；非 air→破坏后放置；B=air→破坏）。
- **`run_method`**：有界组合执行器。控制步 `sequence / for_each / repeat / branch`；
  集合 `members / surface / nearest / area / component / region / box_cells / set_difference /
  inventory / container / entities`；`validate:true` 只做静态校验。
- **二级动作**：`define_action / list_actions / try_action / activate_action / rollback_action / retire_action`。
  `draft → active → superseded / broken / retired`；门禁只看真实使用（uses ≥ 3、pass ≥ 0.6、
  最近 5 次 ≥ 0.6、net regressions ≤ repairs）；回归或连续失败自动标 `rollbackRequired`。
- **skill 文本**：`write_skill / list_skills / read_skill`，不可调用，按需注入。

地址模型：**对象句柄 + 罗盘方位**为主，坐标是次要逃生口。

```
obj:<kind>:<label>:<x>,<y>,<z>      # block | interactable | entity | liquid
ent:<entityId>
```

---

## 5. 观测 Mod

`mods/mcagent` 一个 jar 两个源集：

| 源集 | 作用 | 端口 |
|---|---|---|
| `main` | 服务端只读观测，**从不写世界** | `127.0.0.1:8765` |
| `client` | 真实客户端本地玩家控制（原版输入/菜单） | `127.0.0.1:8766` |

服务端接口：

| 端点 | 内容 |
|---|---|
| `GET /health` | tick、事件纪元、最新事件号 |
| `POST /snapshot` | 单 tick 原子快照：self / blocks / entities / inventory + `coverage` |
| `GET /events` | `(epoch, seq)` 游标、`reset_required`、`before→after`、`actor` |
| `GET /tags` | 服务端官方方块/实体标签表 |

未加载或截断 → 显式 `unknown`，绝不当作"空"。

---

## 6. 评测

```sh
tools/bench.sh                                   # T1,T3 × scenarios/seeds.txt
tools/bench.sh --tasks T1,T3 --seeds 5001,5002
```

每个 case：**硬种子重置世界 → 起 resident → 假玩家放 fixture → headless LLM（只给自然语言目标）
→ 独立验收器直读观测 Mod → 落盘 episode**。runner 不写死步骤、不判定成功。

指标：完成率、**误报成功率**、非 pass 三分（`confirmed_fail` / `insufficient_evidence` / `blocked`）、
二级动作污染率、repair/regression、安全停止延迟、成本。

当前结果：最小 GF（T1+T3 × 5001/5002）= **2/4**；装置完整，T2/T4 与消融链待补。
另外，S1 实机测试"从零获取钻石"在服务端权威证据下通过（背包 2 钻石 + 4 条 `actor=Bot` 的钻石矿破坏事件）。

---

## 7. 状态与限制

**已实现**：43 原子动作、有界组合（含背包/容器/实体域与层级组合）、二级动作库与在线门禁、
skill 文本、动态工具与 `tools/list_changed`、双控制后端、观测 Mod 四端点、benchmark 装置。

**未实现 / 已知限制**：

- 建造族（`place_line` / `clear_area` / `bridge` / `pillar_up` / `build_blueprint`）只有设计，没有实现。
- `failurePolicy` / `repairHint` / `retryPolicy` 只是声明，执行器未使用 → **没有局部修复**。
- `attribution` 目前恒为 `self_temporal`：区分"我造成 / 他人造成 / 未观测"还没落到判定。
- `no_op` 在二级动作门禁里被记成 `unknown`，幂等技能会被低估。
- `signature.changed` 包含 HP/饥饿差，极端情况下可被"被怪打了一下"满足 → 空真 pass 的一个入口。
- `enchant` 仍不稳定（offers 有时不到达）；`run_command` 是控制类，不判定效果。
- 评测只有 T1/T3 两个任务族，样本量小。

这些是公开的已知问题，不是"待办清单的装饰"；欢迎 issue / PR。

---

## 8. 仓库结构

```
apps/agent/           装配、resident、薄 MCP 桥、线协议
packages/contracts/   冻结类型：Fact / Predicate / Target / ActionResult / Contract / Method / Ports
packages/foundation/  http、errors、config
packages/world/       World、SurfaceShell、DiscoveryGraph、对象聚合、通用查询
packages/execution/   ControlToken、ReflexShield、契约引擎、43 个原子动作
packages/tasks/       run_method、SetExpr、谓词、参数绑定、try_action
packages/knowledge/   二级动作库、skill 文本库
packages/interfaces/mcp/  ToolRegistry、buildTools、动态工具
packages/adapters/    telemetry（WorldPort）、mineflayer / client-mod（ControlPort）
mods/mcagent/         Fabric Mod：只读观测 + 客户端本地玩家控制
scenarios/            任务（T1/T3）、动作/技能种子、固定种子
tests/                语义测试、integration smoke、评测运行器与独立验收器
tools/                server / agent / client / reset-world / bench / setup-bot / view
docs/                 设计契约与运行指南
```

---

## 9. 文档

- [`docs/mcp-implementation-framework.md`](docs/mcp-implementation-framework.md) — 铁律、契约、动作库、进程形态
- [`docs/world-map-and-composition.md`](docs/world-map-and-composition.md) — 感知、地图、地址模型、有界编排
- [`docs/client-controller.md`](docs/client-controller.md) — 真实客户端控制后端
- [`docs/running-the-agent.md`](docs/running-the-agent.md) — 三种运行方式
- [`docs/manual-test-mineflayer.md`](docs/manual-test-mineflayer.md) — 手动测试流程

---

## 10. 许可证与第三方

代码以 **MIT** 发布，见 [`LICENSE`](LICENSE)。

第三方：Fabric API（Apache-2.0）、Gradle Wrapper（Apache-2.0）、
Mineflayer / minecraft-data / mineflayer-pathfinder（MIT）。
仓库**不包含**任何 Minecraft 游戏资源；Minecraft 是 Mojang / Microsoft 的商标，
本项目的 Mod 仅用于开发与研究。
