# 12 · 缺口清单(现阶段该搞没搞的)

> 对照 `docs/` 现有设计(`minecraft-framework.md` / `minecraft-layering.md` / `research/08–16`)与已定约束(控制=Mineflayer、观测=Fabric 只读、
> 完整模式、优先可用系统、参考 Voyager)。日期:2026-10-05。P0=不补没法开始编码;P1=应尽快;P2=可后置。

## A. 文档卫生(顺手清)

| 项 | 现状 | 处置 |
|---|---|---|
| ~~MineAgent 残留引用~~ | **已清**:`01/02/07/08/INDEX` 已去除;仅保留"已排除"说明 | ✅ 完成 |
| 文档编号跳空 | 无 `03`(已删) | 可接受;INDEX 已重排,不必强行补号 |

## B. P0 · 设计缺口(卡住编码)

### B1. 动作契约与断言引擎 schema(MC 版)——**最缺**
- 现状:`10/11` 只有散文("主要前置/后置"),没有正式 schema。
- 缺:
  - **谓词语言**:`{subject, predicate, value, scope, not_before_tick, min_confidence}` 的正式定义;
  - **动作契约声明**:每个 L1 动作如何声明 pre/post + 副作用类 + 可中断性;
  - **模板 schema**(对应 agent-gavel `schema.py`):steps / params / checkpoints / **invariants** / version / stats / failure_policy;
  - **结果 schema** 的字段冻结(10 §1.2 只是初稿)。
- 为什么 P0:断言是整套机制的核心,不确定 schema,动作/感知/执行都悬空。

### B2. 运行时拓扑与进程/协议(更新版)
- 现状:`minecraft-framework.md §2` 有旧拓扑(Node+Mineflayer+HTTP Fabric)。
- 缺(受新决策影响):
  - 进程划分:LLM/MCP ↔ Node 执行器 ↔ Mineflayer ↔ Fabric Mod / 服务器 / 视觉;
  - **通信协议**:HTTP 快照 + 事件长轮询 vs 自定义 payload?端口/序列化?
  - **控制↔观测时钟对齐**:Mineflayer 动作与 Fabric 事件如何用 `action_id` + tick 关联(归因基础);
  - MCP 边界:模型入口在哪、执行循环归谁。

### B3. 执行引擎 / 控制循环 / 调度 / 中断
- 现状:framework §4/§9 有原则(三速度闭环、单执行分支、中断按行为)。
- 缺:
  - 三速度闭环的具体实现职责(reflex 20Hz / task executor / LLM planner);
  - **控制资源仲裁**(同一时刻只有一个"身体"动作);
  - **抢占/中断**:任意点中断、在途效果核对、安全停止、控制交还;
  - **安全包络 vs 后置监视**的落地(谁能"拦截");
  - 任务队列、pause/resume、局部修复。

### B4. Mod ↔ 主程序 数据契约
- 现状:`11` 描述了概念,LCD 无接口规范。
- 缺:
  - 只读快照查询 API(字段/分页/范围上限);
  - 事件流 schema(break/place/entity/chunk/container/explosion…);
  - **revision/observed_tick/coverage/来源**的线格式;
  - 区域标记(SavedData)格式;
  - chunk 加载策略与代价记录;`isLoaded` 语义。

### B5. 环境与工具链 / 可复现运行
- 现状:无。本机有 Java 21,**无 Gradle**。
- 缺:
  - Fabric 工程脚手架(Gradle、版本锁、Yarn/Mojang mappings、access widener、mixins);
  - 启动栈:服务器 + Fabric Mod + Mineflayer bot + (可选)有头客户端 + prismarine-viewer;
  - **可复位世界**(种子/存档重置),供实验;
  - 依赖版本矩阵与 fixtures。

## C. P1 · 设计缺口(尽快)

### C1. MCP 暴露层契约
- 工具命名/分组/结果格式;感知工具(11 §5)与动作工具(10 §2)如何注册;技能暴露(10 §4)与工具列表管理。
- 与 B1 的 schema 强耦合。

### C2. 持久化 / 记忆 / 对象引用
- 世界状态是否持久化;**对象引用版本化**(跨重启/维度/容器窗口);空间记忆/任务记忆/技能记忆。
- 与组方向(memory)可能重叠,值得单独设计。

### C3. 蓝图 / 建造声明格式
- 声明式体素目标 schema(供 `build_blueprint`、进度断言、集合差验收)。

### C4. LLM 上下文工程
- system prompt、工具 schema 暴露、记忆/技能注入、**上下文预算**、观测摘要策略(11 §4 的接口纪律落地)。

### C5. 端到端垂直切片
- 选一个任务(如"砍一棵树拿到原木")走查:observe→plan→act→assert→repair,用来**验证接口是否闭环**、暴露缺口。

## D. P2 · 后置

- D1. 评估 harness(可复位 server、指标采集:误报成功/拒判/污染/代价;06 只有指标无实现)。
- D2. 测试策略(语义测试 / 回放测试 / 集成测试;layering §7 提及,无落地方案)。
- D3. 基线接入(Voyager 匹配环境复现)、跨域(ALFWorld/Crafter)。
- D4. 多实例/并行 session。

## E. 决策缺口(需你拍板;不拍无法定 P0 的细化)

1. 域优先级 / 首个里程碑(10 §7)。
2. 组合落地 A/B/C + 晋升阈值(10 §4)。
3. 主动区半径、首版语义 kind、3D 表示程度、视觉兜底时机、force-load 归属(11 §9)。
4. 原子粒度(约 40 个是否精简)、`steer`/`run_command` 逃生舱是否保留(10 §8)。
5. L2 用参数化 JSON 还是允许 LLM 脚本(10 §8)。
6. 通信协议:HTTP vs 自定义 payload(B2)。

## F. 建议的下一步(顺序)

1. 清 A(文档卫生)。
2. 写 **B1 动作契约与断言 schema**(P0 核心,解锁其余)。
3. 写 **B2/B4 运行时拓扑 + Mod 数据契约**(P0,解锁通信)。
4. 写 **B3 执行引擎/中断**(P0)。
5. 写 **B5 环境与工具链**(P0,动手前提)。
6. 同时请你定 E 的 6 项决策。
7. 再写 C1–C5,然后进入最小实现。
