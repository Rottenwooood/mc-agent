# 08 · 控制后端 API 能力对比:Mineflayer(客户端协议) vs Fabric 服务端

> 目的:回答"两种方式各能实现什么、Mineflayer 的抽象是否限制动作空间",为原子动作设计提供依据。
> 权威来源:Mineflayer 官方 `index.d.ts`(完整 API 面)、`mineflayer-pathfinder` `index.d.ts`、
> `minecraft-protocol` `index.d.ts`;Fabric 官方文档(Events / Networking / Container Menus);
> Minecraft 服务端类(Mojang 官方映射,1.21.x)。副本存 `sources/apis/`。
> 核查日期:2026-10-05。

## 0. 先厘清:控制层与观测层是两件正交的事

`minecraft-framework.md` 的"完整模式"= **Mineflayer 控制 + Fabric Mod 观测**。要对比的两条路是**控制层**:

| 控制层方案 | 谁执行动作 | 特权观测从哪来 |
|---|---|---|
| **A. Mineflayer(客户端协议)** | 一个真实协议客户端发原版包 | 另装 Fabric 观测 Mod(或仅靠客户端可见信息) |
| **B. Fabric 服务端(fake/服务器玩家)** | 服务端直接调 Minecraft API | 本就在服务端,天然全量 |
| A′. 混合 | Mineflayer 控制 | Fabric 观测(即 framework 完整模式) |

**观测层**两方案都能挂 Fabric Mod;差别在**控制动作如何产生**。下面分别列全。

---

## 1. 方案 A:Mineflayer(客户端协议控制)完整 API

来源:官方 `mineflayer/index.d.ts`(912 行)。分组列举(括号为实际方法/字段名)。

### 1.1 生命周期与状态
- 建连/断开:`createBot`、`connect`、`end`/`quit`、`respawn`、`spawn`/`spawnReset`。
- 状态:`bot.entity`、`game`(dimension/gameMode/difficulty/levelType/hardcore/maxPlayers/serverBrand)、
  `time`、`isRaining`/`thunderState`、`health`、`food`/`foodSaturation`、`oxygenLevel`、
  `experience`(level/points/progress)、`abilities`(flying/mayFly/instantBuild/...)、`physics`、`physicsEnabled`。
- 事件:`death`、`health`、`breath`、`spawn`、`respawn`、`kicked`、`end`、`game`、`time`、`rain`。

### 1.2 移动与视角
- 控制状态:`setControlState('forward'|'back'|'left'|'right'|'jump'|'sprint'|'sneak', bool)`、
  `getControlState`、`clearControlStates`。
- 视角:`look(yaw,pitch,force)`、`lookAt(point,force)`。
- 鞘翅:`elytraFly`;骑乘:`mount(entity)`/`dismount`/`moveVehicle(left,forward)`。
- 物理:内置 `prismarine-physics` 客户端模拟(可关 `physicsEnabled`)。
- 事件:`move`、`forcedMove`、`physicsTick`(另有 `physicTick` 别名)、`mount`/`dismount`。

### 1.3 寻路插件 `mineflayer-pathfinder`(可选依赖)
- 目标:`GoalBlock`、`GoalNear`、`GoalXZ`、`GoalNearXZ`、`GoalY`、`GoalGetToBlock`、
  `GoalCompositeAny/All`、`GoalInvert`、`GoalFollow`、`GoalPlaceBlock`、`GoalLookAtBlock`、`GoalBreakBlock`。
- 设置:`pathfinder.setGoal(goal,dynamic)`、`setMovements`、`goto`、`stop`、`isMoving/isMining/isBuilding`、
  `bestHarvestTool(block)`、`getPathTo`、`getPathFromTo`。
- 运动能力 `Movements`:`canDig`、`canOpenDoors`、`allow1by1towers`、`allowParkour`、`allowSprinting`、
  `allowFreeMotion`、`allowEntityDetection`、`scafoldingBlocks`、`maxDropDown`、`digCost`/`placeCost`、
  `blocksToAvoid`/`blocksCantBreak`、`exclusionAreasStep/Break/Place`。
- 内建移动类型(方法):jumpUp/forward/diagonal/dropDown/parkourForward/up/down。
- 拟人化:`createHuman(bot)` → `walkTo`/`lookAt`/`stop`,可配 personality(sprint/glance/strafe 等)。
- 事件:`goal_reached`、`path_update`、`path_reset`(reason: stuck/dig_error/place_error/...)、`path_stop`。

