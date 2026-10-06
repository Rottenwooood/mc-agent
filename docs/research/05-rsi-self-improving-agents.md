# 05 · RSI / 自我改进 Agent 与验证器(reward hacking 视角)

> 目的:把"技能自进化 = RSI"的叙事锚定到既有工作,并明确**瓶颈在验证器质量**。
> 核查日期:2026-10-05。

## 1. RSI / 自改代码谱系

| 工作 | id/年 | 机制 | 对我们的启示 |
|---|---|---|---|
| **Gödel Machine** | Schmidhuber 2003(理论) | 自我改写且**可证明有益**才接受 | 理论源头;"可证明有益"在实践不可行 → DGM 改为经验验证 |
| **Darwin Gödel Machine (DGM)** | 2505.22954 / 2025 | LLM 改写自身代码,用编码基准**经验验证**;维护 agent 档案,开放-ended 进化树;SWE-bench 20%→50% | **"自我改进靠经验验证基准,而非可证明性"** 的直接先例;它有 sandbox/人类监督 |
| **STOP (Self-Taught Optimizer)** | 2310.02304 / 2023 | LM 写脚手架程序改进自身;非全 RSI(模型不变);研究绕过 sandbox 的频率 | 自改代码的安全隐患 |
| **Self-Rewarding LMs** | 2401.10020 / 2024 | LLM-as-a-Judge 自产奖励,迭代 DPO | **反面教材**:自裁判可改善,但正是"奖励崩塌/自欺"风险的来源 |
| **Voyager** | 2305.16291 | 技能库 + 自动课程 + LLM 自验证 | 我们声称要替代其"自验证" |

## 2. 为什么"外部接地验证器"是核心(且已被反复认识)

- 多个工作(Reflexion、Self-Refine、Self-Rewarding)使用**弱/自产反馈**;一种**风险推论**是
  这会导致**静默失败、奖励作弊、幻觉累积**——注意:这是**我们的推断/风险**,**不是这些论文已证明的结论**
  (它们各自报告了改进)。应作为**待检验假设**,由 `06` 的消融验证。
- **Let's Verify Step by Step**(2305.20050)**报告**(在 MATH 上)过程监督优于结果监督——
  **跨域类比**,仅方向性支持"点后置条件"而非"只看终局"。
- **Defining and Characterizing Reward Hacking**(2209.13085)给出 reward hacking 的形式化:
  代理奖励与真奖励在最优策略处偏离。
- **关键推论**:验证器越接近**真值(ground truth)**、越**细粒度**、越**抗自欺**,
  RSI 循环越可靠。Minecraft 的 Fabric 服务端 Mod 正好提供这种**接地真值**。

## 3. 2026 技能自进化(与 02 交叉)

`CoEvoSkills`(生成器-替代验证器共演化)、`SkillGen`(干预式 net-effect 验证,区分
repair/regression)、`SkillAdaptor`(step-level 归因 + 定向修复 + acceptance check)、
`Trace2Skill`(轨迹蒸馏)、`GCPC`(证据接地 + 弃权的部分分)。

**共同点**:都把"验证/归因/拒判"作为技能进化的**质量门**。
**共同缺口**:多在文本/工具/软件域;具身实时游戏下的验证器设计与安全中断仍薄。

## 4. 我们对 RSI 的合理定位

不要主张"我们实现 RSI"。应主张:
> 在**实时、部分可观测、副作用不可逆**的具身环境中,用一个**接地的、证据分级的
> 特权验证器**替代 LLM 自评,把"技能沉淀/局部修复/拒判"变成一个**可测量**的闭环;
> 并量化**验证器质量(误报/拒判/污染)对 RSI 净收益**的影响。

即把 RSI 当**被测评对象**,而非卖点。这更窄、更可证伪(见 07)。

## 5. 需要补的经典文献(正式写作前)

- Schmidhuber, *Gödel Machines*(2003/2007)——非 arXiv,凭常识引用。
- Icarte et al., Reward Machines(ICML 2018)——凭常识。
- 泛化/开放-ended:Wang et al. 2019, POET;Clune 2019, AI-GAs——凭常识,待补。

## 6. 验证台账

| slug | id | 状态 |
|---|---|---|
| dgm | 2505.22954 | verified-real |
| stop | 2310.02304 | verified-real |
| selfreward | 2401.10020 | verified-real |
| letsverify | 2305.20050 | verified-real |
| rewardhack-def | 2209.13085 | verified-real(仅由 search 列表确认标题/年) |
| voyager | 2305.16291 | verified-real |
| 其他 2026 技能自进化 | 见 02 | verified-real |
| Gödel Machine / Reward Machines | — | canonical,未抓取 |
