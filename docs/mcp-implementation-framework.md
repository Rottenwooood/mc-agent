# Minecraft MCP 实现框架(最终形态)

> **依据优先级(高→低)**:`docs/research/07/15/13/11/14/04/06/02/16/17` → `minecraft-framework.md`(旧,机制总纲) → `minecraft-layering.md`(旧,包结构沿用)。
> 冲突以研究文档为准。状态:**冻结,待实现**。日期:2026-10-07。**本轮已定决策见 §15。**

---

## 0. 形态、语言、进程、视觉

- 仓库根 = `mc-agent`;业务 **TypeScript / Node.js**(pnpm 锁);Mod 为 **Java/Fabric**。
- **进程(已定):常驻 agent 进程 + 薄 MCP 桥,两边尽量解耦。**
  - 常驻进程(`apps/agent`):唯一持有 bot / 世界客户端 / 执行 / 任务 / 技能库;
  - 薄桥(stdio,每会话一个):只做协议转发,可独立重启/扩展,不含执行逻辑;
  - 理由:MCP 客户端按 session 各起进程,若各自开 bot 会互相顶号(已实测 `duplicate_login`)。
- **视觉接缝(设计期就留)**:`adapters/vision` 从第一天是**正式接口**,框架**不得假设"纯文本"**;
  预留"视觉信息占很大比重"的模式(规划可见信息可含画面)。首版不实现,但数据结构与工具面按可插拔视觉设计。
- **可视化(本轮新增要求)**:用于**本地调试**与**后续导出宣传素材**,属正式设计部分,见 §13。

## 1. 概念栈(研究 07)↔ 包

| 层 | 职责 | 对应包 |
|---|---|---|
| **L0 具身适配** | 玩家协议控制 + Fabric 只读观测;证据分级;对象引用版本化;未加载/失去跟踪→unknown | `adapters/*` + `world`(事实归一) |
| **L1 Reflex / Shield** | 高频、无 LLM;**唯一能"拦截"**的一层:实体威胁 + 自身状态的安全包络 | `execution`(reflex) |
| **L2 Primitive** | 可中断、效果可解释;底层判据不可删;副作用分类 | `execution`(primitives) |
| **L3 Contract Engine** | 点后置判定代数 + 因果邻域签名 diff + 连续不变量 + 终止后置 | `execution`(contract) + `contracts` |
| **L4 Skill Layer** | 低熵→冻结模板(目标条件化);高熵→进化技能(同契约当适应度);干预式 net-effect;防污染 | `knowledge` + `tasks` |
| **L5 Meta / Eval** | 课程、晋升/退役、实机 benchmark 与评测 | `tasks` + `tests/eval` |

## 2. 目录(沿用 `16 §2` / `layering §1`)

```text
mc-agent/
├── apps/agent/                     # 装配:配置、连接、生命周期、常驻进程 + MCP 桥
├── packages/
│   ├── contracts/  foundation/  world/  execution/  tasks/  knowledge/
│   ├── interfaces/mcp/
│   └── adapters/{mineflayer,telemetry,vision}
├── mods/server-observer/           # Java/Fabric 只读观测 + 事件 + 标记
├── scenarios/                      # 任务定义、fixture、蓝图、种子清单
├── tests/{semantics,replay,integration,eval}/
├── tools/                          # 启动/构建/测试/可视化脚本
└── docs/
```

## 3. 依赖方向(强制)

```text
contracts ← foundation ← world / execution ← tasks / knowledge ← interfaces/mcp ← apps/agent
                              ▲
                   adapters/* 实现 foundation 的端口
```

`contracts` 不依赖 Mineflayer/Fabric/MCP/任务实现;`world`/`execution` 不 import 具体后端;`tasks` 经 `world` 查条件、经 `execution` 推进;`interfaces/mcp` 不写执行逻辑。

## 4. 契约(`packages/contracts`)

