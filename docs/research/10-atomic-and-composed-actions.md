# 10 · 原子动作与组合动作设计(初稿 v0)

> 约束(已定):**控制 = Mineflayer 玩家合法动作**;**特权 = Fabric Mod 只读观测**;
> 动作可作 **tool 直接调用**;**组合动作与原子同级**,也可调用。
> 参考:`09-api-usage-cookbook.md`(签名/示例)、`08-control-backend-api-matrix.md`(能力边界)。
> 本文是**设计稿**,标注了需你拍板的点(§8)。日期:2026-10-05。

---

## 0. 设计原则

1. **语义粒度,不是按键粒度**:动作是"走到某处 / 挖掉这个方块 / 合成一个镐",不是"按 W 一秒"。
   但保留一个低级逃生舱(`steer`)以覆盖极端情况。
2. **统一目标类型(Target)与统一返回(Result)**:所有动作共用一套 `target`/结果 schema,便于组合与断言。
3. **通用优先**:能用一个参数化动作覆盖的,不为每个变体造新工具(如 `break_block` 覆盖所有方块)。
4. **每个动作自带契约**:前置条件(preconditions)、预期效果(postconditions)、副作用分类、可中断性。
5. **玩家合法**:不出现"直接 setBlock / 给物品 / 瞬移";切模式/命令走 `run_command`(服务端权限裁决)。
6. **可分层的判据**:原子 = 单一目标、单次效果;组合 = 搜索/循环/序列 + 断言。

---

## 1. 通用数据模型

### 1.1 Target(联合类型)
```jsonc
{ "kind": "position", "x": 10, "y": 64, "z": -3 }
{ "kind": "block", "name": "minecraft:oak_log", "count": 1,
  "near": {"kind":"position",...}?, "max_distance": 32, "constraints": {...}? }
{ "kind": "entity", "id": 123 } | { "kind": "entity", "type": "minecraft:cow", "nearest": true, "max_distance": 16 }
{ "kind": "item", "name": "minecraft:iron_ingot" }
{ "kind": "slot", "window": "inventory"|"open", "index": 12 }
{ "kind": "container", "position": {...} } | { "kind":"container", "entity": {"kind":"entity",...} }
{ "kind": "self" }
```

### 1.2 Result(统一返回;由 08 的观测后端填证据)
```jsonc
{
  "status": "pass" | "fail" | "ambiguous" | "unobservable" | "blocked",
  "reason": "precondition_failed:... | effect_not_observed | insufficient_evidence | ...",
  "effects": [ {"subject":"block(10,63,10)","predicate":"is","value":"air"} ],
  "evidence": [ {"claim":"block_removed","source":"authoritative","at_tick":12345} ],
  "attribution": "self" | "foreign" | "unattributed",
  "resources": { "inventory_delta": {...}, "hp_delta": -2, "hunger_delta": 0 },
  "control": "returned"
}
```
- **三态细化**:`unobservable`(未加载/失去跟踪)与 `ambiguous`(世界变了但不符预期)分开。
- **证据分级**:`predicted`(Mineflayer 客户端预测)/ `observed`(控制端收到的包)/ `authoritative`(Fabric 服务端只读)。

### 1.3 副作用分类(决定重试/修复策略)
`read` | `idempotent`(可安全重试,如 go_to/equip) | `consumable`(消耗,如吃/放置/合成)
| `irreversible`(不可逆,如破坏地形/丢物品/交易/死亡风险)。

---

## 2. L1 原子动作(通用,可作 tool 直接调用)

> 命名统一 `snake_case`;每个给出:参数 / 说明 / 主要前置 / 主要后置 / 副作用类。

