# Minecraft MCP 实现框架(最终形态)

> **依据优先级(高→低)**:`docs/research/07`(综合/精炼架构)、`15`(执行引擎)、`13`(动作契约/断言/结果)、`11`(感知)、`14`(拓扑/Mod 契约)、`04`(RV/安全)、`06`(评测)、`02`(技能契约近邻)、`16`(环境/工具链)、`17`(Voyager 取舍) → `minecraft-framework.md`(旧,机制总纲) → `minecraft-layering.md`(旧,包结构仍沿用)。
> 冲突时以研究文档为准,并回改本文。状态:**冻结,待实现**。日期:2026-10-07。

---

## 0. 形态、语言与进程

- 仓库根 = `mc-agent`;业务代码 **TypeScript / Node.js**(pnpm 锁);服务端 Mod 为 **Java/Fabric**。
- 逻辑分层 ≠ 多服务:world/execution/tasks/knowledge 在**同一进程**内(`14 §1`)。
- **进程形态(对 `14§1` 的有意偏离,研究 07 D5)**:MCP 客户端会按 session 各起进程,故定义为
  - **常驻 agent 进程**(`apps/agent`):唯一持有 bot / 世界客户端 / 执行 / 任务 / 技能库;
  - **薄 MCP 桥**(stdio,每 session 一个):只转发协议,不含执行逻辑。
  - 这样既满足"任意多个模型会话共享一个身体",又保留"验证器/技能库/课程"在仓内自包含(D5)。**待你确认。**

## 1. 概念栈(研究 07 精炼)↔ 包映射

| 层 | 职责 | 对应包 |
|---|---|---|
| **L0 具身适配** | 玩家协议控制 + Fabric 只读观测;证据分级;对象引用版本化;未加载/失去跟踪→unknown | `adapters/*` + `world`(事实归一) |
| **L1 Reflex / Shield** | tick 高频、无 LLM;**唯一能"拦截"**的一层(预测式可行性)+ 连续不变量监视 | `execution`(reflex/monitor) |
| **L2 Primitive** | 可中断、效果可解释;底层判据不可删;副作用分类 read/幂等/消耗/不可逆 | `execution`(primitives) |
| **L3 Contract Engine** | 点后置判定代数 + 因果邻域签名 diff + 连续不变量 + 终止后置(整体验收) | `execution`(contract) + `contracts` |
| **L4 Skill Layer** | 低熵→冻结模板(目标条件化);高熵→进化技能(同契约当适应度);干预式 net-effect;防污染 | `knowledge` + `tasks` |
| **L5 Meta / Eval** | 课程(能力边缘)、晋升/退役、误报/拒判/污染/代价评测 | `tasks`(课程) + `tests/eval` |

## 2. 目录(沿用 `16 §2` / `layering §1`)

```text
mc-agent/
├── apps/agent/                     # 唯一装配:配置、连接、生命周期、常驻进程 + MCP 桥
├── packages/
│   ├── contracts/                  # 跨边界类型与端口接口(无第三方依赖)
│   ├── foundation/                 # 端口最小公共设施:clock/id/结果基元/能力注册
│   ├── world/                      # 事实归一、稳定对象引用、按需关系、语义对象、查询
│   ├── execution/                  # L1 reflex、L2 primitives、L3 contract engine、退出/中断
│   ├── tasks/                      # 目标解释、子目标依赖、预算、进度、目标条件化重展开、课程
│   ├── knowledge/                  # 方法/技能:参数、适用条件、失败策略、版本、统计、来源
│   ├── interfaces/mcp/             # 工具 schema、校验、结果呈现、动态注册与 list_changed、stdio 桥
│   └── adapters/{mineflayer,telemetry,vision}
├── mods/server-observer/           # Java/Fabric 只读观测 + 事件 + 标记
├── scenarios/                      # 人工区域、示例蓝图、可复位世界脚本
├── tests/{semantics,replay,integration,eval}/
├── tools/                          # 启动/构建/测试脚本
└── docs/
```

