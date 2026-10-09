# mc-agent 项目总览(由整体到局部)

> 这份文档面向"第一次接触本项目"的读者:先讲**它是什么、怎么运转**,再逐层展开**每个模块**与**它的公开接口(API)**。
> 每个 API 都说明:**主要用来干什么 / 接受什么(入参) / 输出什么(出参) / 参数含义**。
> **不深入代码内部实现**——只讲对外契约。设计依据见 `docs/mcp-implementation-framework.md` 等(文末索引)。

---

## 0. 怎么读这份文档

1. 第 1–2 章:项目是什么、整体架构与一次动作的完整生命周期(先建立全局观)。
2. 第 3 章:**观测 Mod 的 HTTP API**(外部 agent 读取世界真相的接口)。
3. 第 4 章:**端口契约**(`WorldPort`/`ControlPort`)——所有适配器实现的接口。
4. 第 5 章:各模块职责 + 公开 API。
5. 第 6 章:**工具面(49 个)**——LLM 实际能调用的接口。
6. 第 7–10 章:机制、里程碑、benchmark、运行方式。

---

## 1. 项目是什么

**一个具身 Minecraft agent**:真实 LLM 经 MCP 协议、在**真实 MC 服务器**上自主行动;它用一个**真实协议客户端(mineflayer bot)**作为身体,用**服务端只读 Mod**作为权威感知来源。

它的核心机制:

- **预声明断言 + 程序判定**:每个动作自带"后置条件";执行后由程序(不是 LLM)按**权威世界证据**判定 `pass / fail / unobservable`(三态)。
- **有界组合**:LLM 用一套**受限词表**(不是任意代码)把动作组合成任务;集合**每次重算**(只补缺失),结尾做**整体后置**判定。
- **二级动作沉淀**:agent 把好用的组合**登记成可复用动作**(带版本、在线统计、门禁、回退)。
- **skill 文本**:沉淀"方法论/踩坑/提醒"这类**文本**,按需检索注入。
- **独立验收**:任务成败由**独立验收器**(直读服务端事件/快照,不复用系统结论)判定。

---

## 2. 整体架构

### 2.1 分层

```
L0 具身适配   adapters/*(mineflayer 控制、telemetry 观测)+ world
L1 Reflex-Shield           execution/reflex    无 LLM,可 tick 级中断
L2 Primitive               execution/actions   原子动作(效果可解释)
L3 Contract Engine         execution/contract + contracts  三态判定 + 因果 diff
L4 二级动作 + skill         knowledge + tasks
L5 Meta / Eval             tests/eval
```

### 2.2 依赖方向(强制)

`contracts ← foundation ← world / execution ← tasks / knowledge ← interfaces/mcp ← apps/agent`;`adapters/*` 实现 `foundation` 端口;`interfaces/mcp` **不写执行逻辑**。

### 2.3 进程与数据流

```
[LLM(经 MCP)]
   │ stdio(JSON-RPC)
   ▼
[薄桥 bridge](每会话一个;按需重连)
   │ Unix socket(换行分隔 JSON)
   ▼
[常驻进程 resident](单 body,唯一拥有 bot/world/执行/工具)
   ├── ControlPort  → mineflayer bot ──原版包──▶ [MC 服务器]
   └── WorldPort    ◀──HTTP JSON─── [观测 Mod] ◀──读── [MC 服务器]
```
- **resident** 是唯一身体拥有者;多个会话(桥)共享它。
- **感知**走服务端观测 Mod(权威);**控制**走协议客户端。

### 2.4 一次动作的完整生命周期

1. LLM 调一个工具(如 `set_block`)→ 桥转发 → resident 执行。
2. **L1 reflex 预检查**:若当前是危险状态(敌近/弹射物近/濒死),非防御性动作被拒(`policy_blocked`)。
3. **占令牌**:同一时刻只有一个"占身体"的动作在跑(读操作不占)。
4. **解析目标**:把语义 `Target`(句柄/罗盘/名字)→ 具体坐标/实体。
5. **取"因果邻域签名"**(执行前)。
6. **执行**:调 `ControlPort` 发玩家合法动作;执行期 reflex 持续监视,发现危险即中断。
7. **取执行后签名,算 diff**;按动作**后置条件**判定 `pass/fail/unobservable`;**超时对账**(超时但效果已出现→接受)。
8. 结果(证据 + diff + 归因)回桥 → LLM。