### 1.4 挖掘/放置/交互(玩家合法动作)
- 挖掘:`dig(block, digFace?)`、`stopDigging`、`digTime(block)`、`canDigBlock`、`targetDigBlock`。
- 放置:`placeBlock(refBlock, faceVector)`、`placeEntity(refBlock, faceVector)`。
- 方块交互:`activateBlock(block, dir?, cursorPos?)`(门/拉杆/按钮/开箱等)。
- 实体交互:`activateEntity`、`activateEntityAt(entity,pos)`、`useOn(targetEntity)`。
- 物品使用:`activateItem(offhand?)`/`deactivateItem`(蓄力/持续)、`consume`(吃/喝)、`fish`。
- 战斗:`attack(entity)`、`swingArm(hand,showHand?)`、`getExplosionDamages(...)`。
- 其它:`updateSign`、`writeBook`、`setCommandBlock`、`sleep`/`wake`、`isABed`。
- 事件:`diggingCompleted`/`diggingAborted`、`blockBreakProgressObserved/End`、`blockUpdate`、
  `entitySwingArm`/`entityHurt`/`entityDead`、`itemDrop`、`playerCollect`。

### 1.5 背包与装备
- `equip(item,dest)`/`unequip(dest)`(hand/head/torso/legs/feet/off-hand)、`setQuickBarSlot`、
  `heldItem`、`updateHeldItem`、`getEquipmentDestSlot`。
- `toss`/`tossStack`、`inventory`(Window)、`transfer(options)`、`putAway`、`putSelectedItemRange`。
- 创造模式:`bot.creative.setInventorySlot`/`clearSlot`/`clearInventory`/`flyTo`/`startFlying`/`stopFlying`。

### 1.6 容器/界面/GUI
- 打开:`openContainer`/`openChest`/`openFurnace`/`openDispenser`/`openEnchantmentTable`/`openAnvil`/`openVillager`、
  `openBlock(block)`、`openEntity(entity,Class)`。
- 类型化窗口:`Chest.deposit/withdraw`、`Furnace.putInput/putFuel/takeOutput`、`EnchantmentTable.enchant`、
  `Anvil.combine/rename`、`Villager.trades`。
- 底层槽位:`clickWindow(slot,button,mode)`、`moveSlotItem(src,dest)`、`simpleClick.leftMouse/rightMouse`、
  `closeWindow`;窗口事件 `windowOpen`/`windowClose`/`updateSlot`。
- 交易:`trade(villager,tradeIndex,times)`。

### 1.7 合成与配方
- `recipesFor(itemType,meta,minResultCount,craftingTable)`、`recipesAll(...)`、`craft(recipe,count,table)`。
- 依赖 `minecraft-data` 的配方/物品/方块数据库。

### 1.8 感知(仅"服务器发给你"的信息)
- 世界:`blockAt`、`blockAtCursor`、`blockAtEntityCursor`、`blockInSight`、`canSeeBlock`、
  `findBlock(options)`、`findBlocks(options)`、`waitForChunksToLoad`、`world`(prismarine-world sync)。
- 实体:`entities`、`players`、`entity`、`nearestEntity(filter)`、`entityAtCursor(maxDist)`、`entityAttributes`。
- 事件:`blockUpdate`、`blockEntityData`、`chunkColumnLoad/Unload`、`entitySpawn/Gone/Moved/Update`、
  `soundEffectHeard`、`particle`、`noteHeard`、`pistonMove`、`chestLidMove`、`explosion`。
- 社交/计分:`chat`/`whisper`/`awaitMessage`、`players`(ping/skin)、`tablist`、`scoreboards`/`teams`/`bossBar`。

### 1.9 原始协议逃生舱(关键!)
- `bot._client` 是 `minecraft-protocol` 的 `Client`:
  - `write(packetName, params)` —— **发送任意原版包**;
  - `writeRaw(buffer)`;`on('packet'|'raw', handler)`;
  - `registerChannel`/`writeChannel`/`unregisterChannel` —— 自定义插件通道(plugin channel);
  - `createSerializer/createDeserializer`(自定义包)。
- 含义:**动作空间的"上限"不是 Mineflayer 的高层方法,而是原版协议允许客户端发送的包集合**。
  任何高层未封装的玩家动作,都可以用 `_client.write` 直接发。

---

## 2. 方案 B:Fabric 服务端控制完整 API

Fabric API 只提供**插桩/管道**(生命周期、事件、网络、注册、数据);真正的"动作"能力来自
**Minecraft 服务端类**。因此分两部分列。

