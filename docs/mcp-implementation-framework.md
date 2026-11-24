# Minecraft MCP 实现框架(最终形态)

> 详细设计:`docs/world-map-and-composition.md`(感知/地图/编排)。
> 状态:**已实现**(M0–M4 通过 gate,S1 实机通过);本文记录契约与累计决策,见 §15。日期:2026-10-08。

---

## 铁律(工程纪律;违反即返工)
1. **不为中间测试写非正式代码。** 每次实现都必须按设计文档做"**已知最正确的最终实现**";哪怕中间没法跑测试,也不写临时/占位/捷径代码 —— 禁止 stub、禁止手写高层去顶替组合、禁止为过 gate 临时简化。
2. **原子动作是几十个、覆盖各领域;架构围绕完整动作库。** 不能为几个零散动作把设计做窄;新增能力扩展"动作库 / 关系 / 组合",而不是特例化少数动作。
3. **"完成"= 通过 gate。** 编译 / 单测 / 非 LLM 工具 smoke **都不算完成**;只有对应里程碑的真实 gate(真实 LLM 经 MCP、真实 MC、**独立验收**)通过才算。**薄 ≠ 完成**。
4. **测试用 subagent 执行。**
5. **坐标下沉**:模型面 = 语义(名字 / 对象引用);坐标仅作读取信息或显式 `cell` 逃生。
6. **组合由 agent 用有界词表完成**,不手写高层动作。
7. **每个提交可编译、可运行;维护 git,不留垃圾**(弃用代码移分支或删除)。

## 0. 形态、语言、进程、视觉、可视化

- 仓库根 = `mc-agent`;业务 **TypeScript / Node.js**(pnpm 锁);Mod 为 **Java/Fabric**。
- **进程:常驻 agent 进程 + 薄 MCP 桥,两边尽量解耦**(MCP 客户端按会话起进程,各自开 bot 会互相顶号)。
- **视觉接缝**:`adapters/vision` 从第一天是正式接口,**不得假设纯文本**;预留"视觉占大比重"模式。首版不实现。
- **可视化**:`prismarine-viewer`(调试 + 素材),默认不进实时控制回路。

## 1. 概念栈(研究 07)↔ 包
L0 具身适配(`adapters/*`+`world`) / L1 Reflex-Shield(`execution/reflex`) / L2 Primitive(`execution/primitives`) / L3 Contract Engine(`execution/contract`+`contracts`) / L4 二级动作与 skill(`knowledge`+`tasks`) / L5 Meta-Eval(`tasks`+`tests/eval`)。

## 2. 目录(沿用 `16 §2`)
`apps/agent` · `packages/{contracts,foundation,world,execution,tasks,knowledge,interfaces/mcp,adapters/{mineflayer,telemetry,client-mod,vision}}` · `mods/mcagent` · `scenarios` · `tests/{semantics,replay,integration,eval}` · `tools` · `docs`。

## 3. 依赖方向(强制)
`contracts ← foundation ← world / execution ← tasks / knowledge ← interfaces/mcp ← apps/agent`;`adapters/*` 实现 `foundation` 端口。`interfaces/mcp` 不写执行逻辑。

## 4. 契约(`packages/contracts`)
- 两条正交轴:事实来源 `authoritative|observed|predicted|inferred`;动作证据级 `sent|predicted|observed|attributed`。`sent/predicted` 不作 pass 依据。
- `Predicate`(三值 Kleene;unknown→`unobservable`);**安全编译边界**:安全不变量白名单强制,LLM 不可删/放宽。
- `ActionResult`(冻结):`effectStatus / controlStatus / reason / effects / evidence / attribution(首版≤self_temporal) / diff / resources / timing / control / subResults`。**结果必须自解释**(见 §6)。
- `ActionContract`(pre/post/invariants/effectClass/interruptible/safeStop/timeout/causalScope/retryPolicy)。
- `Method/Skill`(params/pre/post/invariants/steps/failurePolicy/stats/status/validation/provenance)。
- `TaskSpec`;能力分级(规划可见/验证可见/动作权限)。

## 5. world:感知与地图(**本轮定稿**;详 `world-map-and-composition.md`)

