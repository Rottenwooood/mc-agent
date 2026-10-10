# 客户端控制 Mod 适配层(Real-Client ControlPort)——设计

> 目标:让 agent **驱动一个真实打开的 Minecraft 客户端的本地玩家**(真实画面 + 原版 UI),
> 而**不是** headless mineflayer bot、也不是自研渲染器。
> 手段:**只替换 `ControlPort` 后端**;原子动作(一级)/ L1 reflex / L3 契约引擎 /
> `run_method` / 二级动作 / skill / 感知 **全部不变**。
> 日期:2026-10-10。
> **现状/设计问题复盘见 `docs/client-controller-review.md`(含仍不稳的部分与待拍板项)。**

---

## 1. 为什么不直接改上层

框架的分层把"身体"抽象成 `ControlPort`(`packages/contracts/src/ports.ts`)。上层
(执行引擎、工具面、二级动作库)只依赖这个接口。因此:

```
           ┌─────────────────── 上层完全不变 ───────────────────┐
           │  execution(L1/L3) · tasks · knowledge · interfaces/mcp │
           └───────────────────────┬───────────────────────────┘
                                   │ ControlPort
                 ┌─────────────────┴──────────────────┐
        MineflayerControlPort                 ClientModControlPort   ← 只换这里
        (协议客户端 bot)                       (真实客户端里的本地玩家)
```

- 观测(`WorldPort`)**继续走服务端只读观测 Mod**(权威事实),客户端 Mod 只补"客户端只读"
  (raycast / 配方 / 世界信息 / 可达 / 可见),这些本来就是 `ControlPort` 里的只读方法。
- 上层、benchmark、验收器、门禁**都不需要改**。

---

## 2. 合并:一个 mod,两个环境

原 `mods/server-observer` 是**服务端**只读观测 Mod;新能力是**客户端**控制。二者不冲突
(服务端 API vs 客户端 API,`environment` 不同),因此**合并为一个 mod**:

```
mods/mcagent/
├── src/main/java/com/mcagent/observer/     # 服务端:只读观测(原样,HTTP 8765)
├── src/client/java/com/mcagent/client/      # 客户端:本地玩家控制(新,HTTP 8766)
├── src/main/resources/fabric.mod.json       # environment "*" + main/client 两个 entrypoint
└── build.gradle                             # loom splitEnvironmentSourceSets()
```

- 用 `splitEnvironmentSourceSets()`:`main` 源集只在(集成的)服务端加载,`client` 源集只在客户端加载;
  专用服务器**不会**加载任何 `net.minecraft.client.*` 引用(不会被客户端类拖垮)。
- `fabric.mod.json`:`entrypoints.main` = 观测;`entrypoints.client` = 控制;`depends.fabric-api` 保留。
- 一个 jar 即可:丢服务端 → 只观测;丢客户端 → 只控制;单机 → 两者都跑。
- 目录/项目名从 `server-observer` 改为 `mcagent`,`tools/server-up.sh`、`tools/reset-world.sh`
  与文档同步更新。

---

## 3. 进程与通信

```
[真实 MC 客户端 + mcagent mod]  ──HTTP 127.0.0.1:8766──▶  [ClientModControlPort(TS)]
        │(本地玩家,原版交互)                                        │
        ▼                                                          ▼
   [MC 服务器] ◀── 原版包 ── 本地玩家                      [resident(单 body)]
        ▲                                                          │
        └──HTTP 127.0.0.1:8765── [服务端观测 Mod] ◀── [TelemetryWorldPort]
```

- 客户端 Mod 在客户端进程内起一个**本地 HTTP 服务**(默认 `127.0.0.1:8766`,可用系统属性
  `mcagent.control.port` / 环境变量 `MCAGENT_CONTROL_PORT` 覆盖),只监听回环。
- TS 侧新增 `@mc-agent/adapters-client-mod`,实现 `ControlPort`,把方法调用翻译成 HTTP。
- `apps/agent` 用环境变量 `MCAGENT_CONTROL=client-mod` 选择该后端(默认仍 `mineflayer`)。

---

## 4. 线协议(HTTP,JSON)

### 4.1 `GET /health`
存活与上下文。出参:`{ ok, mc, mod_version, in_world, player, dimension, screen, port }`。

### 4.2 `POST /action`
统一入口。请求:`{ "op": "<原语名>", "args": { ... } }`。

**控制类 op**(与 `ControlPort` 方法一一对应),响应:
`{ ok, accepted, level, note?, progress? }`(`accepted/level` 是**原始回执**,永不等于成功判定;
`progress` 见 §4.3)。

