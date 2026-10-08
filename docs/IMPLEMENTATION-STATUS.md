# 实现状态与交接(压缩上下文后先读这份)

> 目的:压缩上下文前的**交接快照**。铁律与设计见 `mcp-implementation-framework.md`(含铁律、M0–M6、契约、动作库)、`world-map-and-composition.md`、`eval-benchmark.md`。日期:2026-10-08。

---

## 0. 铁律(必须遵守)
1. **不为中间测试写非正式代码**;每次实现按设计文档做"**已知最正确的最终实现**",哪怕中间没法跑测试。禁止 stub / 手写高层顶替组合 / 为过 gate 临时简化。
2. **原子动作是几十个、覆盖各领域;架构围绕完整动作库**,不能为几个零散动作把设计做窄。
3. **"完成"= 通过 gate**(真实 LLM 经 MCP、真实 MC、独立验收);编译/单测/工具 smoke **不算完成**;**薄 ≠ 完成**。
4. **测试用 subagent 执行。**
5. **坐标下沉**:模型面 = 语义(名字/对象引用);坐标仅作读取信息或显式 `cell` 逃生。
6. **组合由 agent 用有界词表完成**,不手写高层动作。
7. 每个提交可编译/可运行;维护 git,不留垃圾。

## 1. 设计文档(主依据)
- `docs/mcp-implementation-framework.md` — 铁律、M0–M6+gate、契约(事实两轴/谓词/`ActionResult`/`ActionContract`/`Method`)、L0–L5、**原子动作库(37)**、进程形态、Mod 契约、可视化、累计决策。
- `docs/world-map-and-composition.md` — 表面壳+表面图、两层地图、通用查询、`replace`/`set_block`、**有界编排词表**、`explore`、拒绝的反模式。
- `docs/eval-benchmark.md` — 实机 benchmark(种子隔离、agent 驱动、独立验收器、指标、消融)。
- `docs/research/*` 为调研(07/15/13/11/14/04/06/02/16/17 优先);`minecraft-framework.md`/`minecraft-layering.md` 为**旧次要**参考。

## 2. 仓库结构(pnpm workspace + tsc -b + vitest)
```
apps/agent            # 装配 + 常驻进程(resident)+ 薄 MCP 桥(bridge)
packages/contracts    # 冻结类型:Fact/Predicate/Target/ActionResult/ActionContract/Method/ports
packages/foundation   # http/errors/config(外部能力最小基础设施)
packages/world        # World:status/inventory/entities/blockAt/findNearestBlock/query(几何纯函数可测)
packages/execution    # ControlToken + result 基元 + actions/(37 原子动作,含 Target 解析)
packages/interfaces/mcp  # ToolRegistry + buildTools()(把 37 动作暴露为工具)
packages/adapters/telemetry   # WorldPort over 观测 Mod(权威 Fact / unknown)
packages/adapters/mineflayer  # 全量 ControlPort(玩家合法动作)+ 客户端只读
mods/server-observer  # Fabric 只读观测 Mod(数据契约)
scenarios/ tests/{semantics,integration} tools/ docs/
```

## 3. 已完成
- **M0**:workspace + `@mc-agent/contracts`(冻结类型 + Kleene 三值)+ 语义单测。
- **M1 底盘**:
  - `mods/server-observer` 数据契约:`GET /health`、`POST /snapshot`(单 tick 原子 `snapshot_seq`+`coverage`+每事实 `obs_seq/observed_tick`)、`GET /events`(`epoch`/`cursor`/`has_more`/`reset_required`)、`GET /tags`(服务端权威的官方方块/实体标签表;191 方块标签/16 实体标签,`#logs` 已实测解析)。**已真实服务器 smoke 通过**。
  - `@mc-agent/foundation` + `adapters-telemetry`(Fact/unknown)+ 非 LLM 工具 smoke。
  - `adapters-mineflayer`:`ControlPort` **全量**(movement/blocks/entities/inventory/containers/meta + raycast/recipes/worldInfo/containerContents)。
  - `@mc-agent/world`:status/inventory/entities/blockAt/findNearestBlock/query;**通用查询 `region`/`exposedFaces`/`standableSurfaces`/`connected`(连通分量)+ 官方标签匹配 + 纯函数单测**(2026-10-08 增补)。
  - `@mc-agent/execution`:**37 个原子动作库**(统一 `Target`;`set_block`=两状态替换 + 隐式导航 + `set_block` 的 `allowModify` 脚手架开关)。
  - `@mc-agent/interfaces/mcp`:`buildTools()` 暴露全部原子动作。
  - `apps/agent`:**常驻进程**(单 body,Unix socket `/tmp/opencode/mc-agent.sock`)+ **薄 MCP 桥**(解耦)。