### 2.1 Fabric API(官方文档已核:Events / Networking / Container Menus)
- **入口**:`ModInitializer`/`ClientModInitializer`(`fabric.mod.json` entrypoints)。
- **生命周期/事件**:`ServerLifecycleEvents`(STARTING/STARTED/STOPPING)、`ServerTickEvents`
  (START/END)、`ServerPlayConnectionEvents`(JOIN/DISCONNECT)、`ServerEntityEvents`(LOAD/UNLOAD)、
  `ServerBlockEntityEvents`、`ServerMessageEvents`、`ServerChunkEvents`、`CommandRegistrationCallback`。
- **事件系统**:`net.fabricmc.fabric.api.event.Event` + 回调接口;内建如 `AttackBlockCallback`、
  `UseBlockCallback`、`UseEntityCallback`、`PlayerBlockBreakEvents`、`LootTableEvents` 等;
  缺失的钩子用 **Mixin** 自建(文档示例:SheepShearCallback)。
- **网络**:`CustomPacketPayload` + `StreamCodec`;`PayloadTypeRegistry.clientboundPlay()/serverboundPlay().register`;
  `ServerPlayNetworking.send(player,payload)`、`ClientPlayNetworking.send(payload)`、
  `ServerPlayNetworking.registerGlobalReceiver`、`ClientPlayNetworking.registerGlobalReceiver`;
  `PlayerLookup`(按 level/pos/tracking 找玩家)。**这是 Mod 与外部程序(如 Python/Node)通信的通道**。
- **注册**:`Registry.register(BuiltInRegistries.*, id, obj)`(item/block/entity/menu/...)、动态注册表、tags。
- **序列化/持久化**:Codec、Data Attachment、Saved Data(区域标记可持久化)。
- **数据生成**:loot table / recipe / tag / advancement / model 生成。
- **Class Tweakers**:Access Widener(放宽字段/方法可见性,是"直接用内部字段/方法"的官方途径)、
  Mixin(Accessor/Inject/...)。
- **自动化测试**:`fabric-api` 的 gametest 框架。

### 2.2 Minecraft 服务端类(动作能力;Mojang 官方映射 1.21.x)
> 注意**:Fabric 默认用 Yarn 映射**,名称不同(括号内为 Yarn):`ServerPlayer`(`ServerPlayerEntity`)、
> `ServerLevel`(`ServerWorld`)、`ServerPlayerGameMode`(`ServerPlayerInteractionManager`)、
> `AbstractContainerMenu`(`ScreenHandler`)、`BlockPos`/`ItemStack`/`BlockState` 同名。签名以 mappings 为准。

- **玩家实体/状态**:`ServerPlayer.setPos`/`teleportTo`、`setYRot`/`setXRot`、`setDeltaMovement`、
  `setHealth`、`getFoodData`、`getInventory`、`setItemInHand`、`setShiftKeyDown`/`setSprinting`、
  `jumpFromGround`、`hurtServer`、`getAbilities`(可设 `mayfly`/`instabuild`)、`getGameProfile`。
- **输入模拟**:`Player.zza`(前进)/`xxa`(平移)为 protected 字段(用 Access Widener 开放)、
  `setJumping`、`setSprinting`、`setShiftKeyDown`。→ 可在服务端"按键",由原版运动学驱动。
- **游戏模式/交互**:`ServerPlayerGameMode.handleBlockBreakAction(BlockPos, ServerboundPlayerActionPacket.Action(START/STOP/ABORT), Direction, int, int)`、
  `useItemOn(Player,Level,ItemStack,InteractionHand,BlockHitResult)`、`useItem(...)`、`destroyBlock`、
  `changeGameModeForPlayer(GameType)`。
- **方块世界**:`Level.getBlockState(pos)`、`setBlockAndUpdate(pos,state)`、`ServerLevel.destroyBlock(pos,drop)`、
  `BlockState.getDestroySpeed`、`Block.dropResources(...)`、`getFluidState`、`BlockEntity`/`CompoundTag`。
- **容器/菜单/背包**:`ItemStack`、`Inventory`、`AbstractContainerMenu`(`slots`、`clicked(slotId,button,ClickType,Player)`、
  `doClick`、`quickMoveStack`、`moveItemStackTo`)、`MenuProvider.openMenu`、`ServerPlayer.openMenu`、
  `MenuType`/`Slot`。→ 可直接操作槽位/背包,甚至绕过点击直接改 `ItemStack`(特权)。
