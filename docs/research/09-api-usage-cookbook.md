# 09 · 原子动作 API 使用手册(Mineflayer 控制 + Fabric 特权观测)

> 约定(按你的决定):
> **控制层 = Mineflayer(只做玩家合法动作;切模式/输命令可以,但不能绕过玩家直接改世界)。**
> **观测层 = 自研 Fabric 服务端 Mod(只读特权信息:方块/NBT/实体/结构/事件/区域标记)。**
> 本手册给**签名 + 说明 + 最小可用示例**;完整逐条见 `sources/apis/mineflayer-api.md`(85KB 官方)。
> 核查日期:2026-10-05。

---

## 0. 有头 vs 无头,以及视觉怎么来

事实:
- **Mineflayer 是协议客户端,自身无画面**(headless)。
- 视觉/可视化有两条独立路径,由 `prismarine-viewer` 提供:
  1. **`mineflayer` 模式(浏览器窗口即"有头")**:`mineflayerViewer(bot,{port,firstPerson})` 起一个 web 服务,
     浏览器看 bot 第一/第三人称视角;可 `bot.viewer.drawLine(...)` 画路径/标记。
  2. **`headless` 模式(渲染成帧,喂给 VLM)**:`headless(bot,{output,width,height,frames})`
     把 bot 视角渲染到 **mp4 文件或 TCP 流**(可接 Python)。
- 另有 `standalone`(只看世界)、`exporter`(导出截图/3D 模型)、`web_client`(浏览器版 MC 客户端)。

**结论与推荐**:
- **控制保持 Mineflayer 无头**(动作空间=协议上限,部署灵活,和 Voyager 一致)。
- **给人看** → `prismarine-viewer` 的 `mineflayer` 浏览器模式(有头窗口,但不是原版引擎渲染)。
- **给 VLM 看** → `prismarine-viewer` 的 `headless` 模式输出帧/TCP(无需真实客户端)。
- 只有当你需要**原版材质/光影/模组画面**时,才需要**真实 Minecraft 客户端**;但那时控制侧就变成"客户端内 mod",
  不再是无头 Mineflayer,且每个实例要占一个客户端/GPU。**不建议首版走这条**。
- 真实客户端也可**作为旁观者**连入看 Mineflayer bot(第三人称),(Voyager 也允许这么做)。

---

## 1. 连接与生命周期

```js
const mineflayer = require('mineflayer')
const bot = mineflayer.createBot({
  host: 'localhost', username: 'Bot', auth: 'offline',   // 离线测试服
  // version: '1.21.1', port: 25565,
})
```
- `createBot(options)` → 建连;`auth:'offline'|'microsoft'`。
- `bot.on('spawn',fn)` 首次进入世界;`'respawn'` 重生;`'death'` 死亡;`'health'` 血量变化;`'kicked'/'end'/'error'`。
- `bot.end(reason)` / `bot.quit(reason)` 退出;`bot.respawn()` 手动重生。
- 说明:先等 `spawn` 再动作;`bot.entity.position` 是当前位置(Vec3)。

---

## 2. 移动与视角(玩家合法)

| 签名 | 说明 |
|---|---|
| `bot.setControlState(control, state)` | 设置移动键;`control∈{forward,back,left,right,jump,sprint,sneak}`,持续生效直到改回 |
| `bot.getControlState(control)` / `bot.clearControlStates()` | 查询/清空所有移动键 |
| `bot.look(yaw, pitch, force?)` | 设朝向(弧度);`force` 时不限转视角速度 |
| `bot.lookAt(point, force?)` | 看向世界坐标点(Vec3) |
| `bot.waitForTicks(n)` | 等待 n 个 tick(20/s) |
| `bot.moveVehicle(left, forward)` | 驾驶载具 |
| `bot.mount(entity)` / `bot.dismount()` / `bot.elytraFly()` | 骑乘/下马/鞘翅 |

示例(向前走 1 秒再停):
```js
bot.setControlState('forward', true)
bot.setControlState('sprint', true)
await bot.waitForTicks(20)
bot.clearControlStates()
```
> 说明:细粒度移动由 `prismarine-physics` 客户端模拟;要"走到某点"用 §3 pathfinder,不要手搓按键。

---

## 3. 寻路(插件 `mineflayer-pathfinder`)

