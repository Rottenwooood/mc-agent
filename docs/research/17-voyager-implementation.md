# 17 · Voyager 真实实现梳理(为什么"丝滑",以及我们借鉴/替换什么)

> 来源:浅克隆 `github.com/MineDojo/Voyager` 到本地(2026-10-07)。行号以该克隆为准。
> 目的:从**代码**(非论文)看它为什么执行顺畅,哪些可复用、哪些必须替换。台账见文末。

## 0. 一句话结论

Voyager 的"丝滑"**不来自模型快**,而来自:**LLM 不在 tick 循环里 + 一次产出一整段 JS + 本地 `await` 跑完 + 服务器暂停 + cheat 兜底**。
快模型只是缩短了"暂停"窗口,不是丝滑的根本原因。

---

## 1. 运行结构

- Python(LLM)↔ HTTP ↔ Node/Mineflayer。
- `voyager/env/bridge.py` 的 `step()`:`unpause` → `POST /step` → 返回 → `pause`(L105-125);`pause/unpause` 通过 mod 的 `/pause`(L175-189)。
- `voyager/env/mineflayer/index.js`:
  - 建 bot(L29-35);加载插件 `pathfinder / tool / collectblock / pvp / hawkeye`(L98-107);
  - 注入观测(`Voxels/Status/Inventory/Chests/BlockRecords/OnChat/OnError/OnSave`)与技能(L112-122)。
- `/step`(L152-399):建 `Movements` + 一堆 `goals`(L177-208),然后

  ```js
  await eval("(async () => {" + programs + "\n" + code + "})()")   // L253-261
  ```

  即**把 LLM 生成的代码当 async 函数直接跑完**,结束后返回 `bot.observe()`。

---

## 2. 为什么"丝滑"(4 条,按重要性)

1. **LLM 不在 tick 循环里**:一次交互 = 一整段工作(一个 plan / 一个技能),不是每 tick 问一次。
2. **本地跑完再回来**:生成的代码是 `await` 链,寻路/挖矿/合成全在 Node 本地完成。
3. **服务器在 LLM 思考时被暂停**(`/pause`):世界不动,于是不用处理"我思考时怪物打了我 / 方块变了 / 掉下去了"。
4. **cheat 抹掉失败**:卡住直接 `/tp`、丢工具直接 `/give`、`/setblock ... air destroy` 回收、`/gamerule keepInventory true`。

> 我们保留 1+2(这是"快"的本质),**不采用 3+4**,因此必须自己补上"世界会变"和"失败"的处理——
> 这正是断言 + 重规划的价值所在。

---

## 3. 感知:只给"名字",不给坐标(关键)

LLM 看到的观测(`action.py:render_human_message` L102-199 + observation 文件):

- `voyager/env/mineflayer/lib/observation/voxels.js`:
  - `Voxels.observe()` = `getSurroundingBlocks(bot, 8, 2, 8)`(x±8, y±2, z±8)→ **一个方块名字的集合**(L10-13, L42-57);
  - `BlockRecords`:见过但不在背包的方块名(每 100 tick 采样一次)(L15-40)。
- `status.js`:health/food/saturation/oxygen/position/velocity/yaw/pitch/onGround/equipment/biome/entities(名字,近→远)/timeOfDay/inventoryUsed/isInWater|Lava|Web/isCollidedH|V。
- `inventory.js`:背包 `name → count`。
- `chests.js`:箱子内容记忆(按位置)。
- 拼成给 LLM 的文本:附近方块名、附近实体名(近→远)、position、血量、饥饿、装备、背包、箱子、task/context/critique。

**结论**:精确坐标**不喂给 LLM**,而是 LLM 写的代码在运行时用 `bot.findBlocks` / `bot.blockAt` 现查。
这与我们的判断一致:**LLM 不该在坐标层思考,坐标由程序运行时解析**。Voyager 用"自由 JS"做到,我们用"意图工具"做到,更可控。

---

## 4. 原子动作:按"名字"的高层函数 + 完整 mineflayer API

`voyager/control_primitives/`(给 LLM 调用的"原子动作"):