---

## 3. 观测 Mod(服务端,只读)——HTTP API 详解

### 3.1 它是什么 / 为什么

一个 Fabric **服务端只读** Mod(`mods/server-observer`)。它把"服务端权威事实"用**本地 HTTP JSON** 暴露给外部 agent;**从不修改世界**。为什么需要它:agent 的证据必须是**服务端真值**,而不是客户端自报;并且要能**单 tick 原子**地取一份完整快照(避免"位置和血量来自不同时刻")。

- 监听:`127.0.0.1:8765`;4 线程池。
- 鉴权:若设置了 `mcagent.observer.token`(系统属性/环境变量 `MCAGENT_OBSERVER_TOKEN`),则要求 `Authorization: Bearer <token>`;默认无。
- 所有读服务器状态的操作都在**服务器主线程**执行(避免跨线程读世界)。
- 单次响应物品上限 `8192`。

### 3.2 目录

```
mods/server-observer/src/main/java/com/mcagent/observer/
├── ObserverMod.java            # 入口:生命周期、tick 计数、登记破坏事件
├── HttpApi.java                # 四个 HTTP 接口
├── EventLog.java               # 有界事件日志(epoch/seq 游标)
└── mixin/BlockItemPlaceMixin.java  # 记录"放置方块"事件
```

### 3.3 `GET /health` —— 存活与时钟

**用途**:探活;拿到"当前游戏刻 / 事件纪元 / 最新事件号",作为其他接口的时钟基准。

**入参**:无。

**出参**:
| 字段 | 含义 |
|---|---|
| `server_tick` | 当前服务器 tick(游戏刻)计数 |
| `mc` | MC 版本串(如 `1.20.1`) |
| `mod_version` | 观测 Mod 版本 |
| `event_epoch` | 当前**事件纪元**(服务器每次启动 +1) |
| `event_seq` | 当前**最新事件序号** |
| `revision` | 世界版本(目前=最新事件序号,单调) |
| `ok` | 恒 `true` |

### 3.4 `POST /snapshot` —— 单 tick 原子快照(核心接口)

**用途**:在**同一 tick、同一快照序号**下取一份完整世界切片(玩家状态 / 方块 / 实体 / 背包)。是 agent 感知的权威来源。

**入参**(JSON body,也容忍 query 参数):

| 参数 | 类型 | 含义 |
|---|---|---|
| `dimension` | string | 维度,默认 `minecraft:overworld` |
| `player` | string | 以哪个玩家为中心(默认第一个在线玩家) |
| `scope.kind` | string | `"box"`(用 min/max)或 `"egocentric"`(以玩家/center 为中心、半径 `r`) |
| `scope.min` / `scope.max` | `[x,y,z]` | box 的整数角点 |
| `scope.center` | `[x,y,z]` | 显式中心(否则用玩家坐标向下取整) |
| `scope.r` | number | 半径(默认 16) |
| `want` | string[] | 要哪些事实:`self` / `blocks` / `inventory` / `entities`;默认 `self+blocks` |
| `max_items` | number | 本次最多返回多少项(上限 8192) |
| `exposed_only` | boolean | true 时**只返回"接触空气/水的暴露面"方块**(大半径扫描用) |
| `filters.block_ids` | string[] | 只返回这些方块 id(服务端过滤,配大半径保低延迟) |

**出参**:
| 字段 | 含义 |
|---|---|
| `snapshot_seq` | 本次快照的全局单调序号(每次 +1);用于对齐同一次快照 |
| `server_tick` | 快照所在游戏刻 |
| `revision` | 世界版本 |
| `coverage.loaded` | 范围角点所在区块是否已加载 |
| `coverage.truncated` | 是否因 `max_items` 被截断(**截断=不完整,下游须当作 `unknown`**) |
| `coverage.boxes` | 实际查询的两个角点(回显) |
| `self` | 玩家状态对象(见下) |
| `blocks[]` | 非空气方块数组(见下) |
| `block_count` | 方块数 |
| `entities[]` | 范围内实体数组(见下) |
| `entity_count` | 实体数 |
| `inventory[]` | 玩家背包(见下) |

