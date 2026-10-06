# 04 · 运行时验证、安全包络与控制/技能形式化(术语与合法性)

> 目的:把我们的话术锚定到既有形式方法/安全 RL,**避免声称发明已有概念**;并厘清
> "预测式安全包络"与"后置监视"的能力边界。核查日期:2026-10-05。

## 1. 概念 → 经典来源 → 我们怎么用

| 概念 | 经典来源(已验证/常识) | 对我们的意义 |
|---|---|---|
| **运行时验证 (Runtime Verification, RV)** | Leucker & Schallhart, *A brief account of runtime verification*, JLAP 2009 | 我们的"运行时监视器"属于 RV;不是新领域 |
| **三值 RV 语义 (true/false/inconclusive)** | Bauer, Leucker & Schallhart, *Runtime Verification for LTL and TLTL*(TOSEM 2011);*Comparing LTL Semantics for Runtime Verification*(JLC 2011) | **"pass/fail/unknown"三态在 RV 里早已确立**。我们的"ambiguous/abstain"必须引用它,不能宣称首创 |
| **Shielding(动作前干预)** | Alshiekh et al., *Safe RL via Shielding*, AAAI 2018(arXiv **1708.08611**,已核) | shield 在决策**前**给出安全动作集或纠正动作;对应我们的"预测式安全包络/反射层" |
| **Shielding under partial observability** | arXiv 2204.00755(已核存在) | 部分可观测下 shield 需要信念/概率安全——贴近游戏 |
| **控制屏障函数 (CBF) / 安全滤波器** | Ames et al., *Control Barrier Functions: Theory and Applications*(arXiv **1903.11199**,已核) | 连续控制里**预测性**排除不安全动作;是我们"本地反射闭环才能拦截"的理论依据 |
| **HJ 可达性 / 安全包络** | Mitchell/Bansal 等(HJ reachability) | 同上:预测式安全集 |
| **Options 框架** | Sutton, Precup & Singh 1999,*Between MDPs and semi-MDPs*(Artificial Intelligence 112) | **"技能=有时间延展、有启动集、有内部策略、有终止条件"** 的经典定义。我们的"技能带前置/后置"必须引用 |
| **Reward Machines / 约束 MDP** | Icarte et al. 2018;Altman 1999 | 用自动机/约束表达长程任务与安全约束 |
| **行为树 + 前置/后置** | BT 文献;PDDL precondition-effect;Hoare 逻辑 $\{P\}C\{Q\}$ | 契约式组合的经典语言 |
| **过程监督 > 结果监督** | Lightman et al., *Let's Verify Step by Step*(arXiv **2305.20050**,已核) | **跨域类比**(该结论在 MATH 推理上,非游戏执行):仅方向性支持"逐步验证优于只看终局",不构成本项目的直接证据 |
| **弃权 / 拒判** | conformal prediction、selective classification(GCPC 2608.27487 亦已用) | "证据不足时 abstain"有成熟理论,不是新发明 |

## 2. 关键区分:预测式安全 vs 后置监视(必须写进论文)

| | 预测式安全包络 | 后置断言 / 运行时监视 |
|---|---|---|
| 时机 | 动作**前** | 动作**后**(或周期) |
| 作用 | 能否**阻止**危险动作 | 只能**检测**已发生效果/违约 |
| 实现 | shield / CBF / 本地反射闭环(高频,无 LLM) | RV monitor / 世界模型断言 |
| 我们对应 | L1 Reflex + 动作前可行性检查 | L3 点后置条件 + 连续不变量监视 |

**结论**:gemini.md 说"断言一破立刻拦截致命动作"是**时序错误**——后置监视拦不住
两次轮询之间的死亡。只有高频预测式包络/反射能"拦截";监视负责发现与交还控制权。
这一点 `minecraft-framework.md §9` 已正确(退出属于行为语义、控制协调),应保留。

## 3. "连续不变量"的三类(安全/进展/终止)属于 RV 的标准用法

把高熵探索任务的不变量写成监视器:
- **安全**:`G(health > 0 ∧ fall_distance < 3 ∧ ¬in_lava)`;
- **进展**:`G(blocks_mined_in_last_N_ticks > 0)` 或 `G(distance_from_start non-decreasing)`;
- **终止后置**:`F(inventory.count("diamond") >= 3)`。

这在时序逻辑里分别对应 safety / liveness / reachability,有成熟监视综合算法。
**我们能贡献的是:把这三类不变量做成"可由 LLM 声明、由特权 oracle 以高置信度求值、
并能触发安全中断与部分积分"的统一接口**——而不是发明三值 RV 或时序逻辑监视本身。

**安全编译边界(必须)**:LLM 只能从**受控谓词词表**中选择并参数化,**不得生成任意安全逻辑**;
安全类不变量(如 `hp>0`、不落岩浆、非坠落)由系统**白名单强制存在**,LLM 不可删除或放宽。
否则就是 `07 D6` 所说的"重新引入自裁判"。

## 4. 我们相对经典 RV 的不同点

1. **部分可观测 + 观测延迟/覆盖**:经典 RV 假设事件流完整;游戏里"未加载区块/失去跟踪"
   使证据**缺失**,需要显式 `unobservable`(→ 07 的三态细分)。
2. **特权 oracle**:验证器可见信息 > 规划可见信息;必须分别报告(能力分级)。
3. **不可逆副作用**:需把 RV 与 **transaction** 结合(见 07 的事务化/补偿)。
4. **实时性**:监视器必须能在 tick 级中断并在途核对,而非离线判定。

## 5. 验证台账

| 条目 | 状态 | 方式 |
|---|---|---|
| shielding 1708.08611 | verified-real | arXiv API |
| shielding-POMDP 2204.00755 | verified-real | arXiv search |
| CBF 1903.11199 | verified-real | arXiv API |
| Let's Verify Step by Step 2305.20050 | verified-real | arXiv API |
| Options (Sutton 1999) | **canonical, 未在本次抓取** | 期刊论文,非 arXiv;引用凭常识 |
| 三值 RV (Bauer/Leucker/Schallhart) | **canonical, 未在本次抓取** | 期刊/会议,非 arXiv;引用凭常识,需在正式写作前补原文献 |
| Reward Machines / 约束 MDP | **canonical, 未抓取** | 同上 |
| 自愈测试工具 | unverifiable | 非论文 |

> 行动项(正式写作前):补 Bauer/Leucker/Schallhart、Sutton 1999、Icarte 2018 的原文
> 页码/DOI,避免"凭记忆引用"。
