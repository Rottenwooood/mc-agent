# 实现状态与交接(压缩上下文后先读这份)

> 本文件是**交接快照**:任何人(或压缩后的下一次会话)读完它 + 设计文档即可继续。
> 设计主依据:`mcp-implementation-framework.md`(铁律、M0–M6+gate、契约、动作库)、`world-map-and-composition.md`(感知/地图/组合)、`eval-benchmark.md`(评测)。
> 更新日期:**2026-10-09**。

---

## 0. 铁律(必须遵守)

1. **不为中间测试写非正式代码**;每次实现按设计文档做"已知最正确的最终实现",哪怕中间跑不了测试。禁止 stub / 手写高层顶替组合 / 为过 gate 临时简化。
2. **原子动作是几十个、覆盖各领域**;架构围绕完整动作库,不为几个零散动作把设计做窄。
3. **"完成" = 通过 gate**:真实 LLM 经 MCP、在真实 MC 上自主完成任务、由独立验收器判定。编译 / 单测 / 工具 smoke **都不算完成**;**薄 ≠ 完成**。
4. **测试用 subagent 执行**(本机 OpenCode 未把 mc-agent 注入会话,故实测由主 agent 经 MCP 桥直接驱动;见 §6)。
5. **坐标下沉**:模型面 = 语义(对象句柄 / 名字);坐标仅作读取信息或显式 `cell` 逃生,默认不引导。
6. **组合由 agent 用有界词表完成**,不手写高层动作。
7. 每个提交可编译 / 可运行;维护 git,不留垃圾。

## 1. 设计文档(主依据)

- `docs/mcp-implementation-framework.md` — 铁律、M0–M6+gate、契约(Fact/Predicate/`ActionResult`/`ActionContract`/`Method`)、L0–L5、**原子动作库(§6.1)**、进程形态、Mod 契约、可视化、累计决策。
- `docs/world-map-and-composition.md` — 表面壳+表面图、两层地图、通用查询、`set_block` 两状态替换、**有界编排词表**、**§12 感知与寻址(定稿)**、拒绝的反模式。
- `docs/eval-benchmark.md` — 实机 benchmark(种子隔离、agent 驱动、独立验收器、指标、消融)。
- `docs/research/*` — 调研(优先 07/15/13/11/14/04/06/02/16/17);`minecraft-framework.md`/`minecraft-layering.md` 为**旧次要**参考。

## 2. 仓库结构(pnpm workspace + tsc -b + vitest)

```
apps/agent                    # 装配 + 常驻进程(resident)+ 薄 MCP 桥(bridge)
packages/contracts            # 冻结类型:Fact/Predicate/Target/ActionResult/ActionContract/Method/Skill/ports
packages/foundation           # http/errors/config(外部能力最小基础设施)
packages/world                # World:status/inventory/entities/blockAt/findNearestBlock/query + 通用查询 + 表面壳 + 发现图
packages/execution            # ControlToken + result 基元 + L1 reflex + L3 契约引擎 + actions/(全量原子动作)
packages/knowledge            # L4 方法库:版本/统计/干预式 net-effect/入库门禁(种子隔离)/回退
packages/tasks                # 有界词表执行器(run_method)+ 二级动作执行(try_action)
packages/interfaces/mcp       # ToolRegistry + buildTools()(全部动作 + run_method + 二级动作/skill 工具)
packages/adapters/telemetry   # WorldPort over 观测 Mod(权威 Fact / unknown)
packages/adapters/mineflayer  # 全量 ControlPort(玩家合法动作)+ 客户端只读
mods/server-observer          # Fabric 只读观测 Mod(数据契约)
scenarios/actions/            # agent 造出的二级动作模板(G3 示例)
tests/{semantics,integration,eval}/   tools/   docs/
```

## 3. 里程碑状态

| 里程碑 | 状态 | Gate |
|---|---|---|
| **M0** workspace + `contracts` + 纯函数单测 | ✅ 完成 | (基础设施,不称完成) |
| **M1** Mod 契约 / telemetry / mineflayer / world 最小 / execution 最小 / interfaces / apps | ✅ 完成 | **G1** ✅ |
| **M2** 通用查询 + 表面壳 + 两层地图 + L1/L3 + 有界词表 | ✅ 完成 | **G2** ✅ |
| **M2.5** 感知/寻址返工(句柄 + 罗盘 + `view`/`scan_blocks`) | ✅ 完成 | **G1/G2 复验** ✅ |
| **M3** 二级动作库(在线门禁/net-effect/回退)+ skill 文本层 | ✅ 完成 | **G3** ✅ |
| **M4** interfaces 动态注册 + `tools/list_changed` + 可视化 | ⏭ 下一步 | G4 |
| **M5** 实机 benchmark(runner + 独立验收器 + 指标 + 消融)+ scenarios | ⬜ 待办 | GF |
| **M6** `explore` 持续动作 + 视觉 + 课程 | ⬜ 待办 | 各自 gate |

顺序:M0→M1→M2→M3→M4→M5,前一步 gate 通过才进下一步。