- **`self`**:`pos[x,y,z]`(浮点)、`yaw`(水平朝向)、`pitch`(俯仰)、`health`、`food`、`on_ground`、`dimension`、`source="authoritative"`、`observed_tick`、`obs_seq`。
- **`blocks[]` 每项**:`pos[x,y,z]`(整数)、`block`(方块 id)、`source`、`observed_tick`、`obs_seq`。
- **`entities[]` 每项**:`id`、`type`、`hostile`(是否敌对)、`projectile`(是否弹射物)、`pos`(浮点)、`source`、`observed_tick`。
- **`inventory[]` 每项**:`slot`、`item`、`count`。

### 3.5 `GET /events` —— 增量拉取世界事件

**用途**:低开销地跟踪**方块变化(破坏与放置)**;也供独立验收器直接判定。

**入参**(query):
| 参数 | 含义 |
|---|---|
| `epoch` | 客户端持有的纪元(默认当前) |
| `seq` | 从该序号**之后**拉(默认 0) |
| `max` | 本页最多多少条(1..2048,默认 256) |

**出参**:
| 字段 | 含义 |
|---|---|
| `epoch` | 当前纪元 |
| `reset_required` | true=必须重置(纪元变了,或落后出保留窗口);此时 `events` 为空 |
| `cursor.epoch` / `cursor.seq` | 下一页应从这继续(存下来下次带上) |
| `has_more` | 是否还有更多 |
| `events[]` | 每项:`seq`、`tick`、`type="block_changed"`、`pos`、`before`、`after`、`actor` |

### 3.6 `GET /tags` —— 官方标签表(权威)

**用途**:"按族匹配"(如 `#minecraft:logs`、各 `#*_ores`),避免手写分类法。

**入参**:无。

**出参**:`server_tick`、`blocks{ 标签id → [方块id...] }`、`entities{ 标签id → [实体id...] }`(直接从注册表生成)。

### 3.7 事件模型(epoch / seq / tick / actor)

- **tick**:游戏刻;所有事实/事件都带它,用于"同一时刻"对齐与超时对账。
- **seq**:事件单调序号;用于增量拉取。
- **epoch**:每次服务器启动 +1 并清空事件;消费者见到 epoch 变 = 重置游标。
- **actor**:谁做的(破坏/放置的玩家名);用于**归因**(self/foreign)与独立验收。

---

## 4. 端口契约(适配器实现的接口)

`packages/contracts/src/ports.ts` 定义了两个端口;`adapters/*` 各实现一个。**换控制/观测后端 = 换这两个端口的实现,上层全不动。**

### 4.1 `WorldPort` —— 观测(只读)接口

| 方法 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `status()` | — | `MaybeFact<SelfState>` | 自身状态(位置/血/饥/朝向/维度) |
| `entities(opts?)` | `{radius?}` | `MaybeFact<EntityFact[]>` | 附近实体(含 hostile/projectile) |
| `inventory()` | — | `MaybeFact<ItemStack[]>` | 背包 |
| `query(box, opts?)` | `box`;`{blockIds?,maxItems?}` | `MaybeFact<BlockCell[]>` | 区域内非空气方块 |
| `events(cursor?, max?)` | `{epoch,seq}`;`max` | `EventPage` | 增量事件 |
| `tags()` | — | `MaybeFact<TagTable>` | 官方标签表 |

> `MaybeFact<T>` = 值 + **来源**(authoritative/observed)+ 观测刻 + 覆盖信息;不完整/未加载 → **`unknown`**(不是"空")。

### 4.2 `ControlPort` —— 控制(玩家合法动作)接口

全部返回 `ControlReceipt`(`{accepted, level, note?}`,**原始回执,永不等于"成功判定"**)。