不预建空目录/空壳;每层只在写进真实内容时创建。

## 3. 依赖方向(强制)

```text
contracts ← foundation ← world / execution ← tasks / knowledge ← interfaces/mcp ← apps/agent
                              ▲
                   adapters/* 实现 foundation 的端口
```

`contracts` 不依赖 Mineflayer/Fabric/MCP/任何任务实现;`world`/`execution` 不 import 具体后端;`execution` 查 `world`,`world` 不调控制器;`tasks` 经 `world` 查条件、经 `execution` 推进;`interfaces/mcp` 不写执行逻辑。

## 4. 契约(`packages/contracts`)

### 4.1 事实来源 + 动作证据等级(**两条正交轴**,`14 §5` + `07 L0`)
```ts
type Source = 'authoritative' | 'observed' | 'predicted' | 'inferred';   // 事实来源
type EvidenceLevel = 'sent' | 'predicted' | 'observed' | 'attributed';    // 动作效果强度
interface Fact<T> { value: T; source: Source; observedTick: number; coverage: Coverage; } // 越界/过期→Unknown
```
"输入已发送 / 客户端预测 / 服务端观察 / 因果归属"必须分开;`sent`/`predicted` **不作为 pass 依据**。

### 4.2 谓词与三值(`13 §1`,`04 §3`)
```ts
interface Predicate { subject: string; predicate: string; value?: unknown;
  scope?: Scope; notBeforeTick?: number; minConfidence?: number; attribution?: 'self' | 'any'; }
```
- 求值 true|false|unknown(Kleene);unknown 不得当 false → `unobservable`。
- **安全编译边界**:LLM 只能从受控词表选/参数化;安全类不变量(`hp>0`、非岩浆、非坠落等)**白名单强制存在,LLM 不可删除/放宽**。

### 4.3 ActionResult(冻结,`13 §3`)
```ts
interface ActionResult {
  effectStatus: 'pass'|'fail'|'ambiguous'|'unobservable';
  controlStatus: 'completed'|'blocked'|'interrupted'|'needs_replan'|'cancelled'|'uncertain';
  reason: 'precondition_failed'|'effect_not_observed'|'insufficient_evidence'|'attribution_uncertain'|'timeout'|'policy_blocked'|null;
  effects: EffectDiff[];
  evidence: { claim: string; source: Source; level?: EvidenceLevel; tick?: number }[];
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
  postconditions: Predicate[];   // state_effect 必填;调用者只加不删
  invariants: Predicate[];       // 安全/进展/终止
  effectClass: 'read'|'idempotent'|'consumable'|'irreversible';
  interruptible: { prepare: boolean; execute: boolean; settle: boolean };
  safeStop: 'none'|'release_control'|'finish_landing'|'recall';
  timeoutTicks: number; causalScope: Scope; retryPolicy: 'no'|'safe_once'; repairHint: string[]; }
```

### 4.5 Method / Skill(`13 §5` + `07 L4` + `02`)
```ts
interface Method { id: string; version: number; params: Record<string, JsonSchema>;
  preconditions: Predicate[]; postconditions: Predicate[]; invariants: Predicate[];
  steps: Step[];                          // 目标条件化:绑定在准备时完成,非固定坐标
  failurePolicy: { retry:'safe_only'; repair:'local_step'; onFail:'hand_back' };
  stats: { success:number; fail:number; lastStatus:string|null; lastAt:string|null };
  status: 'draft'|'verified'|'broken'|'deprecated';
  validation?: { seeds: string[]; interventions?: { with:number; without:number } };  // net-effect(repair vs regression)
  provenance: { source:'human'|'llm'|'adaptation'; created:string; note?:string }; }
```

### 4.6 TaskSpec 与能力分级
```ts
interface TaskSpec { goal: Predicate[]; scope: Scope; budget: Budget; stopConditions: Predicate[]; }
// 能力分级报告(07 §2 / 11 §6.3):每条能力标注 规划可见 / 验证可见 / 动作权限
```