### 4.1 事实来源 + 动作证据等级(两条正交轴,`14 §5` + `07 L0`)
```ts
type Source = 'authoritative' | 'observed' | 'predicted' | 'inferred';   // 事实来源
type EvidenceLevel = 'sent' | 'predicted' | 'observed' | 'attributed';    // 动作效果强度
interface Fact<T> { value: T; source: Source; observedTick: number; coverage: Coverage; }
```
`sent`/`predicted` 不作为 pass 依据;越界/未加载/过期 → `Unknown`。

### 4.2 谓词与三值(`13 §1`,`04 §3`)
```ts
interface Predicate { subject: string; predicate: string; value?: unknown;
  scope?: Scope; notBeforeTick?: number; minConfidence?: number; attribution?: 'self' | 'any'; }
```
- true|false|unknown(Kleene);unknown 不得当 false → `unobservable`。
- **安全编译边界**:LLM 只能从受控词表选/参数化;安全不变量**白名单强制存在,LLM 不可删除/放宽**。

### 4.3 ActionResult(冻结,`13 §3`)
```ts
interface ActionResult {
  effectStatus: 'pass'|'fail'|'ambiguous'|'unobservable';
  controlStatus: 'completed'|'blocked'|'interrupted'|'needs_replan'|'cancelled'|'uncertain';
  reason: 'precondition_failed'|'effect_not_observed'|'insufficient_evidence'|'attribution_uncertain'|'timeout'|'policy_blocked'|null;
  effects: EffectDiff[]; evidence: { claim: string; source: Source; level?: EvidenceLevel; tick?: number }[];
  attribution: 'self_confirmed'|'self_temporal'|'foreign'|'unattributed'|'unknown';  // 首版≤self_temporal(14§3)
  diff?: NeighborhoodDiff | null;  resources?: ResourceDelta | null;
  timing?: { startedTick?: number; endedTick?: number; elapsedMs: number } | null;
  control: 'returned';  subResults?: ActionResult[];
}
```

### 4.4 ActionContract(`13 §2`)
```ts
interface ActionContract { name: string; params: JsonSchema; description: string;
  preconditions: Predicate[]; verificationMode: 'state_effect'|'observation'|'task_terminal'|'continuous';
  postconditions: Predicate[]; invariants: Predicate[];
  effectClass: 'read'|'idempotent'|'consumable'|'irreversible';
  interruptible: { prepare: boolean; execute: boolean; settle: boolean };
  safeStop: 'none'|'release_control'|'finish_landing'|'recall';
  timeoutTicks: number; causalScope: Scope; retryPolicy: 'no'|'safe_once'; repairHint: string[]; }
```

### 4.5 Method / Skill(`13 §5` + `07 L4` + `02`)
```ts
interface Method { id: string; version: number; params: Record<string, JsonSchema>;
  preconditions: Predicate[]; postconditions: Predicate[]; invariants: Predicate[];
  steps: Step[];                          // 目标条件化:绑定在准备时完成
  failurePolicy: { retry:'safe_only'; repair:'local_step'; onFail:'hand_back' };
  stats: { success:number; fail:number; lastStatus:string|null; lastAt:string|null };
  status: 'draft'|'verified'|'broken'|'deprecated';
  validation?: { seeds: string[]; interventions?: { with:number; without:number } };
  provenance: { source:'human'|'llm'|'adaptation'; created:string; note?:string }; }
```

### 4.6 TaskSpec 与能力分级
```ts
interface TaskSpec { goal: Predicate[]; scope: Scope; budget: Budget; stopConditions: Predicate[]; }
// 能力分级(07 §2 / 11 §6.3):每条能力标注 规划可见 / 验证可见 / 动作权限
```

### 4.7 端口
```ts
interface ControlPort { /* 玩家合法动作,返回原始回执,不判成功 */ }
interface WorldPort { status(): Promise<Fact<SelfState>>; entities(): Promise<Fact<Entity[]>>;
  query(box): Promise<Fact<Block[]>>; events(cursor): Promise<EventPage>; }   // 全部按需
interface VisionPort { frame(): Promise<Frame>; }
```