```js
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
bot.loadPlugin(pathfinder)
const mcData = require('minecraft-data')(bot.version)
const moves = new Movements(bot, mcData)
moves.allowParkour = true; moves.allowSprinting = true; moves.canDig = false
bot.pathfinder.setMovements(moves)
```
| 签名 | 说明 |
|---|---|
| `pathfinder.setGoal(goal, dynamic?)` | 设定目标并开始走;`dynamic=true` 时目标随实体移动更新 |
| `pathfinder.goto(goal):Promise` | 同上但返回 Promise,便于 await |
| `pathfinder.stop()` | 停止;`isMoving()/isMining()/isBuilding()` 查状态 |
| `pathfinder.bestHarvestTool(block)` | 选最合适的工具 |
| `pathfinder.getPathTo(movements,goal,timeout?)` | 只算路不执行,返回 `ComputedPath`(含 cost/path/status) |

**Goal 类型**(`goals.*`):`GoalBlock(x,y,z)`、`GoalNear(x,y,z,range)`、`GoalXZ(x,z)`、
`GoalNearXZ(x,z,range)`、`GoalY(y)`、`GoalGetToBlock(x,y,z)`、`GoalCompositeAny/All([...])`、
`GoalInvert(goal)`、`GoalFollow(entity,range)`、`GoalPlaceBlock(pos,world,opts)`、`GoalLookAtBlock(pos,world,opts)`、`GoalBreakBlock(pos,world,opts)`。

示例(走到坐标附近 2 格):
```js
await bot.pathfinder.goto(new goals.GoalNear(100, 64, 200, 2))
```
**Movements 关键开关**:`canDig`、`canOpenDoors`、`allow1by1towers`、`allowParkour`、`allowSprinting`、
`allowFreeMotion`、`scafoldingBlocks`、`maxDropDown`、`digCost/placeCost`、`blocksToAvoid/blocksCantBreak`、
`exclusionAreasStep/Break/Place`(禁区/加权)。
事件:`goal_reached`、`path_update`、`path_reset(reason)`、`path_stop`。
> 拟人化:官方提供 `createHuman(bot)`(`walkTo/lookAt/stop`),鼠标式转头、随机扫视,适合"拟人"。

---

## 4. 挖掘

| 签名 | 说明 |
|---|---|
| `bot.dig(block, forceLook?, digFace?)` | 挖方块;`digFace` 可为 `'auto'|'raycast'|Vec3`;返回 Promise(完成或失败) |
| `bot.stopDigging()` | 中止当前挖掘 |
| `bot.digTime(block)` | 预估挖掘耗时(ms) |
| `bot.canDigBlock(block)` | 是否可挖(在范围内且非空气等) |
| `bot.targetDigBlock` | 当前正在挖的方块 |

事件:`diggingCompleted(block)`、`diggingAborted(block)`、`blockBreakProgressObserved/End`。
示例:
```js
const b = bot.blockAt(new Vec3(10,63,10))
if (b && bot.canDigBlock(b)) await bot.dig(b)
```

---

## 5. 放置 / 方块交互 / 实体交互

| 签名 | 说明 |
|---|---|
| `bot.placeBlock(referenceBlock, faceVector)` | 在 `referenceBlock` 的 `faceVector` 面上放当前手持方块 |
| `bot.placeEntity(referenceBlock, faceVector)` | 放置实体(如船/矿车),返回实体 |
| `bot.activateBlock(block, direction?, cursorPos?)` | 右键方块:开门、按钮、拉杆、开箱等 |
| `bot.activateEntity(entity)` / `bot.activateEntityAt(entity,pos)` | 右键实体(交易/骑乘/命名) |
| `bot.useOn(targetEntity)` | 对实体使用手持物品 |

示例(在土块上放石头):
```js
const ref = bot.blockAt(new Vec3(10,63,10))
await bot.equip(bot.registry.itemsByName.stone.id, 'hand')
await bot.placeBlock(ref, new Vec3(0,1,0))   // 放在 ref 上面
```

---

## 6. 物品使用 / 战斗

| 签名 | 说明 |
|---|---|
| `bot.activateItem(offHand=false)` | 开始使用手持物品(蓄力弓、喝药、抛掷);需配合 `deactivateItem()` 释放 |
| `bot.deactivateItem()` | 松开/结束使用 |
| `bot.consume()` | 吃/喝当前手持食物,返回 Promise |
| `bot.fish()` | 抛竿钓鱼 |
| `bot.attack(entity, swing=true)` | 近战攻击 |
| `bot.swingArm(hand?, showHand?)` | 挥手臂(动画,不造成伤害) |
| `bot.getExplosionDamages(entity,pos,radius,raw?)` | 估算爆炸伤害 |
| `bot.updateSign(block,text,back?)` / `bot.writeBook(slot,pages)` | 写告示牌/书 |