| 分组 | 方法(入参) | 用途 |
|---|---|---|
| 生命周期 | `connect()` / `disconnect()` | 连接/断开身体 |
| 移动 | `goto(pos, {range?,timeoutMs?,allowModify?})` | 走到某点附近(range 内);`allowModify`=允许寻路挖/放(默认否) |
| | `follow(entityId, distance, durationMs?)` | 跟随实体 |
| | `flee(entityId, distance, timeoutMs?)` | 远离实体 |
| | `lookAt(pos)` / `steer(controls[], durationMs)` | 看向 / 持续按键移动 |
| | `wait(ticks)` / `stopMotion()` | 等待 / 立即释放控制 |
| 方块 | `dig(pos)` / `place(pos, face, item?)` / `use(pos)` | 挖 / 放(参考面+物品)/ 激活方块 |
| 实体 | `attack(entityId, {weapon?,durationMs?})` / `interactEntity(entityId, item?)` / `useItemOn(item, {pos?,entityId?})` | 攻击 / 交互 / 对目标使用物品 |
| 背包 | `equip(item, dest?)` / `unequip(dest?)` / `drop(item,count)` / `transfer(item,count,{from,to,pos?})` / `consume(item)` / `useItem(item,releaseMs?)` | 装备/卸下/丢弃/转移/吃/蓄力使用 |
| 容器/生产 | `openContainer(pos)` / `closeContainer()` / `craft(item,count,tablePos?)` / `smelt(item,count,{fuel?,pos?})` / `enchant(item,choice,pos?)` / `anvilCombine(i1,i2,name?)` / `trade(entityId,index,times)` | 开窗/关窗/合成/熔炼/附魔/铁砧/交易 |
| 元 | `chat(message)` / `runCommand(command)` | 聊天 / 命令 |
| 客户端只读 | `raycast(maxDistance?)` / `lookupRecipe(item,table?)` / `worldInfo()` / `containerContents(pos)` / `canReach(pos,opts?)` / `canSee(pos)` | 准星目标/配方/世界信息/容器内容/可达/可见(observed) |

---

## 5. 各模块(由整体到局部)

### 5.1 `packages/contracts` —— 冻结类型(无第三方依赖)

**职责**:全系统共享的类型与端口定义。**公开 API = 类型**(不是函数):
`MaybeFact`/`isUnknown`、`Predicate`/`Tri`/`and/or/not`、`Target`/`Direction`/`compassFrom`、`ActionResult`、`ActionContract`、`Method`/`Step`/`SetExpr`、`SecondaryAction*`、`SkillNote`、`TaskSpec`、`WorldPort`/`ControlPort` 等。详见 §2.2 与设计文档。

### 5.2 `packages/foundation` —— 最小基础设施

**职责**:http / errors / config 这类外部能力的最小封装。**公开 API**:`http`(带超时的 GET/POST)、错误类型、配置读取。

### 5.3 `packages/world` —— 世界层(把端口事实变成可查询的世界答案)

**`World`(类)** —— 所有查询的入口。构造:`new World(port: WorldPort)`。

| 方法 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `status()` / `inventory()` / `entities(radius?)` | 见名 | `MaybeFact<...>` | 直接转发端口 |
| `selfPos()` | — | `Vec3 \| undefined` | 自身坐标(便捷) |
| `tagTable()` | — | `MaybeFact<TagTable>` | 官方标签表(取一次缓存) |
| `query(box, opts?)` | `box`;`{blockIds?,maxItems?,exposedOnly?}` | `MaybeFact<BlockCell[]>` | 区域原始查询 |
| `region(box, match?)` | `match` 可为 block/tag/any | `MaybeFact<BlockCell[]>` | 区域查询 + 按方块/标签过滤 |
| `blockAt(pos)` | `pos` | `MaybeFact<string>` | 单格方块(`air`=确认空;未观测=`unknown`) |
| `findNearestBlock(block, radius, around?)` | 方块 id;半径;中心(默认自身) | `MaybeFact<BlockHit\|null>` | 最近方块;截断→`unknown` |
| `exposedFaces(box)` | `box` | `MaybeFact<ExposedFace[]>` | 暴露面(表面壳元素) |
| `standableSurfaces(box)` | `box` | `MaybeFact<Vec3[]>` | 可站面(顶面接触空气且有支撑) |
| `connected(seed, match, opts?)` | 种子;匹配;`{bounded?,neighbor?,radius?}` | `MaybeFact<Component>` | 连通分量(如"一棵树") |
| `adjacentAir(pos)` / `support(pos)` / `hazardous(pos)` | `pos` | `MaybeFact<boolean>` | 关系(是否接触空气/有支撑/危险) |
| `events(cursor?, max?)` | 游标 | `EventPage` | 增量事件 |
| `discoveries` | — | `DiscoveryGraph` | 发现图(见下) |