## 5. world:按需感知(已定:不维护主动区体素缓存)

- **不做主动区体素缓存**。世界事实**按需、有界**查询;越界/未加载/失去跟踪 → `Unknown`。
- **移动/避障**交给 `mineflayer-pathfinder`:先为基础移动图,**后续升级多层表面图**(`11§9`);我们**不维护方块几何**做避障。
- **安全**只看**实体威胁 + 自身状态**(hp/food/位置/on-ground/坠落);不做体素邻域安全判断(岩浆/坠落交由移动图 `maxDropDown` 等约束)。
- **语义对象**(已定要做):tree / ore_vein / container / workstation / frontier …;带来源与置信;模型以 **id** 引用。
- 关系(standable/reachable/lineOfSight)按需计算、随相关事实失效。
- **坐标**:仅作为**读取信息的一部分**,或由单独"读坐标"工具返回;**不作为动作参数**暴露给模型(见 §9)。

## 6. execution(L1 + L2 + L3)

- **控制令牌**:单 body 独占;优先级 `P0 反射/生存 > P1 任务 > P2 子任务 > P3 空闲`。
- **L1 Reflex/Shield**:实体威胁(结合遮挡/接近/投射物)+ 自身状态的安全包络;**动作前预测式拦截** + 执行期连续不变量;违反→tick 级中断并**确认控制释放**,交还。**只有 L1 能"拦截"**(`04 §2`)。
- **L2 Primitive**:可中断;`prepare/execute/settle` 阶段级可中断;`safe_stop` 后需确认,超时→`control_uncertain`;**非幂等不自动重放**。
- **L3 Contract Engine**:点后置判定代数;`ambiguous` 由**因果邻域签名 diff + 归因**判定;连续不变量(安全/进展/终止);终止后置整体验收;验证一律用 world 证据。

## 7. tasks / knowledge(L4)

- **tasks**:目标→可检查条件;子目标依赖 + 预算传播;进度=已满足/已产生/未解。
- **目标条件化**(`07` 升级②):进入方法重核前置与仍成立的子目标,只补缺失;**禁止字面重放**;结束做整体后置。
- **knowledge**:方法库=唯一真相源;版本/适用条件/验证记录;`draft→verified→broken/deprecated`;
  **入库门禁**:训练/验证/测试种子隔离;仅"整体成功 + 留出多种子重放通过"才入库;门槛+置信;版本回退。
  **干预式 net-effect**(`SkillGen`):with/without 技能比较,区分 repair/regression。

## 8. L5 Meta / Eval

课程沿能力边缘推进;技能晋升/退役;**实机 benchmark 与评测见 `docs/eval-benchmark.md`**(agent 驱动 MCP、种子隔离、世界重置、独立外部验收器、消融链)。

## 9. interfaces/mcp(模型面 = 语义)

- **只对 agent 暴露:语义观测 + 语义执行。**
  - 语义观测:`observe`/`objects`/`relations`/`evidence`/`status`/`entities`(返回名字/对象 id,坐标只作可读信息)。
  - 语义执行:名字级意图动作(如"采集 3 个原木""走到那棵树""合成木镐")。
  - 单独的**读坐标工具**可作为可选只读能力。
- **坐标原语下沉**:`go_to(x,y,z)`、`break_block(x,y,z)` 等**降为 execution 内部能力**,默认不出现在 `tools/list`;需要时用开关临时开放作逃生。
- 结果一律 `ActionResult`;模型只看摘要,细节可展开。
- **动态与生成**:技能库为源;`run_skill` + `list_skills`;稳定技能启动时**晋升一等工具**;`define_skill`(声明式组合生成工具)+ 模块加载器;变更发 `tools/list_changed`。