示例(拉弓 1 秒后放):
```js
await bot.equip(bot.registry.itemsByName.bow.id,'hand')
bot.activateItem(); await bot.waitForTicks(20); bot.deactivateItem()
```

---

## 7. 背包与装备

| 签名 | 说明 |
|---|---|
| `bot.equip(item|itemId, destination)` | 装备到 `hand/head/torso/legs/feet/off-hand` |
| `bot.unequip(destination)` | 卸下 |
| `bot.setQuickBarSlot(slot)` / `bot.quickBarSlot` | 切快捷栏 |
| `bot.toss(itemType, metadata, count)` / `bot.tossStack(item)` | 丢弃 |
| `bot.heldItem` / `bot.inventory`(Window) | 手持物/背包窗口 |
| `bot.transfer({window,itemType,metadata,count,sourceStart,sourceEnd,destStart,destEnd})` | 批量搬移 |
| `bot.clickWindow(slot,mouseButton,mode)` / `bot.moveSlotItem(src,dst)` / `bot.simpleClick.leftMouse(slot)` | 底层槽位点击 |

示例(吃背包里的熟牛排):
```js
const food = bot.inventory.items().find(i => i.name==='cooked_beef')
await bot.equip(food,'hand'); await bot.consume()
```

---

## 8. 容器 / 菜单 / GUI

| 签名 | 说明 |
|---|---|
| `bot.openContainer(block|entity, dir?, cursorPos?)` | 通用打开,返回 `Window` |
| `bot.openChest` / `openFurnace` / `openDispenser` / `openEnchantmentTable` / `openAnvil` / `openVillager` | 类型化窗口 |
| `bot.openBlock(block)` / `bot.openEntity(entity)` | 底层打开 |
| `window.deposit(itemType,metadata,count[,nbt])` / `window.withdraw(...)` | 存/取(Container 系) |
| `furnace.putInput/putFuel/takeOutput/takeInput/takeFuel()` | 熔炉操作 |
| `enchantmentTable.putTargetItem/enchant(choice)/takeTargetItem()` | 附魔 |
| `anvil.combine(itemOne,itemTwo[,name])` / `rename(item[,name])` | 铁砧 |
| `villager.trades` / `bot.trade(villager,tradeIndex,times?)` | 交易 |
| `bot.closeWindow(window)` | 关闭 |

事件:`windowOpen(window)`、`windowClose(window)`、`window 'updateSlot'(slot,old,new)`。
示例:
```js
const chest = await bot.openChest(bot.blockAt(pos))
await chest.withdraw(bot.registry.itemsByName.coal.id, null, 8)
await chest.close()
```

---

## 9. 合成

| 签名 | 说明 |
|---|---|
| `bot.recipesFor(itemType, metadata, minResultCount, craftingTable)` | 查可用配方(`craftingTable` 可为方块/`true`/`null`) |
| `bot.recipesAll(itemType, metadata, craftingTable)` | 所有配方(忽略材料是否够) |
| `bot.craft(recipe, count?, craftingTable?)` | 合成;自动取材/摆放工作台,返回 Promise |

示例(做 1 个木镐):
```js
const { itemsByName } = bot.registry
const recipes = bot.recipesFor(itemsByName.wooden_pickaxe.id, null, 1, null)
if (recipes.length) await bot.craft(recipes[0], 1, null)
```

---

## 10. 感知:查询(仅"服务器发给你"的信息)

| 签名 | 说明 |
|---|---|
| `bot.blockAt(point, extraInfos?)` | 该坐标方块(未知返回 null) |
| `bot.blockAtCursor(maxDist?)` / `bot.blockAtEntityCursor(entity?,maxDist?)` | 准星/实体视线所指方块 |
| `bot.blockInSight(maxSteps,vectorLength)` | 沿视线找方块 |
| `bot.canSeeBlock(block)` | 是否有视线 |
| `bot.findBlock({matching,maxDistance,count?,point?,useExtraInfo?})` | 找最近匹配方块 |
| `bot.findBlocks({...})` | 找多个(返回 Vec3[]) |
| `bot.nearestEntity(filter?)` / `bot.entityAtCursor(maxDist?)` | 最近实体/准星实体 |
| `bot.entities` / `bot.players` / `bot.entity` | 已同步实体/玩家/自己 |
| `bot.waitForChunksToLoad()` | 等区块加载 |
| `bot.time` / `bot.game.dimension` / `bot.isRaining` / `bot.health` / `bot.food` | 环境/自身 |
| `bot.scoreboards` / `bot.teams` / `bot.tablist` | 计分板/队伍/玩家列表 |

