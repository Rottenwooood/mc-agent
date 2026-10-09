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
- ❌ 把**绝对坐标当动作主地址**(本 §12 修正:模型面主用句柄 + 罗盘方位)。

---

## 12. 感知与寻址(定稿,待实现)

> 本节的目的是修正"把绝对坐标当动作主地址"的偏差。**动作实体、契约引擎、组合执行器、两层地图均复用**,主要改"地址层"与"感知面"。

### 12.1 地址模型
- **模型面主路径 = 对象句柄 + 罗盘方位**。绝对坐标**保留**(返回里可给),但**默认不引导**、只作采样/兜底。
- **罗盘**:`+X=东`,`−X=西`,`+Z=南`,`−Z=北`,`+Y=上`,`−Y=下`。方向**一律用罗盘 + 垂直**,**不绑定玩家朝向**(朝向不受我们控制)。
- 目标类型(模型面):`object(句柄) | relative(罗盘方位) | block(最近同类) | entity | item | container | cell(次要兜底)`。

### 12.2 两个主感知工具

**`view` —— 近处逐方块三维视野(精细,已裁剪)**
- 参数:`radius`(水平,默认 8)、`height`(垂直,默认 4);以玩家所在格为中心,世界轴对齐。
- 构造:在该范围取**暴露在空气/水里的方块**(表面壳语义);其余为内部实心或空气。
- 返回**精简**:只回**含方块的最小长方体**(各方向外扩 1 格并**保证含玩家格**),全空气的边角**裁掉**,并注明"长方体之外、半径之内均为空气"。元素字母:
  - `.` 已知空气/水;`字母` 暴露面方块(靠 `legend` 映射);`#` 已知实心但非暴露面;`?` 未观测(黑雾,仅出现在未加载/截断边缘);`self` 玩家下标。
- 轴标签:行 西→东,列 北→南,层 下→上。
- 顺带给出**本视野内可见对象句柄**(即 `scan_blocks` 的近处子集)。

**`scan_blocks` —— 语义对象扫描(主用,大范围、低延迟)**
- 做什么:把区域内**暴露在空气/水、彼此连通、同类**的方块**聚成对象**;另把**可互动方块、实体、液体**也列为对象。每对象带属性。
- 参数:`match`(方块/官方标签/族;`any` 走分类扫描,见下)、`radius`(**默认 24,可放大**)、`neighbor`(面/棱,默认面)、`include`(默认 `blocks,interactables,entities,liquids`)、`detail?`(可选,回成员明细)。
- 对象属性:`handle`、`kind`(block/interactable/entity/liquid)、`label`、`size`、`center_distance`、`edge_distance`(最近边缘)、`touchable`(≤触及距离)、`reachable`(可达路径)、**罗盘方位**、`sample`(坐标采样,不作主依赖)。
- **低延迟 + 大半径的做法**:永不整块体积地拉;靠**服务端按 id/标签过滤**,只回匹配格(数据量小 → 一次往返、p95 低)。`match:"any"` 不做"所有方块"体积聚合,改**分类扫描**:矿物(各 `#*_ores` 标签)、原木(`#logs`)、可互动方块(箱子/熔炉/工作台/铁砧/附魔台… 按 id)、液体(水/岩浆)、实体。
- **范围决策**:**独立现查(默认 24)**,不读记忆;近处那段的 `touchable/reachable` 由**本地壳**补充。`view` 管精细近处,`scan_blocks` 管语义对象。

### 12.3 其余工具的去留
- **删除 `inspect`**(看向哪不影响任何操作)。
- **删除 `scan_component`**(与 `scan_blocks` 的聚合重复;需要成员明细用 `scan_blocks` 的 `detail:true`)。
- **`scan_surface` 并入 `view`**。
- **`relations` = 兜底**:对某个句柄/方块**重新确认** `touchable/reachable/line_of_sight/adjacent_air/support/hazardous`;少用。
- **`recall` = 记忆**:圈外**记住的对象**(句柄 + 罗盘方位 + 距离 + `stale/confidence`,`source:"memory"`);**仅规划,不作证据,动手前必重校验**(进近触发 `view`/`scan_blocks`)。
- **`go_to`/`set_block`/`use_block`** 目标 = `句柄成员 / 罗盘方位 / 最近同类`;坐标次要。
- **`set_block` 的隐式导航/放置参考面/材料与工具校验**照旧;坐标由引擎内部解析。