## 10. mods/server-observer 契约(只读,`14 §4`)
- `GET /health` → `{ok, server_tick, mc, mod_version}`
- `POST /snapshot` → 单 tick 原子;`snapshot_seq`;`coverage{loaded,truncated,boxes}`;每事实 `obs_seq/observed_tick`
- `GET /events?since=<{epoch,seq}>` → `{cursor, has_more, reset_required?, events[]}`
- `GET/POST /markers`(SavedData)
- `isLoaded=false → unknown`;只读;本地/内网 + token。
- **归因上限**(`14 §3`):首版不发 `action_id` 给 Mod,归因**≤ `self_temporal`**。

## 11. 环境 / 工具链(`16`)
- MC **1.20.1** · Loader 0.19.5 · Fabric API 0.92.12+1.20.1 · Loom 1.18.2 · Gradle 9.7.1 · Mojang 映射 · target Java 17;JDK 25(`env.sh`)。
- Node 24 / **pnpm**;`.nvmrc` + `pnpm-lock.yaml`;`gradle.lockfile` + wrapper sha256。
- `tools/`:`setup.sh` / `server-up.sh` / `bot-up.sh` / `view-up.sh` / `client-up.sh` / `reset-world.sh`。

## 12. 测试与评测(区分两类,严禁混淆)
- **工具 smoke / dry-run(非 LLM)**:只验证工具在真实 MC 中能连通、参数正确、返回结构正确。**不得**作为机制或任务完成的证据(明确禁止糊弄)。
- **实机 benchmark(agent 驱动 MCP,禁止写死脚本)**:见 `docs/eval-benchmark.md`。
- `tests/semantics`(纯函数)、`tests/replay`(录制事件回放)、`tests/integration`(端到端)。

## 13. 可视化(调试 + 素材)

- 目的:① 本地调试看趋势;② 后续导出宣传素材。
- 方案:`prismarine-viewer` 浏览器模式(实时看 bot)用于调试;`headless` 出帧(mp4/TCP)用于素材与未来多模态;真实客户端可旁观。
- 可叠加调试层:路径、当前目标、语义对象、断言状态、安全包络状态。
- 归入 `adapters/vision` + `tools/view-up.sh`;默认**不进入实时控制回路**(未来视觉主导模式除外)。

## 14. 迁移与 git
- 现有 `agent/src/**` 原型与 `tools/mcp-smoke.mjs` 已移分支 `proto/mcp-runtime`;重建时删除 master 残余,只把 observer 客户端/谓词/diff 迁入对应层后重写。
- `mc-mod/` → `mods/server-observer/`;`agent/` → `apps/agent/`(TS)。
- 提交粒度:本框架 → contracts → adapters+foundation → world → execution → tasks/knowledge → interfaces/mcp+apps → tests/eval。**每次可编译**。

## 15. 已定决策(本轮)
1. **不做主动区体素缓存**;感知按需;安全看实体+自身;避障靠 pathfinder(→多层表面图)。
2. **做语义对象**。
3. **首版不做视觉,但设计预留接缝**;允许未来视觉占大比重。
4. **实机 benchmark 单独设计**(`docs/eval-benchmark.md`):种子隔离 + 任务套件 + 世界重置 + **agent 驱动 MCP、禁止写死脚本**;单独的**非 LLM 工具 smoke**可存在但不得当完成。
5. **坐标对 agent 先藏**;只暴露语义观测 + 语义执行;坐标仅作读取信息或单独只读工具。
6. **进程:常驻进程 + 薄桥,两边尽量解耦。**
7. **可视化纳入设计**(调试 + 素材)。

## 16. 仍需你确认
- 首版语义对象最终 kind 集合(建议 tree/ore_vein/container/workstation/frontier)。
- 技能晋升的**具体阈值与置信**口径(先给保守默认,实测后调)。
- 工具 smoke 的**允许范围**(只测连通/结构,还是也覆盖少量"动作能生效"的机制自检)。