- **不做结构识别分类法**。树/矿脉/建筑**不由程序命名**;程序只给**通用查询**,名字由 agent 下。
- **通用查询原语**:
  - `connected(seed | region, match = 方块/标签/族, neighbor, bounded)` —— 连通分量;
  - `region(box, filter)`;`exposed_faces(box)`;`standable_surfaces(box)`;
  - 关系 `reachable / lineOfSight / adjacent_air / support / hazardous`。
  - **方块族一律用 MC 官方 tag/registry**(#logs/#leaves/#planks/#ores/#stone…),不自造分类。
  - 例:"一棵树" = agent 对 `connected(那根原木, #logs)` 的命名;炸了一半/别人搭的,分量是什么就是什么(后置看目标,不看"是不是树")。
- **表面壳 + 多层表面图(承载移动图与感知)**:只维护**与空气接触的暴露面**,不做体积体素缓存;范围约 **4 区块**(暴露于空气者);按 **chunk-section 调色板/位压**;更新 = **事件增量打补丁 + 跨格平移 + 低频兜底 + 方向前方优先**。
- **两层地图**:
  - **本地表面壳**:高频、权威、新鲜 —— **唯一证据来源**(控制/安全/断言);
  - **持久稀疏发现图**(结构/资源点/路点/地形骨架):低频,**明确标记为"记忆/可能过期"**,**仅用于规划**,进近时重校验,**绝不作后置证据**。
- **affordance**:便宜的(距离/是否在触及范围/是否有视线/需要什么工具/是否具备)**随对象返回**;昂贵的(精确可达)按需。
- **地址(定稿见 `world-map-and-composition.md §12`)**:模型面主用**对象句柄 + 罗盘方位**(东/南/西/北+上/下,不绑定朝向);**坐标准许出现在返回里,但默认不引导、只作采样/兜底**,不作为动作主参数。
- **两个主感知工具**:`view`(近处逐方块、裁剪到含方块的长方体、暴露面/内部/黑雾/玩家)与 `scan_blocks`(暴露连通同类方块**聚成对象** + 可互动/实体/液体,带中心/边缘距离、是否够得着、是否可达、罗盘方位,默认半径≥24、服务端过滤、低延迟)。

## 6. execution(L1/L2/L3)

- 控制令牌:单 body 独占;优先级 `P0 反射/生存 > P1 任务 > P2 子任务 > P3 空闲`。
- **L1 Reflex/Shield**:实体威胁(结合遮挡/接近/投射物)+ 自身状态;动作前预测式拦截 + 执行期连续不变量;违反→tick 级中断并确认控制释放。**只有 L1 能"拦截"**。
- **L2 Primitive**:
  - **核心是"替换"原语 `replace(cell, B)`**(B 可为空气):`当前==B→跳过;否则 air→放置,非 air→破坏后放置,B=air→破坏`。
  - **动作结果必须自解释**:目标是谁、当时是否可达/需先接近、做了什么、为何未成(前置/冲突/被挡/不可观测)、证据与 diff;避免让 agent 再发试探调用。
  - **隐式/显式导航都留**:隐式 = `replace(..., auto_approach)` 内部导航;显式 = 单独 `go_to`;**隐式必须把导航步骤写进结果**。
  - **导航权限 = 脚手架权限**:自由设定(参数/预算),**本轮不拍死**。
- **L3 Contract Engine**:点后置代数(因果邻域签名 diff + 归因);连续不变量(安全/进展/终止);终止后置整体验收;验证用 world 证据。
- **持续动作(写设计,后做)**:`explore(direction, until=谓词, budget)` —— 只给"前方"参数的自动避障前进,按频率查询谓词,**命中/超时/危险即中断并交还控制**。详见 `world-map-and-composition.md §9`。

### 6.1 原子动作库(全量;已实现于 `packages/execution`)
所有动作以 `Target`(语义)为参数,返回冻结 `ActionResult`;核心方块动作 `set_block` 为**两状态替换**(当前==B 跳过;air→放置;非 air→破坏+放置;B=air→破坏),导航**隐式**(参数 `navigate`)或显式(`go_to`),`allowModify` 开关 = 是否允许导航放/破坏(= 脚手架),默认关。**地址模型见 `world-map-and-composition.md §12`**:模型面主用**对象句柄 + 罗盘方位**,`cell` 坐标仅作次要兜底。

| 域 | 动作 |
|---|---|
| 感知 | **view** / **scan_blocks** / **relations** / observe / get_self_status / get_inventory / scan_entities / find_nearest / raycast / inspect_container / lookup_recipe / get_world_info / recall |
| 移动 | go_to / follow / flee / look_at / wait / steer |
| 方块 | **set_block** / use_block |
| 实体 | attack / interact_entity / use_item_on |
| 背包 | equip / unequip / drop / transfer_item / consume / use_item |
| 容器/生产 | open_container / close_container / craft / smelt / enchant / anvil_combine / trade |
| 元 | chat / run_command |
| 编排 | **run_method**(有界词表;临时组合) |
| 二级动作 | **define_action / list_actions / try_action / activate_action / rollback_action / retire_action**(agent 造的可调用动作;在线门禁 + 版本回退) |
| 技能(文本) | **write_skill / list_skills / read_skill**(方法论/踩坑/提醒的**文本**;不可调用,按需检索注入) |

(共 49 个;`view`/`scan_blocks` 两个主感知工具;`run_method` 临时组合;二级动作=agent 生成的可调用组合;skill=文本引导。)`

## 7. tasks / knowledge(L4):编排与进化

- **有界控制词表(不 Turing 完备)**:控制 `sequence / for_each / repeat / branch`;集合 `members(handle) / surface(handle) / nearest(match) / area(anchor,size,offset) / set_difference`(绝对方框 `region/box_cells` 兜底)。由**有界 runner**(`run_method`)解释执行。
- **目标条件化**:重算缺失集合,只补缺失;**禁止字面重放**;结束做整体后置。
- **三层概念(定稿 2026-10-09)**:
  - **一级动作**:内置意图工具(几十个,全领域)。
  - **二级动作**:**agent 生成的可调用组合**;系统强制生命周期 `draft→active→superseded/broken/retired`;**在线门禁**(只数真实使用:minUses、passRate、最近窗口、net-effect),**无 train/val/test**;agent 只能"提议"(define/activate/rollback),系统按门槛与状态机决定;版本回退到 `superseded`。
  - **skill**:**纯文本**(方法论/踩坑/提醒,coding-agent 风格),**不可调用、不进工具表**,**按需检索注入**。
- **兜底(失败恢复)**:局部修复(目标条件化,有界次数)→ 版本回退 → 交还 LLM 用一级动作重规划;不是"换调用方式"。
- **定位**:底料 + 编排 + 验证/晋升;**高层动作由 agent 造**(二级动作);skill 是沉淀下来的方法论文本。

## 8. L5 Meta / Eval
课程(能力边缘)+ 技能晋升/退役 + 实机 benchmark 与评测(agent 驱动 MCP、种子隔离、世界重置、独立外部验收器、消融链;装置在 `tests/eval/` 与 `tools/bench.sh`)。

## 9. interfaces/mcp
- **agent 面 = 两个主感知工具(`view` / `scan_blocks`)+ 有界 runner(`run_method`)+ 二级动作工具(`define_action`/`list_actions`/`try_action`/`activate_action`/`rollback_action`/`retire_action`)+ skill 文本工具(`write_skill`/`list_skills`/`read_skill`)+ 持续动作**;结果自解释;坐标不引导。详见 §12 与 §7。
- **动态/生成(已实现,M4)**:二级动作库为**唯一真相源**;`active` 版本由常驻进程注册为**一等工具**(调用方式与一级动作相同);激活/回退/退役时**重新同步工具面并发 `notifications/tools/list_changed`**(resident → 桥 → 客户端);`try_action` 是**校验口**(跑 draft/指定版本)兼弱客户端兼容。skill 是**文本**,按需检索注入,不进工具表。

## 10. mods/mcagent 契约(只读观测 `14 §4` + 客户端控制)
`/health`;`/snapshot`(单 tick 原子 + `snapshot_seq` + `coverage` + 每事实 `obs_seq/observed_tick`);`/events?since=<{epoch,seq}>`(`cursor/has_more/reset_required`;**覆盖玩家破坏与放置**,`before→after`,`actor`);**`/tags`(服务端权威的官方方块/实体标签表,供"按标签匹配",不自造分类)**;`/markers`;`isLoaded=false→unknown`;只读 + token;**归因上限 `self_temporal`**。

## 11. 环境 / 工具链(`16`)
MC 1.20.1 · Loader 0.19.5 · Fabric API 0.92.12+1.20.1 · Loom 1.18.2 · Gradle 9.7.1 · Mojang 映射 · target 17;JDK 25;Node 24 + pnpm;`.nvmrc`/`pnpm-lock.yaml`/`gradle.lockfile`/wrapper sha256。`tools/{setup,server-up,bot-up,view-up,client-up,reset-world}.sh`。

## 12. 测试与评测
- **工具 smoke/dry-run(非 LLM)**:只证工具连通/参数/结构,**不得当完成**。
- **实机 benchmark(agent 驱动 MCP,禁止写死脚本)**:见 `tests/eval/` 与 `tools/bench.sh`。
- `tests/{semantics,replay,integration}`。

## 13. 可视化

- **调试视图(已实现)**:`tools/view.mjs` / `tools/view-up.sh` —— **零依赖**俯视表面图(直读观测 Mod),输出**终端 ANSI** + **彩色 HTML**(`/tmp/opencode/view.html`);`--watch` 实时刷新。默认不进控制回路。
- **3D(暂缓,预留接缝)**:`prismarine-viewer` 需要原生 `canvas` 模块(本环境装不上),故延后;接口已留。
- 可叠调试层(路径/目标/对象/断言/安全);headless 出帧(素材/多模态)留待接入。

## 14. 实现计划:里程碑与验证门(M0–M6)

**完成定义(铁律)**:编译通过 / 单测通过 / 非 LLM 工具 smoke **都不算完成**。只有该里程碑的 **gate 通过**才算:真实 LLM **经 MCP**、在**真实 MC** 上**自主完成任务**、由**独立验收器**判定通过、全程记录轨迹、**无写死脚本**。每个里程碑标注哪些层是"薄"的 —— **薄 ≠ 完成**。

| 里程碑 | 加厚的层 | Gate(真实验证) |
|---|---|---|
| **M0** | workspace + `contracts` + 纯函数单测 | 无(纯基础设施,**不称项目完成**) |
| **M1** | Mod 契约(health/snapshot/events)、telemetry、mineflayer 控制、world(事实+引用+最小关系+基础表面壳)、execution(令牌+`replace`+单点后置三态+最小 L1)、interfaces/mcp(最小面)、apps(常驻+薄桥) | **G1**:agent 经 MCP 在真实 MC 完成"砍 1 根原木入手",独立验收通过 |
| **M2** | world(通用查询/多层表面图/两层地图)、execution(完整 L1 + L2 少量原语 + L3 因果 diff/整体后置)、tasks(有界词表) | **G2**:agent 完成"挖矿脉 + 建小结构",扰动下出现三态与局部修复,独立验收通过 |
| **M3** | knowledge(二级动作库:版本/统计/在线门禁/net-effect/回退 + skill 文本层) | **G3**:agent 造二级动作 → 实机试用 → 在线门禁激活 → 版本回归 → 回退(无种子) |
| **M4** | interfaces/mcp 全量(动态/`list_changed`)、apps 全量、可视化 | **G4**:多会话共享一个身体、客户端感知 `list_changed`、可视化可见 |
| **M5** | tests/eval(agent 驱动 runner + 独立验收器 + 指标 + 消融)、scenarios(T1–T4 + 种子隔离 + fixtures + reset-world) | **GF**:完整 benchmark(test 种子)报告全部指标 + 消融;**机制有效性的唯一最终判定** |
| **M6** | `explore` 持续动作、视觉、课程 | 各自单独 gate(按需) |

**顺序**:M0→M1→M2→M3→M4→M5,必须前一步 gate 通过才进下一步。**测试用 subagent 执行**。

**工程**:pnpm workspace + `tsc -b` + vitest;每步可编译、可测。**迁移**:`mc-mod → mods/mcagent`,`agent → apps/agent`(TS),原型留 `proto/mcp-runtime` 分支。

> **Route B(真实客户端控制)**:`mods/mcagent` 的 `client` 源集在真实打开的客户端里把本地玩家
> 作为身体,经本地 HTTP 8766 暴露 `ControlPort` 原语;`@mc-agent/adapters-client-mod` 实现同一
> 接口,`MCAGENT_CONTROL=client-mod` 选择。**上层(执行引擎/契约/工具面/二级动作/skill/感知)不变。**
> 详见 `docs/client-controller.md`。

## 15. 累计已定决策
1. 不做主动区**体积**缓存;改为**接触空气的表面壳**,并入多层表面图。
2. 做**通用世界查询**(connected/region/exposed_faces/standable_surfaces/relations,基于 MC tag),**不做结构识别分类法**。
3. 视觉首版不做,**预留接缝**,允许未来占大比重。
4. 实机 benchmark:**种子隔离 + 任务套件 + 世界重置 + agent 驱动 MCP、禁止写死脚本**;非 LLM 工具 smoke 可存在但**不得当完成**。
5. 坐标对 agent **先藏**;只暴露语义观测 + 语义执行;坐标仅读取信息/单独只读工具。
6. 进程:**常驻进程 + 薄桥,尽量解耦**。
7. 可视化纳入设计(调试 + 素材)。
8. 编排用**有界控制词表**(非 Turing 完备、非纯静态)。
9. **`explore` 持续动作**写设计,后做。
10. 地图用**两层制**(本地壳=证据;持久发现图=仅规划、可过期)。
11. 核心原语是 **`replace`**(两状态:目标 B / 不管);**动作结果必须自解释**。
12. 隐式/显式导航**都留**;**导航权限=脚手架权限**,自由设定待权衡。

## 16. 待确认
1. 首个里程碑任务集(T1–T4 里先做哪个)。
2. 技能晋升阈值默认值与置信口径。
3. 工具 smoke 的允许范围(仅连通/结构,或含少量"动作生效"自检)。