- **Gate G1 通过(2026-10-08)**:真实 LLM 经 MCP 在真实服务器上**自主**砍下一根原木;由**独立验收器**(直接读观测 Mod 的 `block_changed` 事件 + 权威背包快照,**不复用系统谓词/结论**)判定:`minecraft:mangrove_log@(7,76,26)` 被 `actor=Bot` 破坏且背包原木 4→5。验收脚本:`tests/eval/g1-verifier.mjs`(`collect` / `verify`,exit 0=pass)。
- 最近提交:`7ad02c5`(docs 动作库)、`c945616`(全量动作库)、`2589559`(Target+全量控制面)、`e097fb1`(resident/bridge)、`bbaccb7`/`e6450ba`/`f501665`/`2fda71c`(M1 各步)、`d327b97`(M0)。
- G1 过程中发现并修复的真实缺陷:**(a)** 桥与常驻进程的连接在常驻重启后失效 → 桥改为**按需重连**;**(b)** 观测/只读工具被控制令牌阻塞、卡住的动作可永久占用身体 → 读操作改为**不占令牌**,所有动作加**硬超时并在超时后释放控制**,客户端每个操作也加了超时;**(c)** 区域查询在物品上限处**静默截断**导致"最近方块"报错(把 1.25 格的木头顶成 48.5)→ 按方块 id 在服务端过滤并显式处理截断。
- **旧原型整体存档在分支 `proto/mcp-runtime`**(master 无残留)。

## 4. 构建 / 测试 / 运行
```sh
pnpm build                 # tsc -b,全部包
pnpm test                  # vitest(语义单测 + integration 工具 smoke;smoke 需服务器在跑)
pnpm smoke:tool            # 仅 tests/integration(需真实服务器)

tools/server-up.sh         # 起 Fabric 服务器 + 观测 Mod(HTTP 127.0.0.1:8765)
node apps/agent/dist/main-resident.js   # 常驻进程(连 bot 'Bot',监听 socket)
node apps/agent/dist/main-bridge.js     # 薄桥(OpenCode 会按会话拉起)
```
- OpenCode 的 `~/.config/opencode/opencode.json` 里 `mc-agent` MCP:
  `command: ["node","/home/c6h4o2/dev/mc-agent/apps/agent/dist/main-bridge.js"], enabled:true`。
- 桥连不上 socket 时会 detached 起 resident;多会话共享**同一个** bot(避免 duplicate_login)。桥在 socket 断开后**按需重连**(常驻进程可重启)。
- **独立验收(非 LLM smoke 之外)**:
  ```sh
  node tests/eval/g1-verifier.mjs collect --player Bot
  node tests/eval/g1-verifier.mjs verify --epoch E --since S --before-log-count N --player Bot
  ```

## 5. 待办(按设计,不留捷径)
- **M2**:`world` **通用查询已完成(region/exposedFaces/standableSurfaces/connected + 官方标签匹配)**;待做 **关系(`reachable`/`lineOfSight`/`adjacentAir`/`support`/`hazardous`)** + 表面壳/多层表面图 + 两层地图;`execution` L1 reflex(实体威胁+自身状态,预测式包络 + tick 级中断/`control_uncertain`)+ L3 契约引擎(因果邻域签名 diff + 终止后置);`tasks` **有界词表执行**(`sequence/for_each/repeat/branch`+`set_difference/component/region`)。
- **M3**:`knowledge` 方法库(版本/适用条件/统计/状态 + 干预式 net-effect + 入库门禁/种子隔离 + 回退);技能由 agent 用词表造。
- **M4**:`interfaces/mcp` 动态注册 + `tools/list_changed`;可视化(prismarine-viewer 调试 + headless 出帧)。
- **M5**:`tests/eval`(agent 驱动 runner + **独立外部验收器** + 指标 + 消融)+ `scenarios/`(T1–T4 + 种子清单 + fixtures + `reset-world.sh`)。
- **M6**:`explore` 持续动作、视觉(`adapters/vision`)、课程。
- 补 Mod:`/markers`、`coverage`/每事实版本的完善。

## 6. Git 约定
- 每次提交可编译;提交信息 `feat(范围)/fix/docs`。
- 弃用代码移分支或删除,不留死代码/占位。
- 关键决策与"铁律"必须写进 `docs/`,确保压缩上下文后仍可续做。
