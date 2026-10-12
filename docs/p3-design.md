# P3 设计：组合自由度 + mod 兼容 + 可自迭代的原子

> 目的：把 mc-agent 做成「能自行迭代出新动作」的 agent。
> 由此推出两条硬前提：**原子动作必须自洽**；**组合语言必须与原子共享同一套 state model**。
> 状态：设计（待实施）。日期：2026-10-12。承接 `docs/repair-plan.md`（P0/P1/P2）。

## 实施状态（2026-10-12）
- **P3-1 已完成**：`SetExpr` 新增 `inventory`/`container`/`entities` 域（元素=记录）；`resolveArg` 支持 `{from,field}` 投影（cell 用 x|y|z）；`set_difference` 元素安全。
- **P3-2 已完成**：method→method 层级组合（`callSecondary`，深度上限 8）；`run_method` 返回 `data.trace`（逐步 effectStatus/reason）；嵌套 run 暴露 `diff`（净效果可传播）。
- **P3-5 已完成**：`run_method {validate:true}` 静态校验（动作名/set op/字段/控制步/谓词），不执行。
- **附带修掉两个真 bug**：
  - `findNearestBlock` 对任何截断的大半径查询都返回 `unobservable` → `{kind:"block"}` 基本不可用。改为「只查 exposed + 逐级缩小半径」。
  - `set_block.verify` 曾**重新解析** `{kind:"block"}`（挖完最近方块变成另一格）→ 假 `fail`。改为判 **scope anchor**（动作时解析的格），无 anchor → `unobservable`；`defaultScope` 不再伪造 self anchor。
- **仍待办**：P3-3（观测 mod `/capabilities`，删 `INTERACTABLE`/`isFluid`）、P3-4（原子/域插件注册 + `ControlPort` 能力协商）、§7 并行采纳项（环境 fixture / scenario runner / 读类信封规范 / scan_blocks 字段过滤 / 命名收敛）。

---

## 0. 目标与前提

- **目标**：agent 能自己定义并沉淀出新动作。产物 = **二级动作**（`define_action`，DSL 组合）。
- **前提 1**：原子 vocabulary 与组合语言**共享同一套 state model**（原子能读写的状态，组合必须能遍历/断言）。
- **前提 2**：结果信封有**统一的取值规范**（`effectStatus/controlStatus/attribution/reason/diff` 各轴语义不打架）。

---

## 1. 外部实测反馈（另一位 agent，真实存档）—— 逐条登记

> 背景：对方在真实存档跑了「空背包 + 地下 y=34」的挖掘链，以下是其反馈原文摘要 + 我的核实。
> 核实方法：直接读仓库代码（下方均给出文件:行）。

| # | 反馈 | 代码事实 | 判定 |
|---|---|---|---|
| 1 | 世界/背包**无法重置**，无「环境前置状态」校验；`run_command "clear"` 也不生效 | 无 reset/clear 原语；`run_command` 不管结果 | **真问题**（缺环境 fixture） |
| 2 | `run_command` 无输出且**自相矛盾**：`ambiguous` + `attribution:self_temporal` + `diff.changed:false` | `meta.ts:29` 硬编码 `ambiguous/attribution_uncertain`，无输出、无 diff 判定 | **真问题**（信封规范） |
| 3 | `find_nearest` 文档与参数名不符（传 `{id,radius}` 报 `block: Missing key`）；命名不统一 `radius/within/range/distance` | `perception.ts:370` 实参为 `{block,within}`；全仓 `radius`×7 `range`×5 `distance`×12 `within`×2 | **真问题**（文档/命名卫生） |
| 4 | `scan_blocks` 输出爆炸（连带 bat/salmon/pig…，2794 行被截断） | `perception.ts:214` 无条件 `entities()`；`scan_entities` 已另有工具 | **真问题**（职责未切开 + 无字段过滤） |
| 5 | 挖矿靠 `set_block{block:"minecraft:air"}` 表达，**反直觉** | `blocks.ts` 唯一原语；注释写了但描述无示例 | **文档问题**（非原子问题，见 §3） |
| 6 | `craft` 对 3×3 配方行为不清（会不会自动合成+放置工作台？）；无 `can_craft` | `craft` 只自动**探测**已存在的桌子，不合成桌子 | **文档问题 + 可加预检** |
| 7 | 无批量 `drop` / 清空背包，逐格 drop 了 10 次 | 无 inventory 遍历域（见 §3） | **组合语言缺口**（不是要加原子） |
| 8 | 长时操作（`go_to allowModify` 从 y=34 打通到地表）无进度/取消反馈 | `goto` 只回终态 receipt | **可加阶段进度**（低优先） |