- **合成/配方**:`RecipeManager`、`CraftingRecipe`/`RecipeHolder`、`Ingredient`、`InventoryMenu`/`ResultSlot`;
  可直接查配方、直接产出(特权)。
- **实体/战斗**:`ServerLevel.getEntities`、`getNearestPlayer`、`Entity.hurtServer`/`LivingEntity.setHealth`、
  `Player.attack(Entity)`、`Player.interactOn(Entity,Hand)`、`addFreshEntity`。
- **世界查询**:`ServerLevel`(`getBlockState`、`getChunk`、`isLoaded`、`getBiome`、`clip(...)` 射线、
  `getStructureManager`、`findNearestMapStructure`、`getRandom`)、`ChunkAccess`/`LevelChunk`/`LevelChunkSection`、
  `BuiltInRegistries`/`TagKey`、loot table、structure NBT。
- **特权修改**:`setBlockAndUpdate`、`addFreshEntity`、强制加载区块(chunk ticket)、`teleportTo`、
  `give item`、结构放置/定位、直接改 NBT。→ **能力上限是"服务端能做的全部",远大于玩家合法动作。**
- **时间/调度**:服务端 20 TPS;Fabric `ServerTickEvents.END_SERVER_TICK` 里逐 tick 驱动。

---

## 3. 逐项能力矩阵

| 能力 | Mineflayer(A) | Fabric 服务端(B) | 说明 |
|---|---|---|---|
| 移动/按键 | `setControlState`+physics | `xxa/zza/jump` 或直接 `setPos` | A 有成熟 pathfinder;B 可精确到 tick,也可瞬移(特权) |
| 寻路 | pathfinder 插件(成熟) | 需自研 A* 或调用服务端寻路 | A 开箱即用;B 更可控但工作量大 |
| 挖掘 | `dig` | `handleBlockBreakAction` / `destroyBlock` | A 走原版进度;B 可尊重或跳过硬度 |
| 放置/交互 | `placeBlock`/`activateBlock`/`useOn` | `useItemOn`/`useItem`/`setBlockAndUpdate` | B 可绕过点击直接改世界 |
| 合成 | `craft`/`recipesFor` | `RecipeManager`+菜单/直接产出 | B 可直接产出(特权) |
| 背包/装备 | `equip`/`toss`/窗口 | `Inventory`/`ItemStack` 直接改 | 同 |
| 容器 GUI | 类型化窗口+`clickWindow` | `AbstractContainerMenu` 直接操作槽位 | B 更底层;B 甚至可不开 GUI |
| 实体交互/战斗 | `attack`/`useOn` | `Player.attack`/`interactOn` | 同 |
| **观测:已加载区块** | 仅服务器发给你的 | **全部已加载** | **关键差异** |
| 观测:NBT/方块实体 | 仅 `blockEntityData` 收到才有 | 直接读 `BlockEntity`/`CompoundTag` | 关键差异 |
| 观测:结构/生物群系/战利品表 | 基本拿不到 | 直接查 | 关键差异 |
| 观测:实体全字段 | 协议同步的字段 | 服务端全字段 | 关键差异 |
| 观测:未加载区域 | 未知 | 可显式 force-load | 关键差异 |
| 强制加载区块 | 不能 | 能 | 特权 |
| 直接改世界/给物品/传送 | 不能(除创造/命令) | 能(可选) | 特权 |
| 原始协议/自定义包 | `bot._client.write`/`writeRaw`/channels | 自定义 payload + 网络 | 各自逃生舱 |
| 运行位置 | 任意服务器(含第三方) | **必须在装了 mod 的服务器** | 部署约束 |
| 确定性/延迟 | 受网络、预测、tick 偏移影响;可能 desync | 服务端内、逐 tick、无网络 | B 更确定 |
| 反作弊/风控 | 可能被检测/踢 | 无(自己的服务器) | 相关性 |
| 与 mod 内容交互 | 依赖协议/数据支持 | 直接(同一 mod 上下文) | B 更强 |
| 视觉画面 | 需 prismarine-viewer/客户端 | 服务端无渲染(需另接) | 都需另做 |
| 工程成本 | 低,JS 快速原型 | 高(Gradle/mappings/mixin/版本锁) | A 快 |

---

## 4. 关键结论:Mineflayer 的抽象**不**限制动作空间(但有别的限制)