### A. 感知与查询(read-only;断言与规划的基础)
| 动作 | 参数 | 说明 | 后置 |
|---|---|---|---|
| `get_self_status` | — | 自身 hp/food/坐标/维度/模式/效果/手持/护甲/经验 | 返回快照 |
| `get_inventory` | — | 背包物品列表 | 返回列表 |
| `scan_blocks` | types, radius/box, max | 扫描区域方块 | 返回 {pos,type} |
| `scan_entities` | types?, radius, max | 扫描区域实体 | 返回 {id,type,pos,dist,hostile} |
| `find_nearest` | target(block/entity) | 找最近目标(可用 Mineflayer findBlock/nearestEntity 或 Fabric 更全) | 返回目标 |
| `raycast` | max_distance | 准星命中的方块/实体 | 返回命中 |
| `inspect_block` | position | 方块状态 + (特权)方块实体/NBT 摘要 | 返回状态 |
| `inspect_container` | container | (特权)直接读容器内容,无需开窗 | 返回槽位 |
| `lookup_recipe` | item | 配方/需材(递归可展开) | 返回配方树 |
| `get_world_info` | — | 时间/天气/维度/难度 | 返回 |

### B. 移动与导航
| 动作 | 参数 | 说明 | 副作用 |
|---|---|---|---|
| `go_to` | target(position/entity/block), tolerance?, allow_break, allow_place, allow_parkour, max_cost, timeout | A* 寻路到目标附近;由 Movments 控制是否允许挖/搭/跑酷 | idempotent |
| `follow` | entity, distance, duration? | 跟随移动目标 | idempotent |
| `flee` | entity, distance, duration? | 远离 | idempotent |
| `look_at` | target | 转向目标 | read-ish |
| `wait` | ticks? / until(condition)? | 等待固定 tick 或条件 | idempotent |
| `steer` | controls[], duration | **低级逃生舱**:直接按键(仅在高层不够用时) | idempotent |

### C. 方块交互
| 动作 | 参数 | 说明 | 副作用 |
|---|---|---|---|
| `break_block` | position, tool? | 挖掉指定方块(尊重工具/硬度/可达) | consumable(工具耐久)+irreversible(地形) |
| `place_block` | position, item, face? | 放置手持/指定方块 | consumable |
| `use_block` | position, item? | 右键方块(门/按钮/拉杆/耕地/开箱前的交互) | idempotent/consumable |

### D. 实体与战斗
| 动作 | 参数 | 说明 | 副作用 |
|---|---|---|---|
| `attack` | entity, duration?, weapon?, tactics? | 近战/远程攻击一段时间 | consumable(耐久/箭) |
| `interact_entity` | entity, item? | 右键实体(喂食/剪毛/挤奶/上马/开交易) | consumable |
| `use_item_on` | item, target | 对目标使用物品(如骨粉/水桶/打火石) | consumable |

### E. 背包与物品
| 动作 | 参数 | 说明 | 副作用 |
|---|---|---|---|
| `equip` | item, slot(hand/head/torso/legs/feet/off-hand) | 装备 | idempotent |
| `unequip` | slot | 卸下 | idempotent |
| `drop` | item, count | 丢弃 | irreversible |
| `transfer_item` | item, count, from, to | 背包↔容器/槽位搬移 | idempotent(可逆) |
| `consume` | item | 吃/喝 | consumable |
| `use_item` | item, release_ms? | 使用物品(弓/药水/桶/珍珠),支持蓄力 | consumable |

### F. 容器 / 合成 / 生产
| 动作 | 参数 | 说明 | 副作用 |
|---|---|---|---|
| `open_container` | container | 打开箱子/熔炉/附魔台/铁砧/村民 | idempotent |
| `close_container` | — | 关闭 | idempotent |
| `craft` | item, count, table? | 合成 | consumable |
| `smelt` | item, count, fuel? | 熔炼 | consumable |
| `enchant` | item, choice? | 附魔 | consumable(经验/青金石) |
| `anvil_combine` | item1, item2, name? | 铁砧合成/改名 | consumable(经验) |
| `trade` | villager, index, times? | 村民交易 | consumable(绿宝石/物品) |