### 4.7 端口(adapters 实现)
```ts
interface ControlPort { /* 玩家合法动作,返回原始回执,不判成功 */ }
interface WorldPort { health(): Promise<Fact<SelfState>>; snapshot(box): Promise<Fact<Block[]>>; events(cursor): Promise<EventPage>; }
interface VisionPort { frame(): Promise<Frame>; }
```

## 5. world(L0 事实 + 关系 + 对象)

- 归一为 `Fact`(标注 source/observedTick/coverage);越界/未加载/失去跟踪→`Unknown`,不得当"没有"。
- **稳定对象引用**:`WorldObjectRef`(维度/会话/版本);失效→unknown。
- **按需关系**(任务区展开,依赖失效):standable/reachable/lineOfSight/support/hazardous。
- **语义对象 L2**(模型用 id 引用,不给坐标):tree / ore_vein / container / workstation / frontier …(首版 kind 待定 `11§9`)。
- 只回紧凑摘要 / 按需查询 / 断言证据;体素网格不外泄。

## 6. execution(L1 + L2 + L3)

- **控制令牌**:单 body 独占;优先级 `P0 反射/生存 > P1 任务 > P2 子任务 > P3 空闲`。
- **L1 Reflex/Shield**:动作前预测式可行性拦截(防岩浆/坠落/贴脸/无武器)+ 执行期连续不变量监视;违反→tick 级中断并**确认控制释放**,交还。**只有 L1 能"拦截",L3 只能发现**(`04 §2`)。延迟按 `15 §1.1` 四量拆解,首版不承诺上界。
- **L2 Primitive**:可中断动作;`prepare/execute/settle` 阶段级可中断;`safe_stop` 后需确认,超时→`control_uncertain`;**非幂等不自动重放**。
- **L3 Contract Engine**:点后置判定代数;`ambiguous` 由**因果邻域签名 diff + 归因**判定;连续不变量(安全/进展/终止);终止后置整体验收;验证一律用 world 证据,禁止"我执行完了"。

## 7. tasks / knowledge(L4)

- **tasks**:目标→可检查条件;子目标依赖 + 预算传播;进度=已满足/已产生/未解(非"第几步")。
- **目标条件化**(`07` 升级②):进入方法重核前置与仍成立的子目标,只补缺失;**禁止字面重放**;结束做整体后置。
- **knowledge**:方法库=唯一真相源;带版本/适用条件/验证记录;`draft→verified→broken/deprecated`;
  **入库门禁(promotion gate)**:训练/验证/测试种子隔离;仅"整体成功 + 留出多种子重放通过"才入库;门槛+置信;支持版本回退。
  **干预式 net-effect**(`SkillGen`):with/without 技能比较,区分 repair/regression。

## 8. L5 Meta / Eval

- **课程**:沿能力边缘推进(`07 L5`);技能晋升/退役。
- **评测(`06`)**:必须同时报告
  - 任务完成率(**独立外部验收器**,见下);
  - **误报成功率**(头号指标):系统报 pass 但外部验收判 fail;分母=所有 pass;
  - 非 pass **拆开**:confirmed-fail / insufficient-evidence(真弃权)/ blocked;
  - 技能库污染率;repair/regression;安全停止延迟;恢复成功率;token/工具调用/墙钟/资源;
  - **能力分级消融**(撤服务端特权验证 / 撤视觉)。
- **独立外部验收器**:与内部断言引擎**判定逻辑独立**(独立实现 / 隐藏目标 / 不同模态 / 人工抽检);可读同一世界状态,但不得复用系统谓词或结论。

## 9. interfaces/mcp