## 4. 当前能力面(已实现)

- **工具面 = 49 个**(见框架 §6.1)。要点:
  - **感知**:`view`(近处逐方块、裁剪到含方块的长方体、暴露面字母/内部`#`/黑雾`?`/玩家`@`、罗盘对齐)、`scan_blocks`(暴露连通同类方块**聚成对象**:句柄 + size + 中心/边缘距离 + 罗盘方位 + touchable/reachable;含可互动/实体/液体;默认半径 24;Mod `exposed_only` 服务端过滤)、`relations`(兜底)、`recall`(记忆,仅规划)。
  - **地址模型**:`object(句柄) | relative(罗盘) | block | entity | item | container | cell(次要)`;句柄在每次使用**重校验**;罗盘不绑朝向。
  - **编排(有界 runner)**:`run_method`(临时组合;有界词表 sequence/for_each/repeat/branch;集合 `members/surface/nearest/area/set_difference`,绝对方框 `region/box_cells` 兜底);**目标条件化**(重算缺失集、只补缺失),终止后置整体判定。
  - **二级动作**:`define_action`/`list_actions`/`try_action`/`activate_action`/`rollback_action`/`retire_action`(agent 造的可调用动作;`try_action`=校验口;在线门禁 + 版本回退)。
  - **skill(文本)**:`write_skill`/`list_skills`/`read_skill`(方法论/踩坑/提醒;不可调用,按需检索注入)。
- **L4 二级动作库 + skill 文本层**(`@mc-agent/knowledge`):
  - `ActionLibrary`(二级动作):命名/版本化(`Method` + 在线统计),JSON 持久化(`MCAGENT_ACTIONS`,默认 `<cwd>/.mc-agent/actions.json`,变更自动落盘);状态机 `draft→active→superseded/broken/retired`;**在线门禁**只看真实使用(minUses≥3、passRate≥0.6、最近窗口 5 次≥0.6、net regressions≤repairs),**无 train/val/test**;回归或连续失败→系统标 `rollbackRequired`;`rollback` 回到上一个 `superseded` 并把坏版本标 `broken`。
  - `SkillLibrary`(skill 文本):`SkillNote{name,description,tags,text}`,JSON 持久化(`MCAGENT_SKILLS`);**不可调用、不进工具表**,按需 `read_skill` 注入。
- **观测 Mod**:`/health`、`/snapshot`(单 tick 原子 + `coverage` + 每事实 `obs_seq/observed_tick`,支持 `exposed_only` 与 `filters.block_ids`)、`/events`(破坏**与放置**,`epoch/cursor/reset_required`,含 `actor`)、`/tags`(服务端权威官方标签表)。
- **进程**:常驻进程(单 body,Unix socket `/tmp/opencode/mc-agent.sock`)+ 薄 MCP 桥(按需重连 / 可重启);观测 HTTP `127.0.0.1:8765`。

## 5. 门槛证据(独立验收器,均 exit 0)

- **G1(砍 1 根原木入手)** — `tests/eval/g1-verifier.mjs`。`block_changed`(actor=Bot,log→air)+ 背包原木增量,两独立证据。
- **G2(挖矿脉 + 建小结构 + 外部扰动 + 局部修复)** — `tests/eval/g2-verifier.mjs`(`verify-mine`/`verify-build`/`verify-repair`)。修复证据 = 外部 actor 破坏 → Bot 重算缺失集后补回(两条独立事件)。
- **M2.5 复验(新感知/寻址面)** — 用 `view`/`scan_blocks`/句柄/罗盘/`run_method` 新集合重跑 G1、G2,均通过。
- **G3(二级动作在线生命周期)** — `tests/eval/g3-runner.mjs` + `tests/eval/g3-verifier.mjs`(**无种子**):
  - agent 造 `get_wood`(v1 后置 `inv:stripped_oak_log>=1`)与 overfit 变体 v2(同步骤,后置 `>=2`)。
  - 实机试用记账:1 格 fixture 上 v1 跑 3 次全 pass;2 格 fixture 上 v2 跑 3 次全 pass。
  - `activate_action v1` 在线门禁激活(uses 3、pass 3/3)→ `activate_action v2`(v1→`superseded`)。
  - v2 在小 fixture(1 格)上**连续失败 2 次** → 系统标 `rollbackRequired` → `rollback_action`(v2→`broken`,active 回 v1)。
  - skill 文本层:`write_skill` 写方法论 → `read_skill` 按需读取注入。
  - 验收器**独立重算在线门禁**(从原始 uses/pass/recent/net-effect)+ 校验:激活、坏版本 broken、回退存在、active=v1、**online-only(记录里无任何 seed/role 字段)** —— 全部通过。
