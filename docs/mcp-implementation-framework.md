# Minecraft MCP 实现框架(最终形态)

> 依据:`minecraft-framework.md`(总体机制)、`minecraft-layering.md`(目录/依赖/抽象顺序)。
> 本文把它们**落成具体的包结构、跨边界契约、执行模型、MCP 面与 Mod 契约**,作为实现的唯一依据。
> 与两份上位文档冲突时,以上位文档为准并回改本文。状态:**冻结,待实现**。日期:2026-10-07。

---

## 0. 形态、语言与进程

- 仓库根 = `mc-agent`;业务代码 **TypeScript / Node.js**;服务端 Mod 为 **Java/Fabric**。
- 逻辑分层 ≠ 多服务:首版 world/execution/tasks/knowledge 全在**一个常驻 agent 进程**内。
- 因 MCP 客户端会**按 session 各起一个进程**,正式形态定义为:
  - **常驻 agent 进程**(`apps/agent`):唯一持有 bot、世界客户端、执行、任务、技能库;
  - **薄 MCP 桥**(`packages/interfaces/mcp` 的 stdio 入口):每个 session 一个,只做协议转发,不含执行逻辑。
  - 依据 `layering §8`「需要客户端退出后持续运行 → 程序装配与进程通信」。
- **不预建空目录/空壳**:每层只在实际写其中内容时创建;不写占位实现。

## 1. 目录(最终)

```text
mc-agent/
├── apps/agent/                     # 唯一装配入口:配置、连接、生命周期、启动常驻进程与 MCP 桥
├── packages/
│   ├── contracts/                  # 跨边界类型与端口接口(无实现、无第三方依赖)
│   ├── foundation/                 # 端口的最小公共设施:clock、id、结果基元、能力注册
│   ├── world/                      # 事实归一、稳定对象引用、按需关系、语义对象、查询
│   ├── execution/                  # 控制令牌、L1 持续监测、局部闭环、可行性、证据验证、退出/中断
│   ├── tasks/                      # 目标解释、子目标依赖、预算传播、进度、目标条件化重展开与恢复
│   ├── knowledge/                  # 可复用方法(参数/适用条件/失败策略/版本/记录)与晋升
│   ├── interfaces/mcp/             # 工具 schema、参数校验、结果呈现、动态注册与 list_changed;含 stdio 桥
│   └── adapters/
│       ├── mineflayer/             # 控制实现(ControlPort):Mineflayer + pathfinder + 版本差异
│       ├── telemetry/             # 观测实现(WorldPort 的权威来源):观测 Mod 的 HTTP 客户端
│       └── vision/                 # 可选画面来源(prismarine-viewer)
├── mods/server-observer/           # Java/Fabric 只读观测 + 区域标记(现 mc-mod 迁入)
├── scenarios/                      # 场景数据:人工区域、示例蓝图、配置
├── tests/{semantics,replay,integration}/
├── tools/                          # 开发/启动/测试辅助脚本
└── docs/
```

## 2. 依赖方向(强制,`layering §5`)

```text
contracts  ←  foundation  ←  world / execution  ←  tasks / knowledge  ←  interfaces/mcp  ←  apps/agent
                                   ▲
                        adapters/* 实现 foundation 的端口
```

- `contracts` 不依赖 Mineflayer/Fabric/MCP/任何任务实现。
- `world`、`execution` 不 import 具体后端;`execution` 查 `world`,`world` 不调控制器。
- `tasks` 通过 `world` 查条件、通过 `execution` 推进行为;`execution` 不反向调高层。
- `adapters` 实现端口,可在适配处标注来源;不得在适配里偷偷加目标或副作用。
- `interfaces/mcp` 只做边界校验与呈现,**不写执行逻辑**。
- `apps/agent` 只装配与生命周期,业务模块不各自建连接。

## 3. 契约(packages/contracts,冻结)

### 3.1 事实与证据(来源/时间/覆盖/未知)
```ts
type Source = 'authoritative' | 'observed' | 'predicted' | 'inferred';
interface Fact<T> { value: T; source: Source; observedTick: number; coverage: Coverage; }  // 过期/越界 → Unknown
type Coverage = { loaded: boolean; truncated: boolean; box?: BBox };
```