事件(用于断言):`blockUpdate`、`blockEntityData`、`chunkColumnLoad/Unload`、
`entitySpawn/Gone/Moved/Update/Hurt/Dead`、`soundEffectHeard`、`particle`、`pistonMove`、`chestLidMove`、`itemDrop`、`playerCollect`。
```js
bot.on('blockUpdate', (oldB, newB) => { /* 断言: 方块是否变成预期 */ })
```

---

## 11. 聊天 / 命令(你说的"切模式、输命令"走这里)

| 签名 | 说明 |
|---|---|
| `bot.chat(msg)` | 发聊天/命令:`bot.chat('/gamemode creative')`(需权限) |
| `bot.whisper(user,msg)` | 私聊 |
| `bot.awaitMessage(...pat):Promise` | 等特定消息(可做断言) |
| `bot.chatAddPattern(pattern,type,desc)` / `addChatPatternSet` | 自定义消息模式 |
| `bot.tabComplete(str,assumeCommand?)` | 命令补全 |

> 注意:命令由服务端权限裁决(是否 op);这仍是"玩家路径",符合你的约束。

---

## 12. 原始协议逃生舱(仍限玩家合法包)

```js
bot._client.write('arm_animation', { hand: 0 })          // 发任意原版包
bot._client.on('packet', (data, meta) => { /* 任意包 */ })
bot._client.writeChannel('my:channel', { ... })           // 自定义 plugin channel
```
> 用途:高层没封装的动作;或自定义 Mod 通道(与你的 Fabric 观测 Mod 通信可用它)。
> 约束:只能发**客户端合法**的包;服务端仍会校验/拒绝。

---

## 13. 特权观测:Fabric 服务端 Mod(只读,官方文档已核)

> 只观测、不改世界。全部通过 Fabric API 事件 + 服务端只读查询 + 自定义网络回传。

### 13.1 事件(Fabric API)
| API | 说明 |
|---|---|
| `ServerLifecycleEvents.SERVER_STARTING/STARTED/STOPPING` | 服务器生命周期 |
| `ServerTickEvents.START_SERVER_TICK/END_SERVER_TICK` | 每 tick;用于采样/监视 |
| `ServerPlayConnectionEvents.JOIN/DISCONNECT` | 玩家进出 |
| `ServerEntityEvents.ENTITY_LOAD/UNLOAD` | 实体加载/卸载 |
| `ServerBlockEntityEvents.BLOCK_ENTITY_LOAD/UNLOAD` | 方块实体加载 |
| `ServerChunkEvents.CHUNK_LOAD/UNLOAD` | 区块加载 |
| `AttackBlockCallback` / `UseBlockCallback` / `UseEntityCallback` | 攻击/使用方块/实体回调(可读参与方与目标,用于归因) |
| `PlayerBlockBreakEvents.AFTER` | 方块被破坏后(可归因到 player) |
| 说明 | 官方文档:`docs.fabricmc.net/develop/events/`;缺的钩子用 Mixin 自建 |

### 13.2 只读世界/实体查询(服务端类,Mojang 映射,编码前按 mappings 核对)
```java
ServerLevel level = player.serverLevel();
BlockState st = level.getBlockState(new BlockPos(x,y,z));   // 方块状态
BlockEntity be = level.getBlockEntity(pos);                  // 方块实体
CompoundTag nbt = be == null ? null : be.saveWithFullMetadata(level.registryAccess()); // NBT(只读)
List<Entity> ents = level.getEntitiesOfClass(Entity.class, aabb); // 范围实体
boolean loaded = level.isLoaded(pos);                        // 是否已加载(未加载=未知)
// 结构/生物群系/战利品表 等只读查询: level.getStructureManager() / level.getBiome() / ...
```
> 只读 API 用于把"服务端真值"喂给断言;`isLoaded` 必须显式处理为 `unknown`。

### 13.3 网络回传(与 Python/Node 主程序通信)
```java
public record SnapshotPayload(BlockPos pos, int blockId) implements CustomPacketPayload {
  public static final Type<SnapshotPayload> TYPE = new Type<>(ExampleMod.id("snapshot"));
  public static final StreamCodec<RegistryFriendlyByteBuf, SnapshotPayload> CODEC = /* composite */;
  @Override public Type<? extends CustomPacketPayload> type(){ return TYPE; }
}
PayloadTypeRegistry.clientboundPlay().register(SnapshotPayload.TYPE, SnapshotPayload.CODEC);
ServerPlayNetworking.send(player, payload);      // 发给控制端(可发给你自己的客户端/代理)
ServerPlayNetworking.registerGlobalReceiver(...)  // 收控制端请求
```
> 说明:也可用 HTTP(Mod 内嵌小 HTTP server 暴露只读快照),`minecraft-framework.md` 即用此路线。