**`SurfaceShell`(类)** —— 表面壳:只维护"接触空气的暴露面",由 resident 后台驱动。公开:`refresh(center)`(全刷)、`patch(pos)`(3×3×3 补丁)、`applyEvents(events)`、`size`、`windowCenter`。**它是控制/安全/断言的"新鲜权威来源"**。

**`DiscoveryGraph`(类)** —— 第二层地图(稀疏记忆,**仅规划、绝不作后置证据**)。公开:`record(entry)`、`get(id)`、`list(query)`、`markStaleBefore(now)`、`revalidate(id, now, stillThere)`、`forget(id)`、`toJSON()/fromJSON()`。条目字段:`kind`(resource/structure/waypoint/terrain)、`pos`、`label`、`source`(observed/inferred)、`observedTick`、`confidence`、`stale`。

**`objects.ts`** —— 对象聚合与 `view` 构造。公开:`aggregateObjects(cells, match, self, opts)`(把暴露连通同类方块聚成对象,算 size/中心·边缘距离/罗盘方位/touchable)、`buildView(cells, self, opts)`(裁剪到含方块的最小长方体;暴露面字母/内部`#`/黑雾`?`/玩家`@`)、`parseHandle/objectHandle/entityHandle`(句柄编解码)。

### 5.4 `packages/execution` —— 执行层

**`ControlToken`(类)**:**单身体互斥令牌**,`run(fn)` 保证同一时刻只有一个占身体的动作;同 async 上下文**可重入**(防嵌套死锁)。公开:`run<T>(fn)`。

**`ReflexShield`(类,L1)**:**唯一能拦截的一层**。公开:
- `precheck({effectClass, defensive})` → `{allow, reason?, threat?}`:**动作开始前**决定是否拒绝(读操作永远放行;防御性动作在濒死时也拒)。
- `monitor({defensive}, onViolation)` → `{stop()}`:**执行期**周期评估,发现违反安全不变量即回调。
- 配置 `ReflexConfig`:`hostileRadius`(默认 6)、`projectileRadius`(8)、`criticalHealth`(6)、`pollMs`(500)。

**`guardedRun(ctx, action, args)`**:**中心守卫执行**。公开函数。流程:reflex 预检查 → 读操作直接跑(不占令牌)→ 否则占令牌 + 开监视 + 硬超时(动作预算 + 5s,上限 90s)→ 执行 → 违反/超时则 `stopMotion` 并返回 `interrupted`。

**`executeAction(ctx, action, args)`(L3 契约引擎)**:**对外统一入口**。读操作直接 `guardedRun`;写操作:取执行前**因果邻域签名** → `guardedRun` → 取执行后签名 → **diff** → 若动作声明了 `verify`,用它判定并**对账**(超时/中断但效果已出现 → 判 `pass`)。

**`ALL_ACTIONS: AtomicAction[]` / `actionRegistry(): Map<string, AtomicAction>`**:全量原子动作(39)与其名字索引。

**`ActionContext`**:动作的运行环境,含 `world`、`ctrl`、`token`、`reflex?`、`shell?`。
**`AtomicAction`**:`{contract, run(ctx,args), scope?(ctx,args), verify?(ctx,args,win)}`;`contract(p)` 是构造契约的辅助。

### 5.5 `packages/tasks` —— 有界组合

**`runMethod(ctx, actions, method, opts?)`** —— **有界 runner**。
- 入参:`actions`(动作表)、`method`(`{steps, postconditions?, name?}`)、`opts`(`{args?, budget?(默认 4096 步), budgetMs?(默认 90s)}`)。
- 出参:`ActionResult`(聚合:`subResults[]`、`data.steps/elapsedMs/timedOut`;整体三态由**终止后置**或"无失败即通过"决定)。
- 用途:执行一段**声明式步骤清单**(非代码),可含 `sequence/for_each/repeat/branch`。