### 3.2 谓词(断言核心)
```ts
interface Predicate { subject: string; predicate: string; value?: unknown;
  scope?: Scope; notBeforeTick?: number; minConfidence?: number; attribution?: 'self' | 'any'; }
// 三值求值:true | false | unknown(Kleene);unknown 不得当 false → effect_status=unobservable
```

### 3.3 ActionResult(冻结字段,`13 §3`)
```ts
interface ActionResult {
  effectStatus: 'pass'|'fail'|'ambiguous'|'unobservable';
  controlStatus: 'completed'|'blocked'|'interrupted'|'needs_replan'|'cancelled'|'uncertain';
  reason: 'precondition_failed'|'effect_not_observed'|'insufficient_evidence'|'attribution_uncertain'|'timeout'|'policy_blocked'|null;
  effects: EffectDiff[];
  evidence: { claim: string; source: Source; tick?: number }[];
  attribution: 'self_confirmed'|'self_temporal'|'foreign'|'unattributed'|'unknown';
  diff?: NeighborhoodDiff | null;
  resources?: ResourceDelta | null;
  timing?: { startedTick?: number; endedTick?: number; elapsedMs: number } | null;
  control: 'returned';
  subResults?: ActionResult[];
}
```

### 3.4 动作契约(ActionContract)
```ts
interface ActionContract {
  name: string; params: JsonSchema; description: string;
  preconditions: Predicate[]; verificationMode: 'state_effect'|'observation'|'task_terminal'|'continuous';
  postconditions: Predicate[];              // state_effect 必填,调用者只能加不能删
  invariants: Predicate[];                  // 持续
  effectClass: 'read'|'idempotent'|'consumable'|'irreversible';
  interruptible: { prepare: boolean; execute: boolean; settle: boolean };
  safeStop: 'none'|'release_control'|'finish_landing'|'recall';
  timeoutTicks: number; causalScope: Scope; retryPolicy: 'no'|'safe_once'; repairHint: string[];
}
```

### 3.5 方法与任务
```ts
interface Method { id: string; version: number; params: Record<string, JsonSchema>;
  preconditions: Predicate[]; postconditions: Predicate[]; invariants: Predicate[];
  steps: Step[]; failurePolicy: { retry: 'safe_only'; repair: 'local_step'; onFail: 'hand_back' };
  stats: { success: number; fail: number; lastStatus: string|null; lastAt: string|null };
  status: 'draft'|'verified'|'broken'|'deprecated'; provenance: { source: 'human'|'llm'|'adaptation'; created: string; note?: string }; }
interface TaskSpec { goal: Predicate[]; scope: Scope; budget: Budget; stopConditions: Predicate[]; }
```

### 3.6 端口(adapters 实现)
```ts
interface ControlPort { /* 玩家合法控制:move/look/dig/place/use/equip/... 全部返回原始回执,不算成功 */ }
interface WorldPort { health(): Promise<Fact<...>>; snapshot(box): Promise<Fact<Block[]>>; events(cursor): Promise<EventPage>; }
interface VisionPort { frame(): Promise<Frame>; }
```

## 4. world 层
- 把适配器输入归一为 `Fact`:标注 `source/observedTick/coverage`;越界/未加载/失去跟踪 → `Unknown`,不得当「没有」。
- **稳定对象引用**:`WorldObjectRef` 携带 维度+会话+版本;失效后求值 → unknown。
- **按需关系**(任务区展开,依赖失效):`standable/reachable/lineOfSight/support/hazardous`。
- **语义对象 L2**(供模型引用,不给坐标):`tree/ore_vein/container/workstation/frontier/building`,带来源与置信。
- 对外只回**紧凑摘要 / 按需查询结果 / 断言证据**;体素网格不外泄。

## 5. execution 层(三速闭环)
- **控制令牌**:单 body 独占;优先级 `P0 反射/生存 > P1 任务 > P2 子任务 > P3 空闲`。
- **L1 反射/安全包络**(tick 级,可抢占):持续不变量(安全/进展/终止)+ 预测式可行性拦截。
- **L2 执行器**:每步 `前置检查 → 可行性(shielding) → 取令牌 → 派发 → 证据验证 → 状态 → 修复阶梯`。
  修复阶梯:`idempotent 安全重试 → 重定位目标 → 交还`;超时**先核对实际效果再决定重试**;非幂等不自动重放。