**对方给的 API 建议**（登记，逐条在 §2/§4 决议）：
- target 联合类型在每个工具里重复复制一大段。→ §4 单点声明。
- 给「读」类工具定清晰的 effect 语义（`get_inventory` 是 `pass` 但 `attribution:unknown`）。→ §4 信封规范。
- mutating 工具尽量都回 `diff`。→ §4。
- 破坏性操作加 `dry_run`/`confirm`/`undo`。→ §5 **部分驳回**。
- `run_method` 加 `dry_run`（不执行、只校验 steps + 终态断言）。→ §7 **采纳**。
- secondary 库：`list_actions` 空、`activate_action` 失败没暴露为什么。→ §2 纠正（其实已暴露）。
- 确定性 fixture / scenario runner / 记录 seed+版本+bot 名 / starter skills。→ §7 采纳（fixture + runner）。

---

## 2. 核实结论：哪些对、哪些错

### 2.1 对方**说错**的（不要照单全收）

- **「`activate_action` 没暴露 gate 明细」——错。** `actionLibrary.evaluate()` 返回 `{activate, version, reason, stats}`，`reason` 形如 `"uses 3 < 5; pass rate 0.66 < 0.8"`，handler 原样放进 `data`（`actionLibrary.ts:176`、`mcp/tools.ts:236`）。`list_actions` 空 = **尚未定义过任何动作**，不是 bug。
- **「`set_block` 破坏/放置无法归因」——不成立。** `set_block` 是**单格单次转移**：`air→X` 即放置、`X→air` 即破坏，不存在「破坏成功但放置失败」的两阶段。其拆分建议（`break_block`/`place_block` 别名、`set_block` 降级为方法）**违反已拍板的唯一路径 A + 禁平行入口**，驳回。
- **「`drop all` 该是原子能力」——对方自己也已认账。** 正确解法是补组合语言（§3），不是加原子。

### 2.2 对方**说对**的（核心）

> **不变量：原子 vocabulary 与组合语言必须共享同一套 state model。**

逐条核实（全部属实）：

| 断言 | 代码事实 |
|---|---|
| `SetExpr` 只遍历**方块格** | `evalSet` 返回 `Vec3[]`，8 个 op 全是方块域（`tasks/sets.ts:130`） |
| 循环变量只能**整值替换**，无字段访问 | `resolveArg` 的 `{from:name}` 返回整个 var；`evalExpr` 只有算术（`tasks/args.ts:9,23`） |
| **能断言**背包/实体，**不能遍历**背包/实体 | postconditions 有 `inv:`/`entity#`，`SetExpr` 没有（`tasks/predicate.ts:52` vs `sets.ts`） |
| method **不能**调用 method | `run_method` 的 registry = `actionRegistry()`，**只有原子**；二级动作不在其中（`mcp/tools.ts:11`） |

**⇒ 结论：`drop all` 今天确实表达不出来，而这正是「自迭代」的命门。答案是补组合语言，不是加原子。**

---

## 3. 核心不变量（写进项目宪法）