- **门槛中修复的真实缺陷**:`parseHandle` 拒绝含冒号标签(句柄全失效);`members/surface/nearest` 与对象后置走不过滤整块查询超上限(改服务端按 id 过滤);`scan_blocks match:"any"` 截断(改分类扫描);`view` 黑雾未实现、size 口径不一致;`area(anchor:'self')` 浮点生成非整数格(改取整);更早:控制令牌不可重入死锁(commit `6b7547f`,改 `AsyncLocalStorage` 可重入);桥重启后失效(改按需重连);只读工具被令牌阻塞(改不占令牌 + 硬超时)。
- **已知瞬态(非系统性)**:刚 `go_to` 完仍在移动时立即放置,偶发落到相邻格;静止放置受控复现均正确。

## 6. 构建 / 测试 / 运行

```sh
pnpm build        # tsc -b,全部包
pnpm test         # vitest(语义单测 + integration 工具 smoke;smoke 需服务器在跑)
pnpm smoke:tool   # 仅 tests/integration(需真实服务器)

tools/server-up.sh                       # 起 Fabric 服务器 + 观测 Mod(HTTP 127.0.0.1:8765)
node apps/agent/dist/main-resident.js    # 常驻进程(连 bot 'Bot',监听 socket)
node apps/agent/dist/main-bridge.js      # 薄 MCP 桥(OpenCode 按会话拉起)
tools/reset-world.sh <seed>              # 按种子重置世界(硬种子隔离:停服/删 world/设 level-seed/重启/等 health)
node tests/eval/g3-runner.mjs            # G3 全流程(agent 经 MCP)
node tests/eval/g3-verifier.mjs          # G3 独立验收器
```

- **MCP 配置**:`~/.config/opencode/opencode.json` 的 `mc-agent` → `command: ["node","/home/c6h4o2/dev/mc-agent/apps/agent/dist/main-bridge.js"], enabled:true`。**本机 OpenCode 未把 mc-agent 注入会话/子会话**(subagent 也拿不到),故实测经 **MCP 桥的 stdio JSON-RPC** 直接驱动(与工具契约同源)。桥连不上 socket 时会 detached 起 resident;多会话共享同一个 bot(避免 duplicate_login)。
- **种子**:`scenarios/seeds/train.txt`=1001,1002;`val.txt`=2001,2002;`test.txt`=9001(**test 只用于最终报告**)。
- **环境变量**:`MCAGENT_ACTIONS`(二级动作库路径)、`MCAGENT_SKILLS`(skill 文本库路径)、`MCAGENT_REFLEX=0`(关 L1)。
- **运行器侧 op(不暴露给 agent)**:`node tools/setup-bot.mjs packages/adapters/mineflayer cmd|dig|fixture|fixture-at ...`(`fixture-at x y z n` = 清障后放 n 个 `stripped_oak_log`——属 `#logs` 但自然不生成,故是确定性目标)。
- **独立验收器**:
  ```sh
  node tests/eval/g1-verifier.mjs collect --player Bot
  node tests/eval/g1-verifier.mjs verify --epoch E --since S --before-log-count N --player Bot
  node tests/eval/g2-verifier.mjs collect --box x1,y1,z1,x2,y2,z2 --ore <id> --item <id> --player Bot
  node tests/eval/g2-verifier.mjs verify-mine|verify-build|verify-repair ...
  node tests/eval/g3-verifier.mjs --action get_wood --library /tmp/opencode/g3-actions.json
  ```

## 7. 待办(真正未完成)

- **M4**:`interfaces/mcp` 动态注册 + `tools/list_changed`;**二级动作晋升为一等工具(启动时/运行时)**;多会话共享一个身体;可视化(prismarine-viewer 调试 + headless 出帧)。**Gate G4**:客户端感知 `list_changed`、多会话共享、可视化可见。
- **M5(benchmark,独立装置)**:`tests/eval`(agent 驱动 runner + **独立外部验收器** + 指标:完成率/误报率/非 pass 三分/成本 + 消融链)+ `scenarios/`(**固定若干种子** `seeds.txt` + 场景/任务 T1–T4 + fixtures + blueprints)+ `reset-world.sh` 完善 + **一键启动**(`tools/bench.sh`:server + agent + client)。**Gate GF**:在固定种子上报告全部指标 + 消融;**机制有效性的唯一最终判定**。用于后续开发与论文实验。**种子/选型隔离属于此装置,不属于 agent(agent 只在线、无种子)。**
- **M6**:`explore` 持续动作、视觉(`adapters/vision`)、课程。
- 补 Mod:`/markers`、`coverage`/每事实版本的完善。

## 8. Git 与提交约定

- 每次提交可编译;提交信息 `feat(范围)/fix/docs`。
- 弃用代码移分支或删除,不留死代码/占位。旧原型存档在分支 `proto/mcp-runtime`(master 无残留)。
- 关键决策与"铁律"必须写进 `docs/`,确保压缩上下文后仍可续做。
- **最近提交**:见 `git log --oneline -15`。要点里程碑提交:`M0` workspace/contracts、`M1` 底盘(G1)、`M2` 查询/表面壳/地图(G2)、`M2.5` 句柄+罗盘(`view`/`scan_blocks`)、`M3` 二级动作库(在线门禁/net-effect/回退)+ skill 文本层(G3);根因修复 `6b7547f`(令牌可重入)。
