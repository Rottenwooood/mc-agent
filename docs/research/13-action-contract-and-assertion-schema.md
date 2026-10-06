# 13 · 动作契约与断言引擎 schema(MC 版)

> `12` 的 B1。定义"谓词语言 / 动作契约 / 结果 / 模板"四套 schema 的**设计草案**——
> **尚未冻结**(见 §7):须先补齐 §1.5 的求值语义,才能作为跨 Java/TS 协议。
> 对应 agent-gavel:`checkpoint_to_checks` / `evaluate_checks`(三态)/ `schema.py`(模板)。
> 日期:2026-10-05。

---

## 0. 设计目标

- 断言由**程序**在**服务端真值**上求值(非 LLM 自评);
- 三态(+细分),失败带结构化原因与证据;
- 每个动作**自带契约**(前置/后置/不变量/副作用/可中断);
- 模板可参数化、可版本化、可局部修复、可统计;
- 对 LLM 暴露为 JSON schema,对执行器暴露为可校验对象。

---

## 1. 谓词语言(Predicate)

### 1.1 结构
```jsonc
Predicate {
  "subject": "block@10,63,10",     // 寻址(见 1.2)
  "predicate": "is",               // 算子(见 1.3)或具名关系
  "value": "minecraft:air",
  "scope": { "kind": "voxel", "radius": 1 },   // 观测范围(因果邻域),缺省按 subject 推断
  "not_before_tick": 12340,        // 事实必须晚于此 tick(防 no-op 假通过)
  "min_confidence": 0.6,           // 低于阈值视为未证实
  "attribution": "self"            // "self"|"any":是否要求因果归因到自己
}
```

### 1.2 subject 寻址语法(统一命名)
| 形式 | 含义 |
|---|---|
| `block@x,y,z` | 指定坐标方块 |
| `block:minecraft:oak_log@near(self,32)` | 最近同类方块(解析为坐标) |
| `inv:<item_id>` | 背包中某物品(读 count) |
| `self.hp` / `self.food` / `self.pos` / `self.dim` / `self.effects` | 自身状态 |
| `entity#<id>` / `entity:minecraft:cow@near(self,16)` | 实体 |
| `container@x,y,z` / `container#<entity_id>` | 容器内容 |
| `slot:<window>/<index>` | 槽位 |
| `world.time` / `world.weather` / `world.difficulty` | 世界 |
| `region:<box>` | 区域聚合(如"该区域无岩浆") |

### 1.3 算子
- 比较:`eq neq gt lt gte lte contains not_contains regex`
- 存在/计数:`exists not_exists count_eq count_gte count_gt`
- 变化:`changed`(有变化)、`changed_to`(变为)、`changed_by`(self/foreign)
- 关系(MC 专用,来自 L1 派生关系):`reachable`、`standable`、`has_los`、`in_range(d)`
- 会返回三态:`query_state(predicates)` → 每个谓词 `pass/fail`;整体 `pass` 若全 pass,
  否则若**因果邻域有意义变化** → `ambiguous`,若**不可观测/过期** → `unobservable`,否则 `fail`。

### 1.4 求值来源与分级
- 默认在 **Fabric 服务端真值**上求值(`authoritative`);
- 控制端(Mineflayer)事件可作为 `observed`(辅助/低权);
- 客户端预测为 `predicted`(仅提示,**不作为通过依据**)。

### 1.5 求值语义与缺口定义(草案,必须先补)

- **缺失/未知传播(三值逻辑)**:谓词求值结果为 `true|false|unknown`;组合用 **Kleene 逻辑**
  (AND:任一 false→false,否则有 unknown→unknown,全 true→true;OR 对偶;NOT 交换 true/false 保留 unknown)。
  `unknown` 映射到 `unobservable`,**不得当 false**。
- **量词/区域聚合**:`region:<box>` 支持 `all/any/count/none`,如"该区域无岩浆";
  范围必须**有界**,越界即 `unknown`。
- **对象引用失效**:`entity#`/`container#`/`slot:` 引用携带版本(`ref_version`);对象消失/换窗口/
  跨维度/重连后,旧引用求值 → `unknown`(不得复用,也不得当 false)。
- **快照一致性**:`query_state` 必须在**单一原子快照**(同一 `snapshot_seq`/tick)上求值,
  不得跨多次读取拼装,否则 before/after 不可比。
- **`$prev` / 结果引用类型**:`$s1.result` 有类型(`position|entity_id|item|slot|list|int`),
  在**编译期**类型检查;不匹配则模板校验失败,不进入执行。
