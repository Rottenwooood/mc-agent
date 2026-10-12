# mc-agent 修复方案（完整）

> 合并两轮反馈：① 空真 pass / 结果语义；② P0/P1/P2 实机清单；③ 自洽原则（一条路）。
> 状态：方案，待拍板。日期：2026-10-12。

## 实施状态（2026-10-12 更新）
- **P0 全部完成**（`8b53682`）：Target/steps schema 内联、结构化错误（`accepted_shapes`+回显）、`handle` 一致、`members` schema 化 + 示例、`scan_blocks.bbox`。
- **P1 完成**：
  - 2.1 语义：引擎强制 `pass ⇒ changed`（否则 `no_op`）；`set_block` 判目标格 + `no_op`；背包类未知→`unobservable`；纯控制类显式标 `controlOnly`；`{kind:"block"}` 当场复验。
  - 2.2 安全：挖掘/寻路预检液体；**楼梯式下挖**（`digStaircase`，goal 在下方时前进+下降，绝不捅进液体）。向上原语 `pillar_up` 本期不做。
  - 2.3 合成：`lookup_recipe` 默认全量 + ingredients；`craft` 自动探测工作台；`count` = 结果数量语义。
  - 2.4/2.5：`run_method` 汇总为 `no_op`、单条时间序 `changes` 反馈；引擎每次调用带自"上次调用"以来的变化切片（含第一次的基线，不回显历史）。
  - 提交：`bccaa48` `5e57352` `f186aa1` `57bc703`。
- **P2 完成**：液体 `adjacent`/`wouldFlood`/水-岩浆区分；错误带 `accepted_shapes`/`hint`；`get_inventory` 带 `slot`+`hotbar`；`scenarios/skills.seed.json` 种子；`relations` 走结构化目标错误。
- **仍待办（未拍板，非本期）**：§2.5 传递方式**乙**（异步插入上下文 / 魔改 OpenCode）；`pillar_up`。

---

## 0. 原则（先定死，后面全部服从）

1. **一个动作 = 一个语义。**
   - `set_block` = 改**一个**方块（原子原语，**唯一**）。
   - **"一串" = 组合**：`run_method` 对**集合表达式**（`members(handle)` / `nearest(...)` / `area` /
     `box_cells` / `region` / `surface` / `component`）做 `for_each`。
   - **唯一路径**：不新增 `inspect_object` / `mine_object` 等平行入口。`scan_blocks`/`view` 给的
     handle 直接进 `members`。手动循环 `set_block` 挖一串 = 不鼓励（不可复用、不可断言、沉淀不了二级动作）。
2. **`pass` 必须由权威证据支撑**：目标效果**真的发生**（`diff.changed` / 背包 delta≠0）。
   "调用被接受"**不算** pass。
3. **拆开 `changed` 与 `satisfied`**：满足但**什么都没变** → `no_op`（**不是成功**）。
4. **未知 ≠ 值**：读不到 pre/post 状态 → `unobservable`，**绝不**默认成空气 / 0。
5. **目标执行时复验**：`{kind:"block"/"object"}` 解析后**当场确认**仍是目标物，过期就换/重扫，
   绝不拿过期坐标动作。
6. **不静默做事**：任何动作（含"顺带"的）都不静默产生副作用；所有世界变化以**时间序**反馈（§2.5）。

---

## 1. P0 — 地基（可发现性 + 错误自举）

### 1.1 target / steps 的 schema + 文档
- 定义 `Target` JSON Schema（`oneOf` by `kind`），**内联进每个 target 参数**（替换现在的 `target:{}`），
  客户端**调用前**就能报"形状不对"。
- 四种 kind 统一并文档化：`{kind:"cell",pos}` / `{kind:"block",block[,pos]}` /
  `{kind:"object",handle}` / `{kind:"entity",handle}`。
- `run_method` 的 `steps` 同样给 schema。

### 1.2 结构化错误（可自举）
- `resolveTarget` 失败 → `{reason:"precondition_failed", reasonDetail, data:{accepted_shapes, received}}`。
- MCP 层**兜底**：任何内部异常（`Cannot read properties of undefined…`）转成结构化错误 + hint。
  **任何工具都不该吐 JS 异常。**

### 1.3 handle 全工具一致
- 统一成 `handle`（`ref` 作为兼容别名）；`view/scan` 返回的 handle 在**所有**工具里都能直接用。

### 1.4 members 是一等公民（作为集合表达式，**不是新工具**）
- 把 `members(handle)` 作为 `run_method` 的集合表达式，**schema 化 + 文档化**。
- `scan_blocks` 结果补 `bbox`，便于理解对象范围。