**`evalSet(ctx, set, vars)`** —— 求值一个集合表达式 → `Vec3[]`。支持:`members(handle)`/`surface(handle)`/`nearest(match)`/`area(anchor,size,offset)`/`set_difference`/`component`/`region`/`box_cells`。**每次现算**(目标条件化)。

**`evalPredicate(ctx, pred)`** —— 三值求值一个谓词 → `true|false|undefined`。主语支持 `block@x,y,z`/`inv:<item>`/`self.hp|food|on_ground`/`entity#<id>`/`obj:/ent:<handle>`。

**`resolveArg(arg, vars)` / `evalExpr(e, vars)`** —— 参数绑定(深解析 `{from:name}` 引用、`{expr}` 有界算术)。

**`tryAction(ctx, actions, library, name, opts?)`** —— 执行一个**二级动作**。
- 入参:`name`;`opts`(`{version?(不填=active), args?, budget?, budgetMs?, repair?, regression?}`)。
- 出参:`ActionResult`(带 `data.action={name,version}`),并把结果**记回库**(供门禁)。

### 5.6 `packages/knowledge` —— 二级动作库 + skill 文本

**`ActionLibrary`(类,二级动作库)** —— 公开方法:
| 方法 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `define(input)` | `{name,description?,params?,pre/post/invariants?,steps}` | `SecondaryActionVersion` | 登记**新版本**(draft) |
| `record(name, version, attempt)` | `attempt={outcome,repair?,regression?}` | — | 记一次在线结果 |
| `evaluate(name, version)` | — | `ActivationDecision` | **在线门禁**评估 |
| `activate(name, version)` | — | `ActivationDecision` | 评估并(通过则)启用;旧 active→superseded |
| `rollback(name, reason)` / `retire(name, reason)` | — | boolean | 回退 / 退役 |
| `summary()` / `list()` / `get(name)` / `active(name)` / `version(name,v)` / `history(name)` | — | 记录/摘要 | 发现与查询 |
| `toJSON()/fromJSON()/load(path)/save(path)` | — | — | 持久化 |

- **门禁默认阈值**:`minUses=3`、`minPassRate=0.6`、`recentWindow=5`、`minRecentPassRate=0.6`;另需"无净回归"。
- **状态机**:`draft → active → superseded / broken / retired`;回归或连续失败 → 系统标 `rollbackRequired`。

**`SkillLibrary`(类,skill 文本)** —— 公开:`write({name,description?,tags?,text})`、`get(name)`、`list()`、`search(query?)`、`remove(name)`、`toJSON/fromJSON/load/save`。**不可调用**。

### 5.7 `packages/interfaces/mcp` —— 工具面

**`ToolDef`**:`{name, title, description, inputSchema, handler(ctx,args)}`。
**`ToolRegistry`(类)**:`register(def)` / `unregister(name)` / `get(name)` / `has(name)` / `list()`。
**`buildTools(opts?)`**:返回工具数组。
- `opts.actionLibrary?` 存在则附二级动作工具;`opts.skillLibrary?` 存在则附 skill 工具。
- 内容:39 个一级动作 + `run_method`(+ 6 二级动作工具 + 3 skill 工具)。
**`secondaryActionToolDef(library, name)`**:把某 active 二级动作构造成**一等工具**(schema 由其 `params` 生成)。

### 5.8 `packages/adapters/*`

- **`adapters/telemetry`**:`TelemetryWorldPort implements WorldPort`(把观测 Mod 的 HTTP JSON → `MaybeFact`;截断/未加载→`unknown`)。
- **`adapters/mineflayer`**:`MineflayerControlPort implements ControlPort`(用协议客户端发玩家合法动作;`goto` 用 pathfinder;`place` 找参考面;`dig` 自动装最佳工具)。

### 5.9 `apps/agent` —— 装配与进程

