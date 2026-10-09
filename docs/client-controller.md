# 客户端控制 Mod 适配层(Real-Client ControlPort)——设计

> 目标:让 agent **驱动一个真实打开的 Minecraft 客户端的本地玩家**(真实画面 + 原版 UI),
> 而**不是** headless mineflayer bot、也不是自研渲染器。
> 手段:**只替换 `ControlPort` 后端**;原子动作(一级)/ L1 reflex / L3 契约引擎 /
> `run_method` / 二级动作 / skill / 感知 **全部不变**。
> 日期:2026-10-10。

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
`{ ok, accepted, level, note?, result? }`(`accepted/level` 是**原始回执**,永不等于成功判定)。

| op | args | 语义 |
|---|---|---|
| `goto` | `pos[x,y,z], range?, timeoutMs?, allowModify?` | 走到某点附近(客户端 A* + 输入驱动) |
| `follow` | `entityId, distance, durationMs?` | 跟随实体 |
| `flee` | `entityId, distance, timeoutMs?` | 远离实体 |
| `lookAt` | `pos[x,y,z]` | 转向 |
| `wait` | `ticks` | 等待 N tick |
| `steer` | `controls[], durationMs` | 直接按键(逃生舱) |
| `stopMotion` | — | 立刻停:清输入 / 停导航 / 松开使用 |
| `dig` | `pos[x,y,z]` | 挖(自动换最佳工具,按 tick 推进破坏进度) |
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
- 每个任务带**墙钟预算**,到点即失败返回(防止卡死)。

### 5.3 移动 = 输入驱动(玩家合法)
不直接改速度/位置(服务端会拒绝)。用一个 `ControlledInput extends Input`(覆盖 `tick` 为
空),在每 tick 设置 `forwardImpulse/leftImpulse/jumping/shiftKeyDown`,由原版运动学驱动;
`lookAt/steer` 同理。**注意**:多人下本地玩家的跳跃不会从 `input.jumping` 自动生效,需显式
`LivingEntity.setJumping(true)`(公开 API),否则只会走不会跳。`stopMotion` 清零并 `releaseUsingItem`;
控制器只在有任务时接管输入,空闲时还原键盘输入(人类仍可操作)。

### 5.4 导航(A* + 走位)
`goto`:
1. 在客户端**已加载区块**上做**有界 A***:节点=脚部格;邻居=4/8 向;支持上台阶(≤1)、下落(≤3);
   要求目标列"脚+头两格可通行且下方有支撑";节点上限 + 距离上限;
2. 逐 tick 跟随路径:朝下一节点设 yaw + `forwardImpulse=1`,需要时 `jumping`;
3. 到达判定用**与 `GoalNear` 等价的 3D 距离**(块坐标欧氏距离 ≤ range),并要求**落地稳定**
   (onGround 连续 2 tick)才报告到达——否则 `go_to` 的后置会采样到下降途中的未稳定位置。
`follow/flee` 用同一导航:周期重算目标点。

### 5.5 交互原语(原版路径)
- `dig`:`gameMode.startDestroyBlock/continueDestroyBlock/stopDestroyBlock`,逐 tick 推进;
  先用 `ItemStack.isCorrectToolForDrops` 判断并自动换最佳工具。
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

- **导航**:客户端 A* 只覆盖已加载区块,且是"面向真实输入"的近似,不保证与
  mineflayer-pathfinder 同等鲁棒(卡住/绕远);`allowModify` 的"边走边挖/搭"暂不实现自动改造,
  仅记录。
- **生产类原语**依赖原版菜单机制,成功率受配方/材料/窗口时序影响,需实机校准。
- **反作弊/风控**:真实客户端 + 输入驱动 = 与真人一致的运动学,不注入特权动作。
- **多客户端**:一个客户端进程对应一个身体;要多个身体就多开客户端(端口需区分)。

---

## 9. 验证与运行(实机)

### 9.1 实机验证结论(2026-10-10)
在**真实 Fabric 1.20.1 客户端**(本地 profile `1.20.1-Fabric 0.19.5`,装了 fabric-api 0.92.12)
上,经常驻进程(`MCAGENT_CONTROL=client-mod`)**工具面不变(49 个)**跑通:
- `dig` → 观测 Mod 事件 `actor=Agent`(dirt→air),背包获得 dirt(**服务端权威**);
- `place` → 事件 air→dirt;
- `go_to` → `effect=pass`(权威自身位置,含上坡跳跃);
- `set_block`(原子动作 + 契约)→ `pass`,事件确认;
- `run_method` 组合可执行;
- 直接 HTTP:jump/steer/look_at/raycast/world_info/chat 均生效。

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