### 1.5 run_method 描述=实现 + 完整示例
- 对齐字段（真实吃的是 `set:{op:"members",handle}` / `as` / `body`；修 `cells/body is not iterable`）。
- 工具描述里放 **2 个完整可跑示例**：① `for_each`+`members` 挖矿（结尾 `collect`）；
  ② 带 `postconditions`。

---

## 2. P1 — 语义 + 安全

### 2.1 挖掘语义（= 空真 pass 那一类）
- 引擎 `reconcile` **强制不变量**：`pass` ⇒ `diff.changed`（或背包 delta≠0）；否则降级 `no_op`。
- `set_block` 按 diff 判：`changed→pass / 没变→no_op / 不匹配→fail / 观测不到→unobservable`；
  早返回（`before===block`）改 `no_op`。
- 背包类动作（`craft/smelt/drop/transfer/consume/collect/equip`）：**未知→`unobservable`**；
  没变化→`no_op`/`ambiguous`，不算 pass。
- 纯控制类（`look_at/wait/steer/follow/flee/chat/open/close_container`）：显式标 **control-only**，
  不冒充效果 pass。
- `{kind:"block"}` 解析**当场复验**，解析到空气就换下一个（不硬挖过期采样点）。

### 2.2 液体安全（向上原语**暂缓**）
- 挖掘/寻路**预检**：这一步是否会捅破水/岩浆（用观测的 fluid + `wouldFlood`）→ 拒绝/告警。
- **楼梯式下挖**做成一等挖掘模式。
- ~~向上原语 `pillar_up`~~ —— **本期不做**（先靠楼梯式下挖避免被困；后续再补）。

### 2.3 合成
- `lookup_recipe`：**默认全量**（2×2 + 3×3）返回，**带上 ingredients**（现在恒空）。
- `craft`：**自动探测附近工作台**（现在旁边有桌子也报 no recipe）。
- `count` 语义明确（"想要的结果数量"）+ 修 mineflayer `bot.craft` 次数换算（8 sticks 只给 4）。

### 2.4 挖掘/拾取不脱节
- 挖掘组合**结尾自动 `collect`**（或返回掉落物坐标 / 明确报"N 个掉落物不可达"）。
- **但绝不静默**：见 §2.5 —— 任何"顺带做的"都必须以时间序世界变化反馈出来。

### 2.5 世界变化的时间序反馈（**不静默做事**）
**原则**：任何动作**不静默**产生副作用；所有世界变化（方块 / 背包 / 位置）以**时间序**反馈给模型。

- **单条格式**：`<actor> <subject> <predicate> <value>`，例：`A minecraft:dirt is broken`、
  `A minecraft:coal is picked up`、`A moved to 12,64,-3`。（A = agent 自己。）
- **来源（已有）**：观测 Mod 的 `/events`（`seq/tick/pos/before/after/actor`）+ 背包 delta + 位置。
- **传递方式**：
  - **甲（搭车，推荐先做）**：每次工具调用的响应里带 `changes:[...]`——自**上次调用**以来的变化切片
    （游标式）。**不需要改 OpenCode。**
  - **乙（随时插入）**：把变化异步插进模型上下文。OpenCode 可能不支持 → 要**魔改**。后续评估成本再做。
- **应用**：
  - 挖掘后若"顺带 collect"：响应必须带"背包 +N、掉落物 -M、坐标变化"，**不许只返回一个 pass**。
  - **其他返回也统一**成这种时间序变化（成功路径的 `effects/evidence/diff` 已是雏形，收敛到同一格式）。

---

## 3. P2 — 小问题
- 液体对象：加 `adjacent` / `wouldFlood` / 区分水/岩浆（现在 `size:7080, edge:0.58` 没法判危险）。
- 所有错误带 `hint` / `accepted_shapes`。
- `get_inventory` 带**槽位索引 / hotbar 映射**（equip 到具体槽）。
- **预置几条 skills/actions 示例**（现在 0 action、1 skill；`chopping` 已证明有用）。
- `relations` 的 `precondition_failed` 说明是哪条前置。

---

## 4. 决定（已拍板）
1. 唯一路径 = **A 组合**（`set_block` 一个 + `run_method` + 集合表达式）。✅
2. `no_op` 命名。✅
3. 引擎**强制 `pass ⇒ changed`**。✅
4. 顺序 **P0 → P1 → P2**。✅
5. 向上原语 **本期不做**（§2.2）。✅
6. 新增原则：**不静默做事**，世界变化以**时间序**反馈（§2.5）；传递先用**甲（搭车）**，乙（随时插入/魔改）后续评估。