| op | args | 语义 |
|---|---|---|
| `goto` | `pos[x,y,z], range?, timeoutMs?, allowModify?` | 走到某点附近;**先走"不破坏"路径,无路才挖穿**;中途破坏的方块进 `progress.blocksBroken` |
| `follow` | `entityId, distance, durationMs?` | 跟随实体 |
| `flee` | `entityId, distance, timeoutMs?` | 远离实体 |
| `lookAt` | `pos[x,y,z]` | 转向 |
| `wait` | `ticks` | 等待 N tick |
| `steer` | `controls[], durationMs` | 直接按键(逃生舱) |
| `stopMotion` | — | 立刻停:清输入 / 停导航 / 松开使用 |
| `respawn` | — | 角色死亡后重生(救回来) |
| `dig` | `pos[x,y,z], breakThrough?` | 挖;**射线选"邻格是空气且有视线"的暴露面**;`breakThrough=true` 时先挖掉挡路块(隧道),`false` 时被挡即失败 `blocked_by` |
| `place` | `pos[x,y,z], face[x,y,z], item?` | 放置(参考面 + 可选物品) |
| `use` | `pos[x,y,z]` | 激活方块 |
| `attack` | `entityId, weapon?, durationMs?` | 攻击一段时间 |
| `interactEntity` | `entityId, item?` | 交互实体 |
| `useItemOn` | `item, pos? / entityId?` | 对目标使用物品 |
| `equip` | `item, destination?` | 装备(hand/head/torso/legs/feet/off-hand) |
| `unequip` | `destination?` | 卸下 |
| `drop` | `item, count` | 丢弃 |
| `transfer` | `item, count, from, to, pos?` | 背包↔容器搬移 |
| `consume` | `item` | 吃/喝 |
| `useItem` | `item, releaseMs?` | 使用物品(蓄力) |
| `openContainer` | `pos[x,y,z]` | 开容器 |
| `closeContainer` | — | 关容器 |
| `craft` | `item, count, tablePos?` | 合成 |
| `smelt` | `item, count, fuel?, pos?` | 熔炼 |
| `enchant` | `item, choice, pos?` | 附魔 |
| `anvilCombine` | `item1, item2, name?` | 铁砧 |
| `trade` | `entityId, index, times` | 交易 |
| `chat` | `message` | 聊天 |
| `runCommand` | `command` | 命令 |

**客户端只读 op**(标记 `observed`,永不作权威),响应 `{ ok, result: ... }`:

| op | args | result |
|---|---|---|
| `raycast` | `maxDistance?` | `{ block?{pos,name}, entity?{id,type} }` |
| `lookupRecipe` | `item, table?` | `[{result{item,count}, ingredients[{item,count}], requiresTable}]` |
| `worldInfo` | — | `{ time, raining, dimension }` |
| `containerContents` | `pos[x,y,z]` | `[{slot,item,count}]` |
| `canReach` | `pos, range?, allowModify?, timeoutMs?` | `bool` |
| `canSee` | `pos` | `bool` |

错误响应:`{ ok:false, error:"..." }`(HTTP 200;`ok` 字段为准,与观测 Mod 一致)。

### 4.3 响应中的进展(`progress`)
每个控制 op 的响应都带 `progress`(由 `ControlTask` 累计):
`{ blocksBroken: ["x,y,z", ...], moved: <推进的路径节点数>, phase: "<阶段>", elapsedMs }`。
- `blocksBroken` = 该任务**实际破坏**的方块(含挖穿时的挡路块);动作层把它转成
  `effects`(`block@x,y,z is air`)+ `evidence`,**即使任务最终失败也返回已有进展**(部分进展不丢)。
- 客户端只读 op 的响应是 `{ ok, result }`(无 `progress`)。

### 4.4 超时 = "无进展超时"(不是硬墙钟)
`ControlTask` 每次**有进展**(破坏方块 / 推进路径节点 / 换阶段)就刷新计时;只有
**连续无进展超过 `stallMs`** 才失败,失败信息为 `no progress for Ns`,并把累计 `progress` 一并返回。
另有一个很宽的绝对上限(300s)兜底,防止真死锁。
- "有进展"的口径由任务自定:`dig`/`goto` 只在**真正破坏方块或推进节点**时算进展(原地挖同一个
  方块不算);菜单/等待类任务每个 tick 都算进展(`autoProgress`),但它们内部另有界。

---

## 5. 客户端实现要点

### 5.1 线程模型
客户端世界/玩家只在**渲染线程**(client thread)可安全访问。HTTP 在独立线程池。因此:
每个请求 → 建 `CompletableFuture` → 用 `Minecraft.getInstance().execute(...)` 投到客户端线程
→ HTTP 线程带超时 `future.get(...)`。**永不跨线程直接碰世界状态。**

