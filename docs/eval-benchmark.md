# 实机 Benchmark 与评测设计(agent 驱动)

> 依据:`research/06`(指标/独立验收器/消融)、`07`(promotion gate/种子隔离)、`04`(安全延迟)、`16`(可复位世界)。
> 配套:`mcp-implementation-framework.md`。状态:**设计,待实现**。日期:2026-10-07。

---

## 0. 目的与铁律

目的:在**真实运行、可复位**的 Minecraft 世界里,度量"证据约束的技能执行 + 选择性拒判"是否在可接受成本下降低**误报成功**与**不安全恢复**。

**铁律(防糊弄)**:
1. 任务由 **agent 通过 MCP 工具自主完成**,**禁止写死动作脚本**(runner 只负责:重置世界、给目标、采日志、调独立验收器)。
2. 允许存在**非 LLM 的"工具 smoke / dry-run"**,但它只证明"工具在真实 MC 里能连通/参数/结构正确",**不得**当作任务完成或机制有效的证据。
3. 结果判定用**独立外部验收器**(§6),其判定逻辑**不得复用**系统的谓词/断言引擎或直接采信系统结论。
4. 所有报告必须**同时**给出:完成率 + 误报率 + 非 pass 三分 + 成本;**禁止**用"全返回 unknown"压误报。

## 1. 两类测试(严格分开)

| 类型 | 谁驱动 | 证明什么 | 是否算完成 |
|---|---|---|---|
| **A. 工具 smoke / dry-run** | 测试脚本(无 LLM) | 工具在真实 MC 中连通、参数正确、返回 `ActionResult` 结构正确 | **否** |
| **B. 实机 benchmark** | **agent(LLM)经 MCP** | 机制在真实任务上的完成/误报/拒判/成本 | **是** |

> A 的产物只进入 `tests/integration` 的连通性报告;B 的产物进入评测报告。两者**不得混列**。

## 2. 世界与种子(隔离)

- **固定**:MC 1.20.1 + 固定 Mod 版本 + 固定种子集合 + 固定任务套件。
- **种子三分(硬隔离)**:
  - `scenarios/seeds/train.txt` —— 允许试错、生成技能;
  - `scenarios/seeds/val.txt` —— 决定**技能是否入库/选型**;
  - `scenarios/seeds/test.txt` —— **只在最终报告使用,绝不参与任何选择/调参/入库**。
- **世界重置**:`tools/reset-world.sh <seed> [fixture]`
  - 从**干净世界模板**按种子重建(存档复制或重新生成);
  - 可选加载 task fixture(预置地形/结构/容器/怪物);
  - 记录 `seed`、`server_tick`、Mod `revision`。
- **复现记录**:每次 episode 落盘 `{mc_version, mod_version, seed, fixture, model_id, prompt_hash, start_tick, end_tick, wall_clock, token_usage}`。

## 3. 任务套件(覆盖不同反馈性质)

每个任务定义(`scenarios/tasks/<id>.yaml`):`goal`(可检查条件)、`scope`(允许范围/资源/修改范围)、`budget`、`stop_conditions`、`fixture`、`verifier`。

| id | 任务 | 目标(独立证据) | 反馈特征 |
|---|---|---|---|
| T1 | **采集木材** | 背包获得 N 个原木 **且** 目标树干方块被移除 | 目标物 + 掉落物入包,两独立证据 |
| T2 | **挖矿脉** | 找到并开采一条指定矿脉,背包获得矿物 | 连通块、深度、可能需要先做工具 |
| T3 | **建造** | 按小蓝图建成(体素集合差=空)**且**满足通行语义(可走过) | 体素目标 + 语义验收,两步 |
| T4 | **探索并安全返回** | 到达目标区域 **且**安全返回基点,全程未违反安全不变量 | 高熵 + 终止后置 + 安全 |
| T5* | 合成链(如"从零做木镐/石镐") | 背包出现目标产物 | 依赖链、需工作台 |
| T6* | 容器物流 | 目标容器内容符合预期 | 开窗/槽位 |
| T7* | 农牧 | 作物/幼体状态符合预期 | 周期等待 |

\* 首版先做 **T1–T4**;T5–T7 视进度补。

## 4. 扰动(每任务施加)