- **动作阶段**(`prepare/execute/settle`)各自声明可中断性;抢占只在可中断点;`safe_stop` 后需**确认控制释放**,超时未确认 → `control_uncertain`。
- 验证一律用 `world` 证据(服务端真值),禁止用「我执行完了」的内部标记。

## 6. tasks / knowledge 层
- **tasks**:目标解释为可检查条件;子目标依赖 + **预算传播**;进度=已满足子目标/已产生效果/未解条件,不用「第几步」。
- **目标条件化**:进入方法时重核前置与仍成立的子目标,只补缺失部分;**禁止字面重放**;结束做**整体后置**。
- **knowledge**:方法库=唯一真相源;带版本/适用条件/验证记录;`draft→verified→broken/deprecated`;在**充分验证后**才被当稳定能力晋升。

## 7. interfaces/mcp 面
- **命名/分组**:感知(/观察/关系/状态/证据)、意图动作(名字级)、任务、技能、元工具。
- **结果**:一律 `ActionResult`;模型只看到 `effect_status/control_status/reason/evidence` 摘要,细节可展开。
- **抽象层级(已定 `10 §8` / `11 §9`)**:模型面向**意图/名字/对象引用**;坐标原语**下沉为内部能力**(execution 内部),不作为模型主接口;保留坐标作为**显式逃生**能力并标注。
- **动态与生成**:技能库为源;`run_skill` + `list_skills`;高频/高成功率且参数与断言稳定者在启动时**晋升为一等工具**;`define_skill`(声明式组合生成工具)与模块加载器;**变更发 `tools/list_changed`**。
- `interfaces/mcp` 不实现执行;执行由常驻进程的 tasks/execution 完成。

## 8. mods/server-observer 契约(只读)
- `GET /health` → `{ok, server_tick, mc, mod_version}`
- `POST /snapshot` → 单 tick 原子读,带 `snapshot_seq`、`coverage{loaded,truncated,boxes}`、每事实 `obs_seq/observed_tick`
- `GET /events?since=<{epoch,seq}>` → `{cursor, has_more, reset_required?, events[]}`;环形缓冲溢出→`reset_required`
- `GET/POST /markers`(SavedData)
- `isLoaded=false` → 调用方按 `unknown` 处理
- 只读;HTTP 仅本地/内网 + token。

## 9. 装配与进程
- `apps/agent`:读配置 → 建 adapters → 建 world/execution/tasks/knowledge → 起常驻进程(唯一 bot)→ 起 MCP 桥(一个 socket / 每 session 一桥)。
- 断线/崩溃/重连后**先核对效果,不自动重放**;主进程退出后不承诺 bot 自主运行(除非显式设计 continue-after-exit)。

## 10. 测试(`tests/`)
- `semantics`:条件逻辑、三值/未知传播、范围约束、目标判定。
- `replay`:基于录制事件的失效传播、中断、恢复判定。
- `integration`:真实游戏端到端(协议、预测、控制、服务端事件、画面)。

## 11. 迁移与 git
- **现有 `agent/src/runtime/*`、`hub`、`mcp`、`plugins`、`skills.json`、`tools/mcp-smoke.mjs` 为原型,按本文重建时删除**,可复用逻辑(observer 客户端、谓词求值、diff)迁入对应 `packages/*` 后重写,不留旧结构。
- `mc-mod/` → `mods/server-observer/`(`git mv`)。
- `agent/` → `apps/agent/`(TS)。
- 提交粒度:框架(本文件)→ contracts → adapters+foundation → world → execution → tasks/knowledge → interfaces/mcp+apps → tests。**每次提交可编译/可运行**,不提交半成品。

## 12. 未定项(需拍板,不拍不进入相关层)
1. 主动区半径默认(32³/48³/64³)。
2. 首版语义对象 kind 集合。
3. 视觉兜底首版是否接入。
4. 晋升阈值(使用次数/成功率/稳定性)。
5. 隐藏坐标原语的开关默认值。