1. **原子读写的状态**：方块 / 实体 / 背包 / 自身 / 容器。
2. **`SetExpr` 的域必须 ⊇ 上式**；`postconditions` 与 `SetExpr` 共用同一 state model。
3. **`pass` 必须有权威证据**（已由 P1 的 `pass ⇒ changed` 强制）。
4. **一个动作 = 一个语义**；组合表达得了的，绝不新增平行原子。
5. **语义来自注册表/tag/能力标志**，绝不硬编码清单（见 §6）。
6. **当 DSL 表达不了时，产物是新原子**——这就是「自行迭代出新动作」。

---

## 4. 组合自由度：六轴（现状 / 目标 / 收益）

| 轴 | 现状 | 目标 | 收益 |
|---|---|---|---|
| 1. **状态域封闭** | 只有方块格 | `inventory` / `entities(filter)` / `container(handle)` 域，返回**带类型元素** | 背包/实体/容器原子**一次性可组合** |
| 2. **元素投影** | 只能整值 `{from:'c'}` | 字段路径 `{from:'s',field:'count'}`；cell 的 `field:x|y|z` | 能把「这格堆叠数」喂给 `drop.count` |
| 3. **有界表达式** | 只有 +,\*,min,max | +比较/选择/拼接/向量（纯、全能） | `count`/`until`/坐标可推导 |
| 4. **集合代数 + 控制** | for_each/sequence/repeat/branch | +`let` / 中途 `assert` / `try` / `while` | 中途断言 = **逐步归因**（自修复前提） |
| 5. **层级组合** | method 只能调原子 | method 可调 **active 二级动作**（带递归上限） | **抽象可累积** |
| 6. **参数化 + 语义选择器** | 有 `params`、`Target` 联合 | +默认值/类型/`requiresTable` 类前置标志 | 学出来的动作可泛化 |

补完 #1+#2，目标即可成立：

```json
{"steps":[{"op":"for_each","set":{"op":"inventory"},"as":"s","body":[
  {"action":"drop","args":{"item":{"from":"s","field":"item"},"count":{"from":"s","field":"count"}}}]}]}
```

`drop_all / equip_best / deposit_all` 全部变成**方法**。

---

## 5. 自由度的边界（**故意不做**）

不引入：任意代码 / IO / 并发 / 无界递归。理由：它们会**同时摧毁** `dry_run` 校验、静态检查、可复现、安全重试、provenance —— 也就是「自迭代」赖以成立的性质。

因此：**DSL 负责编排，原子负责新原语，边界本身是功能不是缺陷。**

---

## 6. mod 兼容：四手段

**(A) 契约即接缝。** 换 MC loader / 换 bot 后端 = 换 `WorldPort`/`ControlPort` 的 adapter（`contracts/src/ports.ts`），核心不动。缺的一环：给 `ControlPort` 加**能力协商**（`supports(method)`），缺能力返回结构化 `unsupported` 而非异常。

**(B) 游戏语义来自注册表，绝不用硬编码清单。** 现有两处**违规**：
- `isFluid = /^minecraft:(flowing_)?(water|lava)$/`（`world/src/objects.ts:26`）→ 只认原版水/岩。
- `INTERACTABLE` = 34 个原版方块白名单（`execution/.../perception.ts:27`）→ 认不出 create/mekanism/AE2 的机器。

修法：让**观测 mod**（跑在游戏进程、能查真注册表；`mods/mcagent/.../ObserverMod.java`，Fabric）多返一组 `/capabilities`，全部来自 mod 也继承的运行时属性：
- 流体：`blockState.getFluidState().isEmpty() === false`
- 可交互：`state.createScreenHandlerFactory(...) != null`
- 需工具/等级：`isToolRequired()` + `#minecraft:mineable/*`、`#minecraft:needs_*_tool`
- 掉落：`Block.getDroppedStacks(...)`

⇒ `kind: liquid|interactable|block`、液体危险判断、挖矿工具选择**全部数据驱动**，mod 方块自动正确。

