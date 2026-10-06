# 14 · 运行时拓扑、通信与 Mod 数据契约

> `12` 的 B2 + B4。定进程/协议/时钟,以及只读 Fabric Mod 对主程序暴露的数据接口。
> 对齐 `minecraft-framework.md §2`(HTTP 快照 + 事件长轮询)并补上视觉与新决策。
> 日期:2026-10-05。设计稿,§8 待拍板。

---

## 1. 进程拓扑

```text
[现有 LLM/MCP 客户端]
        |  MCP (stdio/HTTP)
        v
┌─────────────────────────────────────────────┐
│ Agent Runtime  (Node.js / TypeScript, 主进程) │
│  ├─ MCP server(动作/感知/技能工具)          │
│  ├─ 执行引擎(§15):三速度闭环/调度/中断        │
│  ├─ 感知客户端(HTTP 查询 + 事件订阅)          │
│  ├─ 技能/模板库 + 断言引擎(§13)             │
│  └─ Mineflayer bot(控制,协议客户端)         │
└───────┬───────────────────────┬──────────────┘
        | Minecraft 协议         | HTTP(只读快照/事件)
        v                       v
   [MC 服务器(Fabric)] ←──── [自研 Fabric 观测 Mod]
        ^
        | 正常入服(可选)
   [有头客户端(观看/视觉)]         [prismarine-viewer(headless 出帧,可选)]
```

- **一个主进程**放:控制(bot)、执行、断言、技能库、MCP。首版不拆服务。
- **Fabric Mod** 独立语言/进程,只做只读观测 + 区域标记,通过 HTTP 与主进程通信。
- 可选:真实有头客户端连入观看;`prismarine-viewer` headless 出帧喂 VLM。

---

## 2. 通信协议选型

| 通道 | 方案 | 说明 |
|---|---|---|
| 主程序 ↔ Mod(批量) | **HTTP 只读接口** | `/snapshot` 局部查询、`/events` 带游标长轮询、`/markers` 区域标记;实现简单、可控 |
| 主程序 ↔ Mod(低延迟/推送) | **自定义 payload(plugin channel)** | Mod `ServerPlayNetworking.send(botPlayer, payload)` → Mineflayer `bot._client` 收;bot 可回发。适合少量高时效通知 |
| 主程序 ↔ 视觉 | prismarine-viewer headless(TCP/文件) | 出帧给多模态 |
| 模型 ↔ 主程序 | MCP | stdio/HTTP |

**建议**:批量用 HTTP(framework 既定),高时效用 payload 作补充;首版可**只用 HTTP**,把 payload 留作优化。

---

## 3. 时钟与动作↔事件关联(归因基础)

- **权威时钟 = 服务端 tick**(Mod 提供 `server_tick`)。
- 动作派发时,主程序记录 `action_id`、`start_tick`、`causal_scope`、`requested_by`。
- Mod 在事件里带 `tick` 与**动作主体**(player UUID / 实体)。
- **关联 ≠ 因果**:`event.tick ∈ [start_tick,end_tick]` 且 `scope ∩ causal_scope ≠ ∅` 只能建立
  **时间相关**;随机刻、红石、爆炸、其他玩家、延迟事件都可能落入窗口。
- **证据等级**:`temporal_association` 默认**不足以判 self**;**唯一**提升为因果的途径是
  服务端**动作确认/事务关联**(Mod 在动作生效回调里携带 `action_id`/`actor`,或状态转移与动作同一事务)。
- **不接受"排除其他 actor"作为提升依据**:即使窗口内没有其他玩家/实体事件,也排除不了
  **随机刻、红石、流体、重力、区块边界**等**非 actor** 原因 → 排除法**不能**产出 `self_confirmed`。
- **首版约定**:主程序不发 `action_id` 给 Mod(保持 Mod 只读),因此归因**只能到 `self_temporal`**,
  不得记 `self_confirmed`。
- 归因取值:`self_confirmed | self_temporal | foreign | unattributed`。
- 若将来启用服务端动作确认,才允许 `self_confirmed`,且需 Mod 侧建立"动作→事件"关联通道。

---

## 4. Mod 只读接口契约(HTTP)

### 4.1 `GET /healthz`
`{ ok, server_tick, mod_version, mc_version, dimensions:[...] }`