跨地图种子、材料缺失、目标被外部实体改变、怪物接近、服务端拒绝(权限/规则)、观测中断、重复请求(幂等/去重)。
→ 用于验证"正常通过"之外的鲁棒性,以及安全/恢复语义。

## 5. 运行器(agent 驱动,禁止写死)

`tests/eval/runner`:
```
for case in cases(task × seed × config):
    reset-world(seed, fixture)
    start(resident-agent + MCP-bridge)         # 真实进程栈
    goal = render(task)                         # 只给自然语言目标 + 约束 + 预算
    run_agent_via_mcp(goal, budget)             # LLM 自主调工具;runner 不编码步骤
        record: 每次工具调用与 ActionResult、世界事件日志(Mod)、墙钟、token
    stop on: 目标达成 / 超时 / 预算耗尽 / 安全交还
    final = snapshot_world()
    verdict = independent_verifier(task).judge(final, events)   # 与系统判定独立
    write episode record
```
约束:runner **只**做上列 6 件事;任何"步骤序列、坐标、成功判定"都不得写进 runner。

## 6. 独立外部验收器(§ 防止误报率循环定义)

验收器必须与内部断言引擎**判定逻辑独立**,满足其一:
- **独立实现**的任务判定(不由断言引擎生成、不共享谓词);
- **隐藏状态/隐藏目标**(系统不可见,验收时读出);
- **不同来源/模态**(服务端存档离线判定 / 结构化事件离线重放);
- **人工抽检**。
可读**同一份世界状态**,但**判定逻辑**必须独立。记录"验收器是否复用了系统谓词/结论"。

## 7. 指标(必须同时报告)

- 任务完成率(独立验收器)。
- **误报成功率**(头号):系统报 `pass` 但验收判 `fail`;分母 = 所有系统报 `pass` 的实例(写明按任务/按尝试)。
- 非 pass **拆开**:`confirmed_fail`(有证据没达成)/ `insufficient_evidence`(真正的弃权)/ `blocked`(没执行)。
- 技能库污染率:入库技能在留出种子上重放失败比例。
- repair/regression:同一实例 with/without 技能的净效果。
- **安全停止延迟**:危险出现 → 控制停止的 tick 数。
- 恢复成功率:中断后重新核对并完成的比例。
- 成本:LLM token、MCP/工具调用数、墙钟、资源消耗。
- **能力分级消融**:分别撤 (a) 服务端特权验证、(b) 视觉后备,报告规划可见/验证可见/动作权限。

## 8. 消融链(每项单独开关,不同时加)

① 开环动作链 → ② 仅终点检查 → ③ 逐步后置检查 → ④a +执行期安全不变量 → ④b +`ambiguous/unobservable` 细分 → ④c +因果归因 → ⑤a +局部修复 → ⑤b +技能入库。
再**各撤一项**:撤服务端特权验证;撤视觉后备。
(目的:把"局部修复""技能入库"的增益分开,并单看"细分""归因"各自值不值。)

## 9. 对照基线(匹配环境)

与 Voyager 及其"步骤暂停/特权"假设对照时,**必须匹配环境**(同种子、同 Mod 特权、同暂停策略),否则无效;并报告各自的"规划可见/验证可见/动作权限"。

## 10. 目录与脚本

```text
scenarios/
├── tasks/<id>.yaml            # 目标/范围/预算/停止条件/fixture/verifier 引用
├── seeds/{train,val,test}.txt
├── fixtures/                  # 预置地形/结构/容器/怪物
└── blueprints/                # T3 的体素蓝图
tests/
├── eval/runner                # agent 驱动运行器(§5)
├── eval/verifiers/            # 独立外部验收器(§6)
├── eval/metrics/              # 指标与报表(§7)
└── integration/tool-smoke     # 非 LLM 工具 smoke(§1.A)
tools/
├── reset-world.sh <seed> [fixture]
└── bench-up.sh                # 起常驻进程+MCP桥+benchmark 运行器
```

## 11. 达标判定(何时可说"机制有效")

只有在**test 种子**上满足:`完成率` 可接受、`误报率` 显著低于基线、且 `insufficient_evidence` 率不失控、成本在预算内 —— 才算证据;否则视为**被证伪**(设计本身允许被否定)。