### 5.2 tick 驱动任务(长动作不能阻塞客户端线程)
`goto/dig/attack/smelt/...` 跨越很多 tick。实现为一个 **`ControlTask` 状态机**:
- 在 `ClientTickEvents.END_CLIENT_TICK` 里逐 tick `step()`;
- 完成后 complete 对应的 future(HTTP 线程随之返回);
- 单飞:同一时刻只允许一个控制任务(上层已有 `ControlToken` 串行化,这里再兜底);
- 超时是**无进展超时**(§4.4):每次进展刷新计时,只有连续无进展才失败,并把累计 `progress` 返回。

### 5.3 移动 = 输入驱动(玩家合法)
不直接改速度/位置(服务端会拒绝)。用一个 `ControlledInput extends Input`(覆盖 `tick` 为
空),在每 tick 设置 `forwardImpulse/leftImpulse/jumping/shiftKeyDown`,由原版运动学驱动;
`lookAt/steer` 同理。**注意**:多人下本地玩家的跳跃不会从 `input.jumping` 自动生效,需显式
`LivingEntity.setJumping(true)`(公开 API),否则只会走不会跳。`stopMotion` 清零并 `releaseUsingItem`;
控制器只在有任务时接管输入,空闲时还原键盘输入(人类仍可操作)。

### 5.4 导航(A* + 走位)
`goto`:
1. **优先不破坏**:先找 `allowModify=false` 的路径;只有找不到时才(在 `allowModify=true` 时)切到"挖穿"。
2. 有界 **加权 A***:节点=脚部格;邻居 4/8 向;上台阶≤1;`allowModify` 时下落≤1(大落要挖够不着的块),
   否则≤3;启发式 ×2.5(实心岩里 1× 启发式会爆);节点/距离上限。
3. 逐 tick 跟随:朝下一节点设 yaw + `forwardImpulse=1`;**只有落地且贴近节点才推进节点**,
   **只有落地且就在一级台阶前才跳**(否则会"原地乱蹦");`allowModify` 时先清"身体要过的整段体积"
   (自身列 + 目标列 + 斜向两角列,脚+头)。
4. 到达判定:块坐标 3D 距离 ≤ range,且**落地稳定**(onGround 连续 2 tick)。
5. **安全守卫**:拒绝踏入/坠入岩浆/火/岩浆块/仙人掌/营火/细雪(否则可能直接泡岩浆烧死)。

`follow/flee` 用同一导航:周期重算目标点。

### 5.5 交互原语(原版路径)
- `dig`(核心 `Digger`):每 tick 从眼睛向**目标中心**做射线:
  - 命中目标 → 挖目标(面=命中面);命中别的实心块 → 挖它(**隧道**,仅当 `breakThrough=true`);
  - 射线 miss(目标非实心,如草/花)→ 直接挖;
  - **面选择**:优先"邻格是空气 + 面心离眼睛最近 + 有视线"的暴露面;
  - 破坏进度**连续**:只在"目标块/面真的变了"时才重启 `start/continue`,**绝不按计时器重启**
    (否则永远挖不到底);
  - 明确失败:`out_of_reach` / `unbreakable` / `blocked_by` / `dig stalled`;
  - 每次破坏前用 `ItemStack.isCorrectToolForDrops` 自动换最佳工具;每破坏一块上报进展。
- `place/use/useItemOn`:`gameMode.useItemOn(player, MAIN_HAND, BlockHitResult)`;
  `place` 由参考面构造命中;先 `lookAt` 参考块。
- `attack`:`gameMode.attack` + `player.swing`;`interactEntity`:`gameMode.interact`。
- 背包/容器:走 `AbstractContainerMenu` + `gameMode.handleInventoryMouseClick`
  (`PICKUP/QUICK_MOVE/SWAP/THROW`);`equip` 优先直接改 `inventory.selected`。
- 生产(`craft/smelt/enchant/anvilCombine/trade`):打开对应菜单,用
  `handlePlaceRecipe` / 槽位点击 / `handleInventoryButtonClick` / 重命名等原版机制完成。
- `chat/runCommand`:`connection.sendChat/sendCommand`。

### 5.6 只读
`raycast`:`level.clip(...)` + `level.getEntities`(视线内最近实体);`worldInfo`:`level.getDayTime`
/ `level.isRaining` / 维度;`containerContents`:开菜单读 `getItems()`(只读后关闭);
`canReach`:用导航 A* 判定;`canSee`:`level.clip` 到目标无遮挡。

---

## 6. 映射核对(ControlPort → op)

`ControlPort` 的 28 个方法 + 6 个只读方法 = 34,全部有对应 op(见 §4.2)。TS 侧
`ClientModControlPort` 逐一实现;`connect()` = 轮询 `/health` 直到 `in_world`;`disconnect()` 空操作
(不主动踢客户端)。