### 12.4 句柄与三层语义
- **权威新鲜**(圈内/壳里):唯一可作证据、可操作。
- **未知(黑雾 `?`)**:未观测 → **不可操作**,先探索点亮。
- **记忆(圈外走过)**:`recall` 给出,仅规划,**动手前必重校验**。
- 句柄在**每次重观测**刷新;跨回合引用旧句柄先**失效检测**(没了/变了 → 明确回"已过期,请重看")。

### 12.5 `run_method`(有界编排)完整规格
- **定位**:声明式**步骤清单**,由执行器按序跑、结尾按后置整体判定;**非代码**、非 Turing 完备、可审计。
- **输入**:`{ name?, args?, budget?, budgetMs?(默认 90s,到点必返回三态), steps:[Step], postconditions? }`。
- **Step**:
  - 动作步 `{action, args, save?, optional?}` —— 与单发工具**同一条引擎路径**(reflex 守卫 + 契约引擎 + 超时 + 因果 diff / verify / reconcile);`save` 存结果变量。
  - 控制步 `sequence` / `for_each(set, as, body)` / `repeat(body, until?, count?)` / `branch(if, then, else?)`。
- **绑定**:字面量;`{from:"名字"}` 引用先前 `save`/`for_each` 绑定;`{expr:{op,args}}` 有界算术。
- **SetExpr(对象/锚点派生,不用绝对方框)**:
  - `members(handle)` 某对象全部格;`surface(handle)` 其空气/水暴露格;`nearest(match)` 最近匹配对象;`area(anchor:"self"|{from}, size:[dx,dy,dz], offset?)` 以可见锚点/玩家为参考的区域;`set_difference(a,b)`。
  - 坐标版 `region/box_cells` **保留但默认不引导**(仅兜底)。
- **语义**:**目标条件化**(集合执行时现算、只补缺失、禁字面重放);**失败策略**(单步失败默认记录并继续,`optional` 可标;由结尾后置判定整体);**终止后置**(权威世界求值 → 通过/失败/不可观测三态);**双预算**。
- **结果**:自解释聚合(`effectStatus/controlStatus/reason` + `subResults[]` + `diff` + `data{steps,elapsedMs,timedOut}`)。
- **与感知配合**:先用 `view`/`scan_blocks` 取句柄,再写进 method。
- **例**:挖矿脉 = `for_each(cell in members(vein)) set_block(cell, air)`;建/修 = `for_each(cell in set_difference(area(base,[2,1,2]), surface(base))) set_block(cell, planks)`。
- **后置条件主语**补**对象/引用式**(`obj#0` 的 `complete/gone/size_lt` 等);`block@x,y,z`/`inv:` 保留。

### 12.6 工具前后一览
| 工具 | 改前 | 改后 |
|---|---|---|
| `view` | (无) | **新增**:近处逐方块、裁剪到含方块的长方体、暴露面+内部+黑雾+玩家、罗盘对齐、附可见对象句柄 |
| `scan_blocks` | 吐坐标堆 | **聚合对象** + 属性(中心/边缘距离、touchable/reachable、罗盘方位、handle);含可互动/实体/液体;默认半径 24、服务端过滤、低延迟;坐标仅采样 |
| `inspect` | 看某格/看哪 | **删除** |
| `scan_component` | seed 坐标→成员集合 | **删除**(并入 `scan_blocks` 的 `detail`) |
| `scan_surface` | 暴露面/可站/危险列表 | **并入 `view`** |
| `relations` | 关系查询(可吃坐标) | **兜底**重确认某句柄/方块属性 |
| `recall` | 记忆(含糊) | 圈外对象的句柄+罗盘方位+距离+`stale`;仅规划、动手前必重校验 |
| `go_to`/`set_block`/`use_block` | 目标常填坐标 | 目标=**句柄/罗盘方位/最近同类**;坐标次要 |
| `run_method` 集合 | 绝对方框 | `members/surface/nearest/area(anchor)/set_difference` |