### G. 通信与元
| 动作 | 参数 | 说明 | 副作用 |
|---|---|---|---|
| `chat` | message | 发言 | read-ish |
| `run_command` | command | 执行命令(如 `/gamemode`) | 依命令;服务端裁决 |
| `screenshot` | — | 取一帧(bot 视角;prismarine-viewer headless) | read |
| `task_status` / `task_stop` | task_id? | 组合动作的状态/停止 | — |

统计:**A10 + B6 + C3 + D3 + E6 + F7 + G5 = 40** 个原子动作。多数是"通用参数化"的;`steer`/`run_command` 是逃生舱。

---

## 3. L2 组合动作(与原子同级、可调用)

> 组合动作 = **搜索/循环/序列 + 断言**,内部调用 L1;对外是**一个动作**。
> 低熵者适合冻结为模板;高熵者适合运行时探索。

| 域 | 组合动作 | 内部原语 | 关键断言 |
|---|---|---|---|
| 采集 | `collect_block(type,count)` | find→go_to→break→pickup(有界循环) | 背包 count 递增;方块变 air |
| 采集 | `mine_vein(type)` | scan→去重→逐个 break | 目标方块清空;掉落入包 |
| 采集 | `chop_tree()` | find log→break 整棵→捡 | log 数达标 |
| 采集 | `dig_down(y)` / `dig_tunnel(len,dir)` | break 序列+go_to | 到达目标 y/长度;安全不变量(不挖脚下方块/岩浆) |
| 建造 | `place_line(a,b,item)` | 规划站位→place 序列 | 体素集合差消解 |
| 建造 | `clear_area(box)` | break 序列 | 区域变空 |
| 建造 | `bridge(to)` / `pillar_up(n)` | place+go_to | 可通行/到达高度 |
| 建造 | `build_blueprint(blueprint,origin)` | 分层 place+站位规划 | 逐层体素集合差=空;整体验收 |
| 生产 | `ensure_item(item,count)` | **递归**:lookup_recipe→(采集/合成/熔炼) | 背包 count 达标;依赖资源不超预算 |
| 战斗 | `engage_hostiles(radius)` | scan→attack(逐个) | 敌对实体清空/自身安全 |
| 战斗 | `retreat_from(entity,distance)` | flee+威胁监控 | 距离达标;无伤害 |
| 农牧 | `plant(seed,area)` / `harvest(area)` | use_block/break | 作物状态;产物入包 |
| 农牧 | `feed_breed(animal,item,n)` | interact_entity | 长出幼体 |
| 探索 | `explore(dir,dist)` / `return_to(base)` | go_to+scan+torch | 覆盖范围;回到基点 |
| 物流 | `transport(items,src,dst)` | open/withdraw→go_to→deposit | 容器内容 delta |

---

## 4. 组合动作如何"变回 tool"——三条路线(需讨论,§8)

### 路线 A:命名模板 + 单一调用工具
- 形态:`run_skill(name, params)` 一个稳定 tool;技能库(JSON:名字/描述/参数/步骤/断言/版本/成功率)存本地。
- 发现:模型通过注入的技能摘要(名字+描述+参数)或 `list_skills(query)` 选择。
- 优点:库可运行时无限增长、无需重启;版本化/局部修复/统计(即 agent-gavel/Voyager 模式);tool 列表稳定。
- 缺点:模型需"知道名字";非原生 schema;发现性弱于独立 tool。

### 路线 B:动态生成 MCP 工具(每个技能一个 tool)
- 形态:保存技能时注册为独立 MCP tool,`tools/list` 变更通知(`notifications/tools/list_changed`)。
- 优点:一等公民、原生 schema、发现性最好。
- 缺点:依赖客户端支持动态 tool 列表(实现参差);tool 列表膨胀;版本churn;失败/弃用管理复杂;部分客户端需重启。