---

## 7. 测试策略

1. **编译**:`./gradlew build`(main + client 两个源集)。
2. **TS 单测**:用本地 mock HTTP 服务器回放 wire 形状,断言 `ClientModControlPort` 的
   请求构造与响应解析(`tests/semantics` 风格),不需要真实客户端。
3. **真实客户端冒烟**(环境允许时):启动 Fabric 客户端 → `/health` 通过 → 做一条低风险
   动作(如 `worldInfo` / `lookAt` / `get_self_status` 经 resident)→ 独立核对。
4. 上层回归:同一套原子动作在 `MCAGENT_CONTROL=client-mod` 下跑既有 smoke。

---

## 8. 边界与已知限制(诚实记录)

- **导航**:`allowModify`(边走边挖)已实现(加权 A* + 清身体体积),但**远距离(30+ 格)挖穿到地下目标**
  仍不稳:搜索空间大、耗时长、执行中可能遇险(岩浆/坠落——现由守卫拦下,但会中断任务)。
- **危险检测**:目前只在 walker 里 ad hoc 判(岩浆/火/岩浆块/仙人掌/营火/细雪);**没有统一的安全
  不变量**(L1 reflex 只看敌对/弹射物/血量)。详见 `client-controller-review.md`。
- **证据分级**:`progress.blocksBroken` 是**客户端自报**,动作层目前把它当权威证据用——**这是错的**,
  应标 `observed`,或由服务端 observer 事件确认后才升 `authoritative`。
- **对象→格**:`resolveObject` 取"最近暴露格"是启发式;对矿脉/树"挖哪些格、按什么顺序"应交给组合
  (`members`/`for_each`)表达。
- **生产类原语**依赖原版菜单机制,成功率受配方/材料/窗口时序影响,需实机校准。
- **反作弊/风控**:真实客户端 + 输入驱动 = 与真人一致的运动学,不注入特权动作。
- **多客户端**:一个客户端进程对应一个身体;要多个身体就多开客户端(端口需区分)。

---

## 9. 验证与运行(实机)

### 9.1 实机验证结论(截至 2026-10-10)
在**真实 Fabric 1.20.1 客户端**上,经 resident(`MCAGENT_CONTROL=client-mod`)、**工具面不变(49 个)**:

**已验证**
- 启动 / 入服 / `/health`;感知(`scan_blocks`/`view`/`get_self_status`)经 resident。
- 走位(不破坏):短 / 中距离到达、**绕路(破坏 0 块)**、不蹦。
- 单块挖 / 放(`set_block`,服务端事件权威确认:`actor=Agent`);`go_to` / `set_block` 返回 `pass`。
- 合成链:木板 → 木棍 → 工作台 → 木镐(全部 `pass` + 背包增量)。
- **正确工作流**:`scan_blocks` → `go_to` 到大致位置 → `run_method(for_each members(handle) → set_block(air))`
  挖一棵树(7 成员 4 成 3 败,返回每步判定 + 拿到原木)。

**实机中发现并修复的真实缺陷**:多人下 `jumping` 需 `setJumping`;破坏进度被计时器清零(永远挖不到底);
同一 tick 连发菜单点击 desync;选到材料不满足的配方;开工作台后菜单槽位偏移;`scan_blocks` 裸字符串
`match` 被静默当 `"any"`;`resolveObject` 不选暴露格;walker 乱蹦(空中推进节点/远处起跳);隧道把角色
带进岩浆。

**仍不稳**:远距离挖穿到地下矿脉(见 §8)。

上层(执行引擎 / L1 reflex / L3 契约 / 工具面 / 二级动作 / skill / 感知)**零改动**。

### 9.2 运行
```sh
# 1) 起服务端(合并后的单 mod:只读观测)
tools/server-up.sh

# 2) 构建+安装 mod 到客户端 profile 并启动(自动连 127.0.0.1:25565)
tools/client-up.sh
#   或分步:tools/client-up.sh --install-only; node tools/launch-client.mjs --server 127.0.0.1:25565

# 3) 以真实客户端为身体跑 agent
MCAGENT_CONTROL=client-mod MC_USER=<客户端玩家名> node apps/agent/dist/main-resident.js
```
- 端口:观测 8765;控制 8766(`MCAGENT_CONTROL_PORT`)。
- 客户端 mod 依赖 **fabric-api**(`tools/fetch-fabric-api.mjs` 从 Modrinth 拉取)。

### 9.3 只读 mock 测试
`tests/semantics/client-mod-adapter.test.ts`:起本地 mock HTTP 回放 wire 形状,断言适配器的
请求构造 / 回执 / 结果 / 错误 / `connect()` 轮询——无需真实客户端。