### 13.4 持久化(区域标记等)
- `SavedData`(每世界/每维度持久化)、`Data Attachment`(挂到实体/方块实体)。
- 官方文档:`docs.fabricmc.net/develop/serialization/saved-data`、`/data-attachments`。

### 13.5 菜单观测
- `AbstractContainerMenu.slots`(只读遍历)、`MenuProvider`、`player.containerMenu`;
- 用于断言"箱子/熔炉里现在有什么",而不需要 Mineflayer 的窗口(可由 Mod 直接读)。

---

## 14. 原子动作 ↔ 断言 的映射建议

| 原子动作(Mineflayer) | 动作后可选断言(数据源) |
|---|---|
| `dig(block)` | Mineflayer `blockUpdate`/`diggingCompleted` + Fabric 读该坐标方块变 air |
| `placeBlock(ref,face)` | Fabric 读目标坐标方块=预期 state |
| `craft(recipe,count)` | 背包窗口 delta + Fabric 只读菜单/物品 |
| `openChest/withdraw` | `window 'updateSlot'` + Fabric 读方块实体 NBT |
| `attack(entity)` | `entityHurt/entityDead` + Fabric 读实体血量 |
| `equip(item,dest)` | `heldItemChanged` + Fabric 读装备槽 |
| `goto(goal)` | `goal_reached` + Fabric 读玩家坐标(权威) |
| `chat('/cmd')` | `awaitMessage`/`message` + Fabric 读服务端状态变化 |

> 原则:**动作反馈用控制端(Mineflayer)事件,判定用 Fabric 服务端真值**;两者用统一动作 id 关联。

---

## 15. 与 Voyager 的对照(实现参考)

Voyager 的栈(**证据**:`sources/apis/voyager-README.md` L100-104 + `voyager-fabric_mods_install.md`):
- 控制:**Mineflayer**(与我们的控制层一致)。
- 技能:存为**可执行 JS 代码**(不是参数化模板),按描述检索复用。
- 循环:自动课程 + 迭代提示(环境反馈/执行错误/自我验证)。
- 服务端/实验条件:装了 Fabric mods(Fabric API、Mod Menu、Complete Config、**Multi Server Pause**、Better Respawn);
  **Multi Server Pause 在等 GPT-4 时暂停服务器**;
  README **明确要求 Game Mode = `Creative`、Difficulty = `Peaceful`、Allow cheats = `ON`**,并 open to LAN。
- 可视化:官方生态用 `prismarine-viewer`。

**公平性结论(重要)**:Voyager 的"生存"评测实际运行在 **Creative + cheats + 暂停** 下,
**与我们的"生存模式、无 cheats、不暂停"不可直接比较**;任何对比必须匹配环境,或明确报告差异。
**可借鉴**:动作原语的封装方式、技能的描述+检索、环境反馈喂给 LLM。
**要改进**:用**程序化断言(本手册 §14)**替代 Voyager 的 LLM 自我验证;技能用**带前置/后置的参数化技能**而非裸 JS;
不依赖 Creative/cheats/暂停/传送。

---

## 16. 来源与验证台账

| 项 | 状态 | 来源 |
|---|---|---|
| Mineflayer 签名/语义 | verified-real | 官方 `docs/api.md`(副本 `sources/apis/mineflayer-api.md`) |
| Mineflayer 类型面 | verified-real | 官方 `index.d.ts` |
| pathfinder Goals/Movements | verified-real | 官方 `index.d.ts` |
| 原始协议逃生舱 | verified-real | 官方 `minecraft-protocol` `index.d.ts` |
| prismarine-viewer 用法(含 headless 出帧) | verified-real | 官方 README(副本) |
| Voyager 栈 / 暂停 mod / **Creative+cheats 实验条件** | verified-real | `sources/apis/voyager-README.md`(L100-104)+ `voyager-fabric_mods_install.md` |
| Fabric 事件/网络/菜单 | verified-real | docs.fabricmc.net |
| Fabric 只读世界查询类名/方法 | **待用 Yarn/Mojang mappings 逐条核对** | 1.21.x 通行类名 |