### 4.2 `POST /snapshot`(局部快照,有界)
请求:
```jsonc
{
  "scope": { "kind":"box", "min":[x,y,z], "max":[x,y,z] }   // 或 {"kind":"radius","center":[..],"r":32}
           | { "kind":"egocentric", "r": 24 },
  "want": ["blocks","block_entities","entities","inventory","self"],
  "filters": { "block_ids": ["minecraft:diamond_ore"], "entity_types": ["minecraft:creeper"] },
  "max_items": 512
}
```
响应:
```jsonc
{
  "server_tick": 12345,
  "revision": 90210,
  "coverage": { "loaded": true, "truncated": false, "boxes": [[...]] },
  "self": { "pos":[x,y,z], "yaw":.., "hp":.., "food":.., "dim":"overworld", "gamemode":"survival" },
  "blocks": [ { "pos":[x,y,z], "block":"minecraft:oak_log", "state":{...}, "source":"authoritative" } ],
  "block_entities": [ { "pos":[...], "type":"minecraft:chest", "nbt_summary": { "items":[{"slot":0,"id":"minecraft:coal","count":8}] } } ],
  "entities": [ { "id":123, "type":"minecraft:cow", "pos":[...], "hp":.., "source":"authoritative" } ]
}
```
- **有界**:`max_items`、`truncated` 标志;超范围/未加载 → 在 `coverage` 里标 `loaded:false`。
- **快照一致性**:一次 `/snapshot` 必须在**同一 server tick** 原子读取,`snapshot_seq` 标识该边界;
  **全局 `revision` 只表示"世界某处变了"**,不能用于证明**目标**事实变化——每个 fact 必须带
  **自身版本** `obs_seq/observed_tick`(见 §5)。
- 只读:无任何写操作。

### 4.3 `GET /events?since=<cursor>&max=<n>`(事件长轮询)
响应:
```jsonc
{
  "epoch": 3,
  "cursor": { "epoch": 3, "seq": 90215 },
  "has_more": false,
  "events": [
    { "seq":90211, "tick":12340, "type":"block_changed", "pos":[...], "before":"minecraft:oak_log", "after":"minecraft:air", "actor":"<player_uuid>", "attributed_to":"self|foreign|unknown" },
    { "seq":90212, "tick":12341, "type":"entity_hurt", "id":123, "damage":4, "source":"<uuid>|unknown" },
    { "seq":90213, "tick":12342, "type":"container_changed", "pos":[...] },
    { "seq":90214, "tick":12342, "type":"chunk_loaded|chunk_unloaded", "chunk":[cx,cz] }
  ]
}
```
事件类型(首版):`block_changed`、`block_placed`、`entity_spawn/despawn/hurt/death`、`container_changed`、`chunk_loaded/unloaded`、`explosion`、`piston_move`、`player_join/leave`。
- 每条带 `seq`(单调)+`tick`;**长轮询**在无新事件时挂起至超时或有事件。

**协议完整性(直接影响断言可靠性)**:
- **有界缓冲**:服务端维护环形缓冲(容量 N);若请求 `since` 早于缓冲最旧 seq → 返回
  `{"reset_required": true, "earliest": <seq>}`;调用方必须**全量重取快照**,不得假设连续。
- **溢出**:缓冲满时丢弃最旧(可能丢事件)→ 触发 `reset_required`。
- **重复**:`seq` 严格单调且**幂等**;重连可能重发,调用方按 `seq` 去重。
- **断线重连**:带上次 `cursor` 重连,服务端从其后继续。
- **分页一致性**:`max` 截断时返回 `has_more`;分页按 `seq` 升序,不跨 epoch。
- **重启 epoch**:`seq` 在服务器重启后可能重置 → 游标为 `{epoch, seq}`;epoch 变化 = `reset_required`。

### 4.4 `GET/POST /markers`(区域标记,持久化)
- `GET /markers` 列出;`POST /markers` 创建/更新(仅标记,不改世界);委托 `SavedData`。
- 字段:`{id, kind, box|pos, label, source(manual|blueprint|algorithm), created_tick}`。

---

## 5. 数据分级与新鲜度(线格式统一)

每条事实/事件带:
```jsonc
{ "source": "authoritative|observed|predicted|inferred",
  "tick": 12345, "seq": 90211, "coverage": {...}, "confidence": 1.0 }
```
- 未加载/未覆盖 → 调用方必须按 `unknown` 处理;
- 过期(chunk 卸载/失去跟踪)→ 由主程序按 `tick` 与覆盖失效;
- **每事实版本**:`obs_seq`(该事实最后一次出现的 seq)/`observed_tick`;效果验证必须比较**目标事实自身**的新旧,
  而非全局 `revision`。

---

## 6. 安全与边界
- Mod **只读**:任何接口都不改世界;权限:仅本 bot 的观测会话。
- HTTP 仅本地/内网;鉴权用一个共享 token。
- force-load 远景(若启用)由 Mod 以受控能力提供,**记录代价**,且仍只读。

---

## 7. 与"完整模式"的关系
- 不装 Mod 时:主程序退化为"仅 Mineflayer 可见信息",断言证据降级为 `observed/predicted`(本设计**只做完整模式**,但保留该降级以支撑 Q4 消融)。

---

## 8. 待你拍板
1. 主程序语言确认 **Node/TypeScript**?(与 framework 一致;Mineflayer 原生)
2. 通信:**只用 HTTP**(简单)还是 HTTP + 自定义 payload(更快)?建议先 HTTP。
3. 事件首版集合(§4.3)是否够用?
4. force-load 是否在首版提供(只读)并记录代价?
