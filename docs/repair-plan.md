# mc-agent 修复方案（完整）

> 合并两轮反馈：① 空真 pass / 结果语义；② P0/P1/P2 实机清单；③ 自洽原则（一条路）。
> 状态：方案，待拍板。日期：2026-10-12。

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

### 2.2 液体安全 + 向上移动
- 挖掘/寻路**预检**：这一步是否会捅破水/岩浆（用观测的 fluid + `wouldFlood`）→ 拒绝/告警。
- **楼梯式下挖**做成一等挖掘模式。
- 新增**向上原语** `pillar_up`（用背包方块垫脚上升 N 格）——否则下到 1×1 竖井就出不来。

### 2.3 合成
- `lookup_recipe`：**默认全量**（2×2 + 3×3）返回，**带上 ingredients**（现在恒空）。
- `craft`：**自动探测附近工作台**（现在旁边有桌子也报 no recipe）。
- `count` 语义明确（"想要的结果数量"）+ 修 mineflayer `bot.craft` 次数换算（8 sticks 只给 4）。

### 2.4 挖掘/拾取不脱节
- 挖掘组合**结尾自动 `collect`**（或返回掉落物坐标 / 明确报"N 个掉落物不可达"）。

---

## 3. P2 — 小问题
- 液体对象：加 `adjacent` / `wouldFlood` / 区分水/岩浆（现在 `size:7080, edge:0.58` 没法判危险）。
- 所有错误带 `hint` / `accepted_shapes`。
- `get_inventory` 带**槽位索引 / hotbar 映射**（equip 到具体槽）。
- **预置几条 skills/actions 示例**（现在 0 action、1 skill；`chopping` 已证明有用）。
- `relations` 的 `precondition_failed` 说明是哪条前置。

---

## 4. 拍板
1. 唯一路径：**A 组合**（`run_method`+集合表达式）还是 **B**（`set_block` 直接吃集合）？——我建议 **A**。
2. `no_op` 命名（还是 `already_satisfied`）？
3. 引擎**强制 `pass ⇒ changed`** 同不同意？
4. 顺序：**P0 → P1 → P2**？
5. 向上原语叫 `pillar_up`、行为"用背包方块垫脚上升 N 格"，够不够？
