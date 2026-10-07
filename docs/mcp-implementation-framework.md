# Minecraft MCP 实现框架(最终形态)

> **依据优先级(高→低)**:`docs/research/07/15/13/11/14/04/06/02/16/17` → `minecraft-framework.md`(旧) → `minecraft-layering.md`(旧,包结构沿用)。
> 详细设计:`docs/world-map-and-composition.md`(感知/地图/编排)、`docs/eval-benchmark.md`(评测)。状态:**冻结,待实现**。日期:2026-10-08。**累计已定决策见 §15。**

---

## 0. 形态、语言、进程、视觉、可视化

- 仓库根 = `mc-agent`;业务 **TypeScript / Node.js**(pnpm 锁);Mod 为 **Java/Fabric**。
- **进程:常驻 agent 进程 + 薄 MCP 桥,两边尽量解耦**(MCP 客户端按会话起进程,各自开 bot 会互相顶号)。
- **视觉接缝**:`adapters/vision` 从第一天是正式接口,**不得假设纯文本**;预留"视觉占大比重"模式。首版不实现。
- **可视化**:`prismarine-viewer`(调试 + 素材),默认不进实时控制回路。

## 1. 概念栈(研究 07)↔ 包
L0 具身适配(`adapters/*`+`world`) / L1 Reflex-Shield(`execution/reflex`) / L2 Primitive(`execution/primitives`) / L3 Contract Engine(`execution/contract`+`contracts`) / L4 Skill(`knowledge`+`tasks`) / L5 Meta-Eval(`tasks`+`tests/eval`)。

## 2. 目录(沿用 `16 §2`)
`apps/agent` · `packages/{contracts,foundation,world,execution,tasks,knowledge,interfaces/mcp,adapters/{mineflayer,telemetry,vision}}` · `mods/server-observer` · `scenarios` · `tests/{semantics,replay,integration,eval}` · `tools` · `docs`。

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
- **坐标**只作读取信息的一部分,或单独只读工具;**不作为动作参数**给 agent。

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

## 7. tasks / knowledge(L4):编排与进化

- **有界控制词表(不 Turing 完备)**:
  - 控制:`sequence([...])`、`for_each(item in SET, body)`、`repeat(body, until=谓词 | count=表达式 | budget)`、`branch(if=谓词, then, else)`;
  - 集合表达式:`set_difference(D, C)`、`component(seed, match)`、`region(box, filter)`。
  - 例:`build` = `for_each(cell in set_difference(期望, 当前), replace(cell, 期望[cell]))`;`挖矿脉` = `for_each(b in component(seed, #ores), replace(b, air))`。
- **目标条件化**:重算缺失集合,只补缺失;**禁止字面重放**;结束做整体后置。
- **knowledge 入库门禁**:训练/验证/测试种子隔离;仅"整体成功 + 留出多种子重放通过"入库;干预式 net-effect(repair/regression);门槛+置信;版本回退。
- **定位**:我们设计**底料 + 编排 + 验证/晋升**;**高层动作由 agent 造**——`build` 只是"agent 可以造出的一个候选",不是我们手搓的终点。

## 8. L5 Meta / Eval
课程(能力边缘)+ 技能晋升/退役 + 实机 benchmark 与评测(见 `docs/eval-benchmark.md`:agent 驱动 MCP、种子隔离、世界重置、独立外部验收器、消融链)。

## 9. interfaces/mcp
- **agent 面 = 通用感知查询 + 有界编排动作(含 `replace`) + 持续动作**;结果自解释;坐标藏。
- 动态/生成:技能库为源;`run_skill`+`list_skills`;稳定技能启动时晋升一等工具;`define_skill`(在有界词表内生成工具)+ 模块加载器;变更发 `tools/list_changed`。

## 10. mods/server-observer 契约(只读,`14 §4`)
`/health`;`/snapshot`(单 tick 原子 + `snapshot_seq` + `coverage` + 每事实 `obs_seq/observed_tick`);`/events?since=<{epoch,seq}>`(`cursor/has_more/reset_required`);`/markers`;`isLoaded=false→unknown`;只读 + token;**归因上限 `self_temporal`**。

## 11. 环境 / 工具链(`16`)
MC 1.20.1 · Loader 0.19.5 · Fabric API 0.92.12+1.20.1 · Loom 1.18.2 · Gradle 9.7.1 · Mojang 映射 · target 17;JDK 25;Node 24 + pnpm;`.nvmrc`/`pnpm-lock.yaml`/`gradle.lockfile`/wrapper sha256。`tools/{setup,server-up,bot-up,view-up,client-up,reset-world}.sh`。

## 12. 测试与评测
- **工具 smoke/dry-run(非 LLM)**:只证工具连通/参数/结构,**不得当完成**。
- **实机 benchmark(agent 驱动 MCP,禁止写死脚本)**:见 `eval-benchmark.md`。
- `tests/{semantics,replay,integration}`。

## 13. 可视化
`prismarine-viewer` 浏览器(调试)+ headless 出帧(素材/多模态);可叠调试层(路径/目标/对象/断言/安全);默认不进控制回路。

## 14. 迁移与 git
原型在分支 `proto/mcp-runtime`,重建时删除 master 残余,复用逻辑迁入对应层后重写;`mc-mod→mods/server-observer`;`agent→apps/agent`(TS)。提交粒度:框架→contracts→adapters+foundation→world→execution→tasks/knowledge→interfaces/mcp+apps→tests。每次可编译。

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
