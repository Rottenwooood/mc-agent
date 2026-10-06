# 11 · 特权感知与 3D 体素语义(设计)

> 补齐 `10` 缺失的感知层。约束:**Fabric 服务端 Mod 只读**;感知既服务**控制**(找目标/站位/路径),
> 也服务**断言**(权威真值/因果归因)。原则来自 `minecraft-framework.md §5`(事实/关系/语义分开、
> 来源与时间、未知与过期显式)与 `07` 的"因果邻域签名"。
> 日期:2026-10-05。设计稿,§9 为待拍板点。

---

## 0. 一句话定位

不要给 LLM 一堆像素或一整个体素网格;要建一个**分层、有界、带来源与时间的符号世界模型**,
其中:
- **底层体素**(精确几何)留在程序侧;
- **中层关系**(可达/可站/视线)按需计算;
- **高层语义对象**(树/矿脉/建筑/工作台)供 LLM 引用;
- **对 LLM 只回摘要 + 按需查询结果 + 断言证据**。

---

## 1. 观测范围:有界,范围外一律 `unknown`

| 层 | 范围 | 维护方式 | 用途 |
|---|---|---|---|
| **主动区(egocentric)** | 玩家周围 R(如 32×32×32 或 64³) | 事件驱动增量 + 低频刷新 | 实时控制/安全/行走 |
| **任务区(task-scoped)** | 任务声明的 box(蓝图/矿脉搜索框/容器) | 任务开始时展开,结束释放 | 施工/采集/断言 |
| **全局稀疏层** | 背包、其他玩家、路点、已发现结构/群系、时间天气 | 事件 + 持久化 | 规划 |

硬规则:
- 未加载区块 / 失去跟踪 / 超出范围 → 显式 `unknown`,**不得当作"没有"**;
- 需要远处信息时,任务必须**显式声明范围**(可触发 force-load,但属受控能力,记录代价)。

---

## 2. 四层表示(体素 → 语义)

### L0 体素(精确,程序侧)
```jsonc
Voxel { pos, block_id, block_state, source, observed_tick, confidence }
```
- 存储:主动区用**按 chunk section 的调色板/位压**;任务/全局用稀疏字典。
- **不把半砖/楼梯/门当整立方体**:碰撞用真实 `VoxelShape`/碰撞盒;
- **世界坐标为准**,另给玩家相对方向的辅助函数;
- 简化手段:palette + run-length(同方块连续段),但**可无损还原**。

### L1 派生关系(按需计算,带依赖失效)
`standable(pos)`、`walkable(a,b)`、`reachable(player→pos)`、`line_of_sight(a,b)`、`support(pos)`、
`connected(region)`、`hazardous(pos,lava/fire/cactus/fall)`、`gravity_block`、`climbable`、`replaceable`、`openable`、`path_cost`。
- 只对**任务区**展开;随相关方块变化失效(依赖跟踪)。

### L2 语义对象(供 LLM 引用)
```jsonc
SemanticObject { id, kind, bbox|voxels, members?, labels[], source, confidence, observed_tick }
```
- kind:`tree`、`ore_vein`、`crop_plot`、`container`、`workstation`、`building`、`room`、`entrance`、
  `water_body`、`cliff`、`bridge`、`frontier` …
- **来源与置信**:`server_metadata`(结构)/`block_registry`(方块类别)/`clustering`(连通分量)/
  `blueprint`(用户蓝图)/`manual`(人工标注)/`vision`(后期识别)。
- 对象是**有置信度的候选**,不是真值标签;低置信给候选与歧义。

### L3 任务相关抽象(临时)
"待挖的矿脉""待施工的蓝图区""探索前沿(frontier)""回程路线"——由任务生成、任务结束释放。

---

## 3. 同步、时间与新鲜度

- **事件驱动增量**(Fabric):方块破坏/放置、实体加载/卸载、区块加载/卸载、容器变化、爆炸、活塞;
- **`revision` 单调计数**(任何事实变化 +1)+ 每个事实的 `observed_tick` / `expires_tick`(可衰减);
- **`isLoaded` 门控**:范围外/未加载 → `unknown`;
- **主动区低频快照**兜底(防漏事件);
- 查询 API 一律返回 `{value, source, observed_tick, coverage}`;过期/低置信按 `unknown` 处理。

---

## 4. 与 LLM 的接口纪律(关键)

- **绝不把体素网格塞进上下文**。给 LLM 的是:
  1. 紧凑符号摘要(如"正前方 3×3×3""附近对象列表""背包""威胁");
  2. **按需查询**的结果(通过下面的感知工具,有界返回);
  3. 断言失败时的**证据/差分**(见 §6)。