- **表达式安全边界**:**不允许任意脚本/表达式**;LLM 只能从**受控谓词词表**中选项并参数化
  (与 `04` 的"安全编译边界"一致)。

---

## 2. 动作契约(ActionContract)

每个 L1 动作声明:
```jsonc
ActionContract {
  "name": "break_block",
  "params_schema": { "type":"object", "required":["position"], "properties": { ... } },
  "description": "挖掉指定坐标的方块",
  "preconditions": [
    { "subject":"block@{position}", "predicate":"exists" },
    { "subject":"self.pos", "predicate":"in_range", "value":{"to":"block@{position}","dist":4.5} }
  ],
  "verification_mode": "state_effect",     // state_effect|observation|task_terminal|continuous
  "postconditions": [                      // state_effect 类动作:必填,调用者不可删除
    { "subject":"block@{position}", "predicate":"is", "value":"minecraft:air", "not_before_tick":"$call" }
  ],
  "invariants": [                          // 执行期间持续
    { "subject":"self.hp", "predicate":"gt", "value":0 }
  ],
  "effect_class": "irreversible",          // read|idempotent|consumable|irreversible
  "interruptible": true,
  "safe_stop": "release_control",          // none|release_control|finish_landing|recall
  "timeout_ticks": 200,
  "causal_scope": { "kind":"voxel", "radius":1, "also":["inv_delta","self.pos","drops"] },
  "retry_policy": "no",                     // no|safe_once(仅 idempotent)
  "repair_hint": ["retarget_block","reposition"]
}
```
要点:
- `effect_class` 与 `retry_policy` 决定能否自动重试/修复(对齐 agent-gavel `_INHERENTLY_IDEMPOTENT`/`_SIDE_EFFECT_HINTS`,并新增 `irreversible`);
- **后置/不变量是"底层判据",上层只能加不能删**(framework §6);
- `$call` 在派发时替换为动作起始 tick,保证"事实必须新于动作";
- **`verification_mode`(不是所有动作都有"状态效果"后置)**:
  - `state_effect`:挖/放/合成等,**强制有后置断言**;
  - `observation`:`look_at`/查询类,判"已观测/已返回";
  - `task_terminal`:寻路/等待类,判"到达/超时/被阻断";
  - `continuous`:蓄力/持续使用,判"已停止且效果符合"。

---

## 3. 结果(ActionResult,冻结字段)

```jsonc
ActionResult {
  "effect_status": "pass|fail|ambiguous|unobservable",   // 证据/效果状态(来源:服务端真值 + 签名 diff)
  "control_status": "completed|blocked|interrupted|needs_replan|cancelled|uncertain",  // 执行控制结果
  "reason": "precondition_failed|effect_not_observed|insufficient_evidence|attribution_uncertain|timeout|policy_blocked",
  "effects": [ { "subject":"block@10,63,10", "predicate":"is", "before":"oak_log", "after":"air" } ],
  "evidence": [ { "claim":"block_removed", "source":"authoritative", "at_tick":12345 } ],
  "attribution": "self_confirmed|self_temporal|foreign|unattributed|unknown",
  "diff": { "changed":true, "added":2, "removed":1, "samples_added":[...], "samples_removed":[...] },  // ambiguous 时
  "resources": { "inventory_delta": {"minecraft:oak_log":+1}, "hp_delta":0, "hunger_delta":0, "xp_delta":0 },
  "timing": { "started_tick":12340, "ended_tick":12410, "elapsed_ms":3500 },
  "control": "returned",
  "sub_results": [ /* 组合动作的逐步结果 */ ]
}
```
- **两类信息必须分开**(不能混在一个枚举里):
  `effect_status`(证据/效果:pass/fail/ambiguous/unobservable)与
  `control_status`(执行控制:completed/blocked/interrupted/needs_replan/cancelled/uncertain)。
  例:`unobservable` 是证据状态,`needs_replan` 是控制结果;
- `fail` 的 `reason` **细分**:未生效 / 被阻挡 / 不可观测 / 归因不明 / 部分生效(部分生效用 `effects` 表示);
- `ambiguous` 必须带 `diff`(证据)与 `attribution`;
- 组合动作的 `sub_results` 供"整体验收"与局部修复定位。

---

## 4. 因果邻域签名与三态判定

### 4.1 因果邻域
由 `ActionContract.causal_scope` 定义,例如:
- `break_block` → 目标 3³ + 背包 delta + 玩家位姿 + 掉落物;
- `attack` → 目标实体 + 周边敌对集;
- `transfer_item` → 相关菜单槽位。
签名 = 对邻域内的**结构化事实**做规范化后取 hash + 可读行列表(便于 diff)。