1. **高层方法只是糖**。`dig/place/craft/openX` 是便利封装;真正上限是**协议允许的客户端包**。
   任何未封装的动作都可用 `bot._client.write(...)` 或自定义 plugin channel 发送。
   所以"动作空间受限"这个担忧,在**玩家合法动作**层面基本不成立。
2. **Mineflayer 的真正限制不是动作,而是观测与确定性**:
   - 只能看到服务器**发给你**的信息(已加载区块、被跟踪实体、当前窗口);NBT 细节、结构、生物群系、
     未加载区域拿不到;
   - 客户端预测会和服务端不一致(desync);移动受网络与 tick 影响;
   - 移动类"超能力"(瞬移/飞行)在生存服务器上通常不被允许。
3. **Fabric 服务端的上限严格更大**:它能做玩家合法动作,还能读全量状态、强制加载、直接改世界。
   代价是**部署约束**(只能在自己的 mod 服务器)、工程成本、以及"越来越像作弊"的可信度问题。
4. **对我们(完整模式)最自然的组合**:控制放 Mineflayer(动作空间已达协议上限、部署灵活),
   观测/事件/断言放 Fabric Mod(补上 Mineflayer 看不到的特权状态)。这样：
   - 动作层不损失表达力;
   - 断言层拿到服务端真值;
   - 二者通过自定义 payload / HTTP 通信。
5. **如果目标是"不可被区分的真人玩家"**,Mineflayer 控制更合适(它就是协议客户端);服务端 fake player
   在某些服/反作弊下行为与真人不同,且需要服务端配合。

---

## 5. 权衡表(选型)

| 如果你更看重… | 选 |
|---|---|
| 快速原型、少工程 | Mineflayer 控制 |
| 在任意(含第三方)服务器运行 | Mineflayer 控制 |
| 玩家合法动作的完整表达 | 两者都行(Mineflayer 有协议逃生舱) |
| 精确到 tick 的确定性控制 | Fabric 服务端 |
| 全量特权观测→强断言 | Fabric Mod(可只观测) |
| 直接改世界/造训练场/可复位环境 | Fabric 服务端 |
| 与 mod 内容深度交互 | Fabric 服务端 |
| 避免"像作弊"、保持玩家语义 | Mineflayer 控制 |
| 无需服务端安装 | Mineflayer 控制 |

---

## 6. 对原子动作设计的直接影响(待与你定)

1. **动作要按"玩家合法动作"分层设计**(因为这两条路的共同交集是玩家合法动作集):
   移动、视角、挖掘、放置、使用物品、攻击、交互实体/方块、背包、容器/菜单、合成、聊天、等待。
   Fabric 的"特权动作"(直接 setBlock、给物品、瞬移)应单列为**实验/训练场专用**,不混入主 action space。
2. **每个原子动作要能映射到两种后端**,便于对比与迁移:
   - Mineflayer:高层方法 + 必要时 `_client.write`;
   - Fabric:`ServerPlayerGameMode`/`ServerPlayer`/`AbstractContainerMenu`。
3. **断言/观测优先走 Fabric Mod**(真值),但**动作反馈**仍以控制端回报为准 → 需要"动作↔服务端事件"的关联。
4. **需要你定的**:
   - 主控制层最终选 A(Mineflayer)、B(Fabric 服务端),还是 A 控制 + B 观测的完整模式?
   - 首批要覆盖哪些域(寻路/战斗/采集/建造/物品生产/农牧)?这决定原子动作优先级。
   - 是否允许"特权动作"进入主 action space(仅训练场),还是严格玩家合法?

## 7. 来源与验证台账

| 项 | 状态 | 方式 |
|---|---|---|
| Mineflayer 完整 API(index.d.ts) | verified-real | 官方仓库 raw,副本 `sources/apis/mineflayer.d.ts` |
| mineflayer-pathfinder API | verified-real | 官方仓库 raw,副本 `sources/apis/pathfinder.d.ts` |
| minecraft-protocol API(原始包逃生舱) | verified-real | 官方仓库 raw,副本 `sources/apis/minecraft-protocol.d.ts` |
| Fabric Events/Networking/Container Menus | verified-real | docs.fabricmc.net 官方文档 |
| Fabric API 模块全集 | partial | 文档页导航与分类已见;未逐模块拉全 |
| Minecraft 服务端类/方法名(Mojang 映射) | **待用 mappings 逐条核对** | 基于 1.21.x 通行类名;编码前以 Yarn/Mojang mappings 为准 |

> 说明:本文件不引用任何第三方 agent 实现;能力均来自官方 API 定义与官方文档。