- LLM 通过 **object id** 引用世界,而不是坐标数组;精确几何留在程序侧。

---

## 5. 感知工具 API(补 `10 §2A`,可作 tool)

| 工具 | 参数 | 返回(有界) |
|---|---|---|
| `observe_region` | box 或 center+radius, filters | 体素/对象的紧凑摘要(限数量) |
| `get_heightmap` | box | 地表高度图(用于站位/寻路) |
| `get_relations` | pos, kinds | reachable/los/standable/hazard |
| `get_objects` | kind?, radius | L2 语义对象(含 id/置信) |
| `get_frontier` | direction? | 探索前沿候选 |
| `query_state` | predicates | 对权威状态求值(断言用;三态) |
| `poll_delta` | since_revision? | 自上次以来变化(事件流) |
| `get_evidence` | subject,predicate | 来源分级证据(归因用) |
| `screenshot` | view? | 视觉兜底一帧(prismarine-viewer headless) |

> `query_state` 是断言的核心:谓词在**服务端真值**上求值,返回 `pass/fail/ambiguous/unobservable`。

---

## 6. 断言与因果:特意为"三态"设计的部分

### 6.1 因果邻域签名(causal-scoped signature)
动作执行前,对**动作的因果邻域**取签名:
- 作用于方块 → 目标 3³ + 背包 delta + 玩家位姿 + 掉落物;
- 作用于实体 → 该实体 + 周边敌对集;
- 作用于容器 → 该菜单槽位。
动作后重新取签名并 diff:
- 谓词成立 → `pass`;
- 谓词不成立且**邻域无意义变化** → `fail`;
- 谓词不成立但**邻域变化** → `ambiguous`(附 diff);
- 邻域**不可观测/过期** → `unobservable`。

> 这是把 agent-gavel 的 `diff→ambiguous` 落到 3D 世界的关键:签名必须**按因果范围收敛**,
> 否则生物/随机刻/红石导致的全局抖动会把 `ambiguous` 淹没。

### 6.2 归因(attribution)
- 用 Fabric 事件里的**动作主体**关联(如 `PlayerBlockBreakEvents.AFTER` 携带 player)判断
  "是不是我造成的";
- 输出 `self / foreign / unattributed`:区分"我挖掉了""别人挖掉了""变了但不知道谁干的"。

### 6.3 能力分级报告
每条事实标注可见性:**规划可见**(LLM 规划用)/**验证可见**(断言用,可更全)/**动作权限**(仅玩家合法)。
用于消融"特权观测是否必要"。

---

## 7. 简化 vs 不简化、范围 vs 精度(权衡)

| 取舍 | 选择 | 理由 |
|---|---|---|
| 全量 vs 简化 | **主动区精确体素 + 远处稀疏语义** | 兼顾几何正确与上下文/算力 |
| 体素 vs 对象图 | **两者都有**:体素是底层,对象是视图 | 对象供 LLM,体素供几何/碰撞 |
| 预先计算全部关系 vs 按需 | **按需 + 依赖失效** | 关系组合爆炸;任务区局部展开足够 |
| 特权标签 vs 推断标签 | **来源标注 + 置信**,不混同 | framework §5.3:不把推断当原生事实 |

---

## 8. 与控制的闭环

- 规划:LLM 读**语义对象/摘要** → 选动作(§10 的 L1/L2);
- 执行:动作引用 object id / target;程序查**体素/关系**算站位与路径;
- 校验:动作后用 §6 签名 + `query_state` 判定;
- 恢复:失败 → 用 `poll_delta`/`get_evidence` 拿原因 → 局部重规划。

---

## 9. 需你拍板

1. **主动区半径**默认多大?(32³ / 48³ / 64³;越大越重)
2. **语义对象**首版做哪些 kind?(建议:tree / ore_vein / container / workstation / frontier 起步)
3. **3D 表示**:先做"精确体素 + 稀疏对象"即可,还是首版就要 3D 语义场景图(对象间关系图)?
4. **视觉兜底**是否首版就接(prismarine-viewer headless 出帧),还是留接口后做?
5. **force-load 远景**是否允许(算特权观测还是特权动作)?我建议:算观测但**需任务显式声明 + 记录代价**。

### 已定(2026-10-07)

- **导航的空间表示**:先用 **`mineflayer-pathfinder` 的基础移动图**,后续升级为**多层表面图**
  (每列允许多个可站面,覆盖洞穴/多层/桥下);**保留坐标导航**为精确/逃生用途。
- **感知给 LLM 的粒度**:参考 Voyager,**只给语义/名字,不给坐标**(见 `17 §3`)。