### 路线 C:混合(我倾向)
- 技能库仍是**唯一真相源**(模板 + 版本 + 断言 + 统计)。
- 常驻暴露:`run_skill(name,args)` + `list_skills(query)` 两个通用工具。
- **晋升机制**:高频/高成功率且**参数与断言稳定**的技能,在**启动时**生成**一等 MCP tool**(避免运行时协议依赖);
  未晋升的走 `run_skill`。
- 好处:核心稳定、发现性好、库可增长、无协议风险;坏处:晋升需要一次重启(可接受)。

| 维度 | A 命名模板 | B 动态 tool | C 混合(推荐) |
|---|---|---|---|
| 发现性 | 中 | 高 | 高(核心)+中(长尾) |
| 运行时可增长 | 高 | 依赖协议 | 高 |
| 原生 schema | 否 | 是 | 晋升后是 |
| 版本/修复/统计 | 好 | 较难 | 好 |
| 协议风险 | 无 | 有 | 无 |
| 实现成本 | 低 | 高 | 中 |

---

## 5. 断言与观测接入(与 08/09 对齐)

- 每个动作在返回前评估其 `postconditions`,证据优先取 **Fabric 服务端真值**;
  动作反馈取 **Mineflayer 事件**;两者用统一 `action_id` 关联。
- 组合动作的每步是 L1,逐步断言;组合级再加**整体后置**(防"每步曾成功"假象)。
- 高熵组合挂**连续不变量**:安全(hp/坠落/岩浆/敌对半径)、进展(计数/位移单调)、终止(目标达成)。
- 归因:`self`(我的动作导致)/`foreign`(他人/环境)/`unattributed`(有变化但无法归因)。

---

## 6. 与 agent-gavel / Voyager 的映射

| 概念 | agent-gavel | Voyager | 本设计 |
|---|---|---|---|
| 原子动作 | `locator_*` / `page_*` | 直接写 Mineflayer JS | L1(§2),参数化、契约化 |
| 断言 | 预声明 checks,三态 | LLM 自评 | L1 后置 + 组合不变量,证据分级 |
| 模板 | workflow(动作+检查点) | JS 技能 | L2 组合动作(=模板) |
| 复用 | `workflow_run` | `retrieve skill` | `run_skill` / 晋升 tool(§4) |
| 局部修复 | runner `_try_repair` | 迭代改写代码 | 失败步重探索(换目标/站位)+版本迭代 |

---

## 7. 第一批实现优先级(建议)

1. **A 感知 + B 移动 + C 方块 + E 背包**:最小可玩底座(`get_self_status/get_inventory/scan_*/go_to/break_block/place_block/equip/drop`)。
2. **F 容器/合成**:`open_container/withdraw/craft`;支撑"木镐→石镐"链路。
3. **组合**:`collect_block`、`ensure_item`、`build_blueprint`(先小蓝图)、`return_to`。
4. **断言/中断**:三态 + 安全不变量。
5. 其余域(战斗/农牧/物流/探索)按需补。

---

## 8. 需你拍板的点

1. **组合动作落地形态**:A / B / C?若 C,晋升阈值(使用次数/成功率/稳定性)定多少?
2. **原子动作粒度**:约 40 个是否过多?`steer`/`run_command` 是否保留为逃生舱?
3. **第一批域顺序**:按 §7 的"最低可玩底座"起步,还是你先指定某个域先做?
4. **组合是否存代码**:L2 用"参数化步骤+断言"(JSON,类似 workflow),还是允许 LLM 写脚本(Voyager 式)?我建议前者为主、脚本为可选。

### 已定(2026-10-07)

- **移动**:先用 **`mineflayer-pathfinder` 作基础移动图**,后续升级为**多层表面图**;**保留坐标导航**作为一种可能。
  详见 `17 §7`。
- **动作接口**:LLM 面向**意图/名字级**动作,坐标下沉为内部原语(见 `17` 的印证)。