- **`createContext(opts?)`** → `AppContext`:选适配器、建 `World`/`ControlToken`/`SurfaceShell`/`ReflexShield`/`ActionLibrary`/`SkillLibrary`、`buildTools()` 注册、起后台维护。`AppContext` 含 `world/ctrl/token/registry/toolCtx/actionLibrary/skillLibrary`。
- **`startResident()`** → `Resident`:起 Unix socket 服务;接受**多个**桥连接;维护**动态工具**(active 二级动作 ↔ 一等工具),变更时向所有连接发 `tools_changed`。公开:`{ctx, sockPath, close()}`。
- **`startBridge()`**:起 MCP stdio 服务;`tools/list`→resident、`tools/call`→resident;收到 `tools_changed`→发 `notifications/tools/list_changed`;断线**按需重连**。
- **`protocol.ts`**:桥↔常驻线协议(换行分隔 JSON):`ListReq/CallReq`(请求)、`ListRes/CallRes/ErrRes`(响应)、`ToolsChangedMsg`(通知)、`ToolSummary`、`socketPath()`。

---

## 6. 工具面(49 个,LLM 实际能调用)

> 一级动作的参数都用**语义 `Target`**(`object(句柄)|relative(罗盘)|block|entity|item|container|cell`);坐标默认**不引导**。

### 6.1 感知(13)
| 工具 | 用途 | 主要参数 | 返回要点 |
|---|---|---|---|
| `view` | 近处逐方块视野 | `radius`(默认8)、`height`(4) | 裁剪长方体:暴露面字母/内部`#`/黑雾`?`/玩家`@` + 可见对象句柄 |
| `scan_blocks` | 语义对象扫描 | `match`(block/tag/`any`)、`radius`(24) | 对象(句柄/size/中心·边缘距离/罗盘方位/touchable/reachable)+可互动/实体/液体 |
| `relations` | 兜底重确认 | `target` | 距离/touchable/reachable/LOS/adjacent_air/support/hazardous |
| `observe` | 自身+背包+实体概览 | — | 汇总 |
| `get_self_status` | 自身状态 | — | pos/血/饥/维度/on_ground |
| `get_inventory` | 背包 | — | `{item,count}[]` |
| `scan_entities` | 附近实体 | `radius`、`types` | 类型/方位/距离 |
| `find_nearest` | 最近某方块 | `block`、`within` | 方位/距离/是否够得着 |
| `raycast` | 准星目标 | `max_distance` | 方块/实体 |
| `inspect_container` | 读容器内容 | `target` | 物品列表 |
| `lookup_recipe` | 合成配方 | `item`、`table` | 结果/材料/是否需台 |
| `get_world_info` | 时间/天气/维度 | — | — |
| `recall` | 读记忆(仅规划) | `radius`、`kind` | 记忆条目(方位/距离/stale) |

### 6.2 移动(6)
`go_to(target,{range,allowModify})`、`follow(target,{distance,durationMs})`、`flee(target,{distance})`、`look_at(target)`、`wait({ticks})`、`steer({controls,durationMs})`。

### 6.3 方块(2)
`set_block({target, block, navigate?, allowModify?, face?})`(**两状态替换**:已是 B 跳过;air→放置;非 air→破坏+放置;B=air→破坏)、`use_block({target})`。

### 6.4 实体(3)
`attack({target})`、`interact_entity({target})`、`use_item_on({target, item})`。

### 6.5 背包(6)
`equip({item,destination?})`、`unequip({destination?})`、`drop({item,count})`、`transfer_item({item,count,from,to,pos?})`、`consume({item})`、`use_item({item,releaseMs?})`。

### 6.6 容器/生产(7)
`open_container({target})`、`close_container()`、`craft({item,count,table?})`、`smelt({item,count,fuel?,pos?})`、`enchant({item,choice,pos?})`、`anvil_combine({item1,item2,name?})`、`trade({target,index,times})`。

### 6.7 元(2)
`chat({message})`、`run_command({command})`。

### 6.8 编排(1)
`run_method({steps, postconditions?, args?, budget?, budgetMs?})`。

### 6.9 二级动作(6)
`define_action({name,steps,description?,params?,pre/post/invariants?})`、`list_actions({query?})`、`try_action({name,version?,args?})`、`activate_action({name,version?})`、`rollback_action({name,reason?})`、`retire_action({name,reason?})`。

### 6.10 skill 文本(3)
`write_skill({name,text,description?,tags?})`、`list_skills({query?})`、`read_skill({name})`。

---

## 7. 机制串讲(为什么这样设计)