**(C) 新动词 = 可插拔原子 + 域。** 定义**注册接口**，让 mod 专属 adapter 注册：新原子（name/params/contract/run/verify）、新 `SetExpr` 域与元素 schema、新 predicate subject。DSL 仍**封闭可校验**，但**对注册开放** → mod 原子与原版原子同一套组合语法。

**(D) 新状态 = 新端口。** mod 引入 `WorldPort` 没建模的状态（能量/温度/自定义 NBT）→ 加**类型化能力端口**，不塞特例工具。

---

## 7. 实施顺序（P3-1 … P3-5）

1. **P3-1 状态模型封闭**：`SetExpr` 新增 `inventory`/`entities`/`container` 域 + 元素投影 + 有界表达式扩展。**单位工作量自由度最高。**
2. **P3-2 层级组合 + 逐步 trace**：method→method（递归上限）+ `run_method` 返回 step trace。**抽象累积 + 信用分配。**
3. **P3-3 注册表驱动语义**：观测 mod 出 `/capabilities`，删掉 `INTERACTABLE`/`isFluid`。**mod 兼容第一刀。**
4. **P3-4 插件注册 + `ControlPort` 能力协商**：原子/域可插拔；后端声明支持。**mod 兼容第二刀。**
5. **P3-5 `run_method validate` 模式**：不执行、只校验 steps 语法 / set / arg / 终态断言可否求值。**对接自动评测。**

**并行采纳（低风险、独立）**：
- **环境 fixture**（对方 #1）：`reset` 场景到已知起点（`inventory=empty`、`pos`、`seed`），解决「任务前提 vs 实际状态」。
- **scenario runner**：给定 `steps + postconditions` 自动跑并输出每步 pass/fail + 证据。
- **记录 `world_seed`/server 版本/bot 名**，失败可复现。
- **读类信封规范**：`get_inventory` 等 read 的 `attribution` 省略（不写 `unknown`）；修 `run_command`（按 diff 判或标 control-only）。
- 卫生：`scan_blocks` 加 `include/fields` 过滤（`entities:false` 默认）、`find_nearest` 描述列真参名、命名收敛 `within`。
- 更多 starter skills（挖矿脉、合成、洞穴探矿）。

### 明确不做
- 任意代码步骤、无界递归、并发、为每个 mod 分叉核心。
- `break_block`/`place_block` 别名、`set_block` 降级（违反唯一路径 A）。
- `drop_all`/`inventory_clear` 原子（改用组合）。
- 破坏性操作 `undo`/`confirm`（本项目模型 = 权威证据 + 显式断言；不可逆正是必须回报 `changes` 的理由）。

---

## 8. 目标示例（P3-1/P3-2 完成后）

```json
// drop_all（全是方法，无新原子）
{"steps":[{"op":"for_each","set":{"op":"inventory"},"as":"s","body":[
  {"action":"drop","args":{"item":{"from":"s","field":"item"},"count":{"from":"s","field":"count"}}}]}]}

// deposit_all 到最近的箱子
{"steps":[
  {"action":"scan_blocks","args":{"match":"minecraft:chest"},"save":"c"},
  {"op":"for_each","set":{"op":"inventory"},"as":"s","body":[
    {"action":"transfer_item","args":{"item":{"from":"s","field":"item"},"count":{"from":"s","field":"count"},
      "target":{"kind":"object","handle":{"from":"c"}},"from":"inventory","to":"container"}}]}]}

// 挖一整条矿脉后自动收集（已有能力，P3 不改）
{"steps":[
  {"op":"for_each","set":{"op":"members","handle":"obj:block:minecraft:coal_ore:64,34,70"},"as":"c","body":[
    {"action":"set_block","args":{"target":{"kind":"cell","pos":{"from":"c"}},"block":"minecraft:air",
      "navigate":true,"allowModify":true,"breakThrough":true}}]},
  {"action":"collect","args":{"radius":8}}]}
```