| 动作 | 内部实现(要点) |
|---|---|
| `mineBlock(bot, name, count)` | `findBlocks(name, maxDistance 32)` → `bot.collectBlock.collect(targets, {count})`(`mineBlock.js` L13-35) |
| `placeItem(bot, name, position)` | 找参考块 → `pathfinder.goto(new GoalPlaceBlock(pos, world, {}))` → `equip` → `placeBlock`(`placeItem.js` L56-59) |
| `craftItem / smeltItem` | 合成/熔炼(找台子/炉子、取放) |
| `killMob` / `shoot` | 战斗 / 射箭(`hawkeye` 自动瞄准) |
| `exploreUntil` | 朝某方向探索直到出现目标 |
| `useChest` | 开箱存取 |

另外把**完整 mineflayer API** 作为文档喂给 LLM(`control_primitives_context/mineflayer.js`):
`pathfinder.goto(GoalNear/GoalXZ/GoalGetToBlock/GoalFollow/GoalPlaceBlock/GoalLookAtBlock)`、
`equip/consume/fish/sleep/activateBlock/lookAt/activateItem/useOn` 等。

**两点印证**:
1. 原子动作可以**按名字/意图**,不必按坐标;
2. 它把 **`mineflayer-pathfinder` 直接当移动引擎**——所以"寻路先用 mineflayer"是有根据的。

LLM 输出被 `action.py:process_ai_message`(L201-256)用 Babel 解析:必须是若干函数、有一个 **async 主函数 `bot`**,执行 `await main(bot)`。

---

## 5. 它靠 cheat 兜底(我们必须替换)

| Voyager 的实现(代码位置) | 问题 | 我们的替代 |
|---|---|---|
| 卡住 → `teleportBot()` 用 `/tp` 到附近随机空气块(`index.js` L214-225, L263-298) | 直接作弊 | 本地重规划 + 局部修复 |
| 丢工具 → `/give iron_pickaxe`(`returnItems` L300-336) | 抹掉资源约束 | 真实"重新合成/找回" |
| 回收工作台/熔炉 → `/setblock … air destroy`(L300-336) | 改世界 | 只用玩家动作 |
| 出生时 `/clear @s` `/kill @s` `/give` `/item replace` `/tp` `/spreadplayers`(L52-135) | 重置作弊 | 可复位世界用存档,不用命令作弊 |
| `/gamerule keepInventory true` 等(L132-134) | 抹掉死亡惩罚 | 保留真实生存 |
| 服务器 `/pause`(bridge.py) | 世界不动 | **不暂停**,靠断言 + 重规划 |
| 自由 JS + LLM 自评成功 | 静默失败/技能污染 | 意图工具 + 程序断言 |

---

## 6. 技能与循环(简述)

- 技能库把**成功技能存为 JS 代码**(`skill_library/.../code/*.js` + `description/*.txt`),按描述检索复用。
- 智能体分 `curriculum / action / critic / skill` 四个 agent;`critic` 做语言化自我批评。
- 每个 task 内部**多轮** `step`(每轮一段代码),轮与轮之间服务器暂停。

---

## 7. 对我们的决定(本轮确定)

- **移动**:先用 **`mineflayer-pathfinder` 作基础移动图**(它本就是带 `dig/place/pillar/parkour/fall/ascend/descend/traverse` 的移动图 A*)，
  后续再升级为**多层表面图**;**保留坐标导航**作为一种可能(精确操作/逃生)。
- **执行**:保留**分块本地执行**(LLM 一次给一段意图/计划,本地跑完);**不 pause**;用**断言 + 重规划**替代 pause + cheat。
- **动作接口**:以**意图工具**替代自由 JS + LLM 自评。
- **可复用**:`mineflayer-pathfinder`、`mineflayer-collectblock`、`mineflayer-tool`、`mineflayer-pvp`、`hawkeye`;观测字段格式可参考。

---

## 8. 验证台账

| 项 | 状态 | 来源 |
|---|---|---|
| 运行结构 / step / pause | verified-real | 本地克隆 `voyager/env/bridge.py`(L105-125, L175-189) |
| eval 执行 / 插件 / cheat / 卡住处理 | verified-real | `voyager/env/mineflayer/index.js` |
| 感知只给名字/不给坐标 | verified-real | `lib/observation/voxels.js`、`status.js`、`inventory.js`、`chests.js`、`agents/action.py` |
| 原子动作按名字 | verified-real | `control_primitives/*.js`、`control_primitives_context/mineflayer.js` |
| Creative + cheats + pause 实验条件 | verified-real | `README.md` L100-104、`installation/fabric_mods_install.md`(另见 `sources/apis/`) |