- **证据优先**:所有判定基于**服务端权威事实**;客户端只读仅作补充(标记 observed)。
- **三态而非二值**:`unobservable`(真正弃权)与 `fail`(有证据没达成)分开,避免"没看到=失败"。
- **因果归因 + 超时对账**:区分"我造成的/别人造成的/未观测",并把"工具报超时但效果已发生"正确接受。
- **坐标下沉**:LLM 面向语义(句柄/名字/罗盘),坐标由程序解析;句柄每次使用**重校验**。
- **有界而非图灵完备**:组合词表受限 → 安全、可审计、可复现;每步都过契约引擎。
- **在线演进**:二级动作凭**真实使用证据**启用、凭**回归**回退;skill 文本沉淀方法论。

---

## 8. 里程碑与门槛

| 里程碑 | 内容 | Gate | 结果 |
|---|---|---|---|
| M0 | workspace + contracts + Kleene | — | ✅ |
| M1 | Mod 契约 / telemetry / mineflayer / world 最小 / execution 最小 / interfaces / apps | **G1** | ✅ 砍原木(背包 4→5,独立验收) |
| M2 | 通用查询 + 表面壳 + 两层地图 + L1/L3 + 有界词表 | **G2** | ✅ 挖矿脉 + 建结构 + 外部扰动局部修复 |
| M2.5 | 感知/寻址返工(句柄+罗盘+`view`/`scan_blocks`) | G1/G2 复验 | ✅ |
| M3 | 二级动作库(在线门禁/net-effect/回退)+ skill 文本 | **G3** | ✅ 定义→试用→门禁激活→回归→回退 |
| M4 | 动态注册 + `tools/list_changed` + 多会话 + 可视化 | **G4** | ✅ 49→50、list_changed、共享身体 |
| M5 | benchmark 装置 | GF | 🔶 装置完成 + 最小 GF(T1+T3×2:2/4) |

---

## 9. Benchmark(M5)

- `scenarios/`:`seeds.txt`(固定种子)、`tasks/{T1,T3}.json`(goal/budget/fixture/verifier)、`blueprints/`。
- `tests/eval/runner.mjs`:每 case:`reset-world(seed) → 假玩家放 fixture → 起 resident → headless opencode run(只给自然语言 goal)→ 独立验收 → 写 episode`。
- `tests/eval/verifiers/{t1,t3}.mjs`:直读观测 Mod 判定(不复用系统结论)。
- `tests/eval/metrics/report.mjs`:完成率 / 非 pass 三分 / 成本。
- `tools/bench.sh`:一键。

---

## 10. 运行 / 环境 / 脚本

```sh
pnpm build / pnpm test / pnpm smoke:tool          # tsc -b / vitest / 工具 smoke
tools/server-up.sh                                # Fabric 服务器 + 观测 Mod(:8765)
node apps/agent/dist/main-resident.js             # 常驻进程(连 bot 'Bot',socket)
tools/reset-world.sh <seed>                       # 硬种子重置
tools/bench.sh --tasks T1,T3 --seeds 5001,5002    # 一键 benchmark
node tests/eval/{g1,g2,g3}-verifier.mjs           # 独立验收器
tools/view-up.sh                                  # 调试可视化(俯视表面图)
tools/setup-bot.mjs ... cmd|dig|fixture|fixture-at  # 假玩家 fixture/扰动(不暴露给 agent)
```
环境变量:`MCAGENT_ACTIONS`(二级动作库路径)、`MCAGENT_SKILLS`(skill 文本库路径)、`MCAGENT_REFLEX=0`(关 L1)。

---

## 11. 文档索引

- `docs/mcp-implementation-framework.md` — 铁律、M0–M6+gate、契约、L0–L5、动作库、进程/Mod 契约、可视化。
- `docs/world-map-and-composition.md` — 表面壳/地图/通用查询/§12 感知与寻址/有界词表/拒绝的反模式。
- `docs/eval-benchmark.md` — 实机 benchmark(种子/任务/验收/指标/消融)。
- `docs/IMPLEMENTATION-STATUS.md` — 交接快照(压缩上下文后先读)。
- `docs/research/*` — 调研(07/15/13/11/14/04/06/02/16/17 优先)。