- 分组:感知(观察/关系/对象/证据)、意图动作(名字级)、任务、技能、元工具。
- 结果一律 `ActionResult`;模型只看到 `effectStatus/controlStatus/reason/evidence` 摘要,细节可展开。
- **抽象层级(已定 `10§8`/`11§9`/`17§3`)**:模型面向**意图/名字/对象引用**;**坐标原语下沉为 execution 内部能力**,仅作显式逃生并标注。
- **动态与生成**:技能库为源;`run_skill` + `list_skills`;稳定技能启动时**晋升一等工具**;`define_skill`(声明式组合生成工具)+ 模块加载器;**变更发 `tools/list_changed`**。
- `interfaces/mcp` 不实现执行。

## 10. mods/server-observer 契约(只读,`14 §4`)
- `GET /health` → `{ok, server_tick, mc, mod_version}`
- `POST /snapshot` → 单 tick 原子;`snapshot_seq`;`coverage{loaded,truncated,boxes}`;每事实 `obs_seq/observed_tick`
- `GET /events?since=<{epoch,seq}>` → `{cursor, has_more, reset_required?, events[]}`;环形缓冲溢出→`reset_required`
- `GET/POST /markers`(SavedData)
- `isLoaded=false → unknown`;只读;本地/内网 + token。
- **归因上限**(`14 §3`):首版主程序不发 `action_id` 给 Mod,归因**≤ `self_temporal`**,不得记 `self_confirmed`。

## 11. 环境 / 工具链(`16`)
- MC **1.20.1** · Loader 0.19.5 · Fabric API 0.92.12+1.20.1 · Loom 1.18.2 · Gradle 9.7.1(wrapper,腾讯镜像)· Mojang 映射 · target Java 17;JDK 25(`env.sh`)。
- Node 24 / **pnpm**;`.nvmrc` + `pnpm-lock.yaml`;`gradle.lockfile` + wrapper sha256;**未齐"版本号+锁+哈希"不得称已锁定**。
- `tools/`:`setup.sh` / `server-up.sh` / `bot-up.sh` / `view-up.sh`(可选)/ `client-up.sh`(可选)/ `reset-world.sh`(固定种子)。
- **contracts 一致性测试**对齐 Node↔Java schema。

## 12. 测试与评测(`tests/*`)
- `semantics`:三值/未知传播/范围/目标判定(纯函数)。
- `replay`:录制事件的失效传播、中断、恢复判定。
- `integration`:真实游戏端到端(协议/预测/控制/事件/画面)。
- `eval`:消融链 ① 开环 → ② 仅终点检查 → ③ 逐步后置 → ④a +安全不变量 → ④b +三态细分 → ④c +因果归因 → ⑤a +局部修复 → ⑤b +技能入库;再各撤特权/视觉。匹配环境下与 Voyager 对照。

## 13. 迁移与 git
- **现有 `agent/src/**`(runtime/hub/mcp/plugins/skills.json)与 `tools/mcp-smoke.mjs` 是原型**,已移至分支 `proto/mcp-runtime`;按本文重建时删除 master 上的残余,只把 observer 客户端/谓词求值/diff 迁入对应 `packages/*` 后重写。
- `mc-mod/` → `mods/server-observer/`;`agent/` → `apps/agent/`(TS)。
- 提交粒度:本框架 → contracts → adapters+foundation → world → execution → tasks/knowledge → interfaces/mcp+apps → tests/eval。**每次可编译/可运行**。

## 14. 待拍板(研究已给建议,未定不进入相关层)
1. 主动区半径(`11§9` 建议 32³/48³/64³)。
2. 首版语义对象 kind(`11§9` 建议 tree/ore_vein/container/workstation/frontier)。
3. 视觉兜底首版是否接(`09`/`16` 建议 headless、不进反应回路)。
4. 技能晋升阈值 + 种子隔离方案(`07` promotion gate)。
5. 坐标原语对模型默认隐藏与否(`10§8` 已定下沉,隐藏开关待定)。
6. **进程形态**:常驻进程+薄桥 vs `14§1` 单进程(见 §0)。
