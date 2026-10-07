# 世界感知、地图与动作编排(详细设计)

> 配套 `mcp-implementation-framework.md §5/§6/§7`。状态:设计,待实现。日期:2026-10-08。

---

## 1. 感知模型:表面壳 + 表面图

**只维护与空气接触的暴露面**,不维护体积体素。

- **表面壳(surface shell)**:对窗口内每个方块,仅当它**至少有一个面朝向空气**时入表;记录暴露面(法向)与方块 id。
  - 内部被包住的方块不入表(玩家看不到、走不到、交互不到);挖掉/放置后由其邻居"变暴露",由事件就地打补丁。
- **多层表面图(multi-layer surface graph)**:由表面壳导出——
  - **可站立面**:顶面朝空气且有支撑(用于移动图,允许多个可站层:洞穴/多层/桥下);
  - **可交互面**:暴露面 + 视线(用于放置/交互);
  - **危险面**:暴露的岩浆/火/水/仙人掌等(用于安全)。
- **移动图**:先接 `mineflayer-pathfinder` 基础图,后续升级为上述多层表面图;我们**不做避障几何**,避障交给移动图。

## 2. 更新频率与触发(三触发各司其职,不是单一频率)

| 触发 | 时机 | 动作 |
|---|---|---|
| **事件增量** | Mod `block_changed` 等 | 就地打补丁(最省) |
| **跨格平移** | 玩家跨越方块边界(或每 K 格) | 滑动窗口:补前沿、丢后沿;**方向前方优先预读** |
| **低频兜底** | 0.5–1 Hz | 窗口内重扫,补漏事件 |
| 速度自适应 | 高速移动 | **只平移+预读前方**,身后直接丢,不细刷 |
| | 低速/静止 | 低频刷新足够 |

优先级:**近处 + 朝向 > 侧向 > 身后**。

## 3. 推送 vs 拉取

- **默认拉取**(下次工具返回里附"自上次以来有意义的变更"摘要)。
- **主动推送只限两类**:① **安全隐患**(威胁逼近等);② **有界持续动作的完成**(如 `explore` 命中目标)。
- **裸体素数据永不推给 LLM**。

## 4. 压缩与展示

- 内部:按 **chunk-section 调色板/位压** + run-length。
- 给 agent:聚合计数(`oak_planks×248`)、按层 2D 摘要、或直接给**派生集合**(天然紧凑);**不给裸网格**。

## 5. 两层地图

| 层 | 内容 | 频率 | 权威性 | 用途 |
|---|---|---|---|---|
| **本地表面壳** | 接触空气的暴露面 | 高 | **权威/新鲜** | 控制、安全、**断言证据** |
| **持久稀疏发现图** | 结构/资源点/路点/地形骨架 | 低 | **记忆,可能过期** | **仅规划**;进近时重校验 |

- 发现图每条带 `{source, observed_tick, confidence, stale}`;**绝不作为后置证据**。
- 跨会话持久化(长程记忆/回程),但进近必须用本地壳重校验。

## 6. 通用世界查询(替代结构识别)

- `connected(seed | region, match, neighbor?, bounded?) → 分量{cells/faces, bbox, size, exposed}`
  - `match` = 方块 / **MC tag** / 族(#logs、#ores、#planks…);
  - "一棵树" = agent 对 `connected(原木, #logs)` 的命名;部分破坏/人造/爆炸后,分量是什么就是什么。
- `region(box, filter)`、`exposed_faces(box)`、`standable_surfaces(box)`。
- 关系:`reachable / lineOfSight / adjacent_air / support / hazardous`。
- **方块族一律用 MC 官方 tag/registry,不自造分类**。

## 7. affordance(便宜的随对象给,昂贵的按需)

- **便宜(随感知对象返回)**:`distance`、`within_reach`(当前站位 + 触及距离)、`needs_approach`、`has_los`(廉价射线)、`required_tool`、`has_tool`。
- **昂贵(按需)**:精确可达性(path 是否存在)、可站站位集合。
- 目的:agent 一眼知道"现在能交互 / 需先接近 / 缺工具 / 被挡",**避免先调用再报错**。

## 8. 核心原语:`replace`(两状态)

```
replace(cell, B, { auto_approach?, tool?, protect? })
  pre : cell 已加载且在允许范围;若 B≠air 则材料/工具(不具备则如实报告)
  effect: 当前==B → 跳过
          当前==air → 放置 B
          当前≠air 且 ≠B → 破坏后放置 B
          B==air → 破坏
  post: 权威 world.get(cell) == B
  effectClass: B==air ? irreversible : consumable
```
- **"不管" = 不生成该 cell 的调用**(不是第三种状态)。
- `auto_approach` = **隐式导航**(动作内部导航;须把导航步骤写进结果);显式导航 = 单独 `go_to`。两者都留。
- **结果必须自解释**:目标、是否可达/需接近、做了什么、为何未成、证据、diff。

## 9. 有界编排词表(agent 可写,非 Turing 完备)

```
Method := [Step…]
Step   := Action | Control
Action := { action, args, save? }
Control:=
  { op:"sequence", steps:[Step…] }
  { op:"for_each", set:SetExpr, as:id, body:[Step…] }
  { op:"repeat", body:[Step…], until?:Predicate, count?:Expr, budget?:Expr }
  { op:"branch", if:Predicate, then:[Step…], else?:[Step…] }
SetExpr:=
  { op:"set_difference", a:SetExpr, b:SetExpr }
  { op:"component", seed:Ref, match:Filter, neighbor?:Rule, bounded?:Box }
  { op:"region", box:Box, filter?:Filter }
Arg    := 字面量 | { from:Ref } | { expr:Expr }     // Expr: count/len/min/max/±/× 等有界运算
```

- **例**:
  - `build` = `for_each(cell in set_difference(期望, 当前), replace(cell, 期望[cell]))`;
  - `mine_vein` = `for_each(b in component(seed, #ores), replace(b, air))`;
  - `clear_area` = `for_each(cell in region(box, non_air), replace(cell, air))`。
- 高层动作 = **数据 + 有界控制**,可声明、可审计、可验证;**不执行模型临时生成的任意代码**。
- 目标条件化:进入时重算派生集合,**只补缺失**;结束做整体后置。

## 10. 持续动作 `explore`(设计留档,后做)

```
explore(direction, until:Predicate, budget, { avoid?, allow_modify? })
  行为 : 朝 direction 自动避障前进(移动图);
         行进中以频率 f(如 5 Hz)在本地表面壳上求值 until;
         命中 → 停止导航、确认控制释放、返回 {found:对象/引用, evidence};
         超时/危险 → 返回 blocked/interrupted。
  不变量:安全(威胁/坠落);默认不改地形(除非 allow_modify)。
  post : task_terminal(found | budget exhausted)。
```
- 用途:只给"前方"参数去找材料,命中即**中断并把主动权交还 agent**(研究 04 的 reachability/liveness 形态)。

## 11. 明确拒绝的反模式

- ❌ 为"树/矿脉/建筑"写**结构识别分类法**(不通用)。
- ❌ 蓝图三态(把 air 当特殊态)——用 **replace** 两状态。
- ❌ 让 LLM 写**Turing 完备**代码。
- ❌ 体积体素缓存并拿来做**移动/安全**。
- ❌ 用**过期发现图**当后置证据。
- ❌ 把"动作自带接近"当美德——目标是**结果自解释**。