### 4.2 两个独立命题:目标是否满足 vs 是否本动作造成

**必须分开判定**,不能"后置条件成立就给 pass":

- **命题 A(效果/证据)**:`effect_status` = 目标状态**是否已满足**(在服务端真值上)。
- **命题 B(归因)**:`attribution` = 该状态**是否由本动作造成**(见 §4.3)。

流程(动作后):
```
1. 求 postconditions(query_state, not_before_tick=start):
   全 pass → effect_status = pass;否则按邻域 diff 定:
     - 邻域不可观测/过期 → unobservable
     - diff.meaningful      → ambiguous(+diff)
     - 否则                 → fail(reason=effect_not_observed)
2. 独立判定 attribution(§4.3):
   - 首版(无服务端动作确认)→ 至多 self_temporal,**不得** self_confirmed
3. 若谓词显式声明 attribution:"self":
   - 而 attribution 未达 self_confirmed → **该断言不算最终通过**:
     保持 effect 状态,但标 `attribution_uncertain`,交策略(拒判/交还),不得报 pass。
4. control_status 由执行器填(completed/blocked/interrupted/needs_replan/cancelled/uncertain)。
```
`meaningful` 阈值:局部范围(小、纯)任意 1 处增删即有意义;大范围需严格阈值(对齐 agent-gavel `diff_summary` 的局部/整页两档)。

### 4.3 归因(证据等级,见 `14 §3`)
- 用 Fabric 事件主体(`PlayerBlockBreakEvents.AFTER` 等)判断,但**时间窗+范围+主体只建立时间相关**;
- 取值范围:`self_confirmed`(服务端动作确认/事务关联)/ `self_temporal`(仅时间相关)/
  `foreign` / `unattributed`;未确认时**不得**记 `self`。

---

## 5. 模板 schema(对齐 agent-gavel `schema.py`)

```jsonc
Template {
  "id": "chop_tree",
  "version": 3,
  "name": "砍一棵树并取木",
  "description": "...",
  "params": { "tree_id": {"type":"object"}, "limit": {"type":"int","default":64} },
  "preconditions": [ { "subject":"entity:tree@...", "predicate":"exists" } ],
  "postconditions": [ { "subject":"inv:minecraft:oak_log", "predicate":"count_gte", "value":"$limit" } ],
  "invariants": [ { "subject":"self.hp","predicate":"gt","value":6 } ],
  "steps": [
    { "id":"s1", "action":"find_nearest", "args":{...}, "on_failure":"replan" },
    { "id":"s2", "action":"go_to", "args":{"target":"$s1.result"}, "on_failure":"repair" },
    { "id":"s3", "action":"break_block", "args":{"position":"$cur"}, "on_failure":"repair" }
  ],
  "failure_policy": { "retry":"safe_only", "repair":"local_step", "on_fail":"hand_back" },
  "stats": { "success":0, "fail":0, "last_status":null, "last_at":null },
  "status": "draft",              // draft|verified|broken|deprecated
  "provenance": { "source":"human|llm|adaptation", "created":"...", "note":"..." }
}
```
- 参数替换:`$VAR`(对齐 agent-gavel `substitute`);敏感参数标记(此处少)。
- **不变量**:模板级持续监控;违反 → 中断交还。
- **组合不得字面重放**:执行器按"目标条件化"重建(见 14 执行引擎)。

---

## 6. 与 LLM 的暴露
- 动作/感知 = MCP tool,`inputSchema` 由 `params_schema` 生成;返回 `ActionResult`;
- 模板:见 `10 §4`(A/B/C);schema 即本文件 §5;
- LLM 只看到摘要与 `effect_status/control_status/reason/evidence`,细节按需展开。

---

## 7. 待你拍板 / 何时可称"冻结"
1. `subject` 寻址语法是否采用本文方案(`block@x,y,z` / `inv:` / `self.` / `entity#`)?
2. **双状态拆分**是否同意:`effect_status(pass/fail/ambiguous/unobservable)` +
   `control_status(completed/blocked/interrupted/needs_replan/cancelled/uncertain)`?
3. `verification_mode`(state_effect/observation/task_terminal/continuous)是否覆盖所有动作?
4. `effect_class` 是否就用 read/idempotent/consumable/irreversible 四类?
5. 模板步骤引用前一步结果(`$s1.result`)的**类型系统与作用域**?
6. **何时可称"冻结"**:需先补齐 §1.5 全部求值语义,并通过 Node↔Java 一致性测试。
   在此之前只称"设计草案",不直接作协议。
