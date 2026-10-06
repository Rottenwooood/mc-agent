# 02 · 技能执行的前置/后置验证与契约(跨域近邻)

> 目标:找出与"预声明契约 + 三态 + 技能沉淀 + 局部修复"最接近的工作,界定真正的新颖性。
> 核查日期:2026-10-05。台账见文末。摘要存 `sources/`。

## 1. 最近的跨域近邻(2026 集中爆发)

| 工作 | id/年 | 机制 | 与我们的关系 |
|---|---|---|---|
| **EmbodiedSkills** | 2609.01281 / 2026-09 | 把"技能决策"当作 **execution proposal**:runtime 执行前查 prerequisites,执行后 verify outcome;共享可执行技能接口连接高层选择、有界低层 VLA 执行、后置验证;记录 planning/execution/verification/recovery 结构化轨迹 | **机器人/具身版我们**。已含"前置检查+有限执行+后置验证+恢复"。差异:VLA/连续控制、机器人基准(RoboTwin/LIBERO/RMBench),非实时部分可观测游戏,未见显式"拒判/证据分级" |
| **CoEvoSkills** | 2604.01687 / 2026-04 | **生成器 + 替代验证器(无真值测试)共同演化**,自动构造多文件技能包 | 技能自进化 + 验证器共演化;但偏向软件 skill 包,非具身执行 |
| **SkillGen** | 2605.10999 / 2026-05 | 对成功/失败轨迹做 **对比归纳**,把技能建模为 **干预**:在同实例上 with/without 技能比较,区分 **repairs 与 regressions**;输出可审计技能,迭代精炼 | **直接对标**:它已把"技能是否真的有用"做成可信实验,而非 LLM 自评 |
| **SkillAdaptor** | 2606.01311 / 2026-05 | 训练无关的 **step-level 技能适配**:给出失败轨迹 → 定位 **首个可操作故障步(first actionable fault step)** → 关联责任技能 → 定向更新 + 显式 acceptance checks | **= 我们的"失败归因 + 局部修复"**,已在 WebShop/Claw-Eval 等验证 |
| **Trace2Skill** | 2603.25158 / 2026-03 | 并行归纳大量轨迹为统一技能目录,可深化人工技能或从弱草稿生成 | 轨迹→技能蒸馏 |
| **GCPC** | 2608.27487 / 2026-08 | **证据接地 + 弃权**的部分分评测:人类定规则,LLM 实例化 checklist,judge **仅依据执行日志证据打分,证据缺失时 abstain**;再由脚本套官方 verifier | **相近但不同**:GCPC 是**评测 judge 的弃权/部分分**,不是**执行器在环境中拒绝行动**;其"证据接地"思路可借 |
| ExpeL | 2308.10144 / 2023 | 从经验中抽取/复用教训 | 早起经验学习 |
| Reflexion | 2303.11366 / 2023 | 语言化自我反思 | 弱反馈基线(我们主张用外部 verifier 替代) |

## 2. 软件域的最近祖先:自愈测试 / 契约

- **Self-healing E2E 测试**(self-healing locators:Healenium/Testim;robust locator 修复;flaky-test repair):失败定位后**只修复失效的定位,不重跑整条**——这正是 agent-gavel 的 `_try_repair`(runner.py:404)与 MC 版"局部修复"的软件同构。
- **Property-based testing / oracle 作为裁判**:预声明不变量,随机输入证伪;与我们"预声明后置契约"同源。
- **契约式/霍尔逻辑**:pre/post-condition 是经典程序验证术语,不宜宣称为新。

## 3. 对新颖性的直接冲击

1. **"前置检查 + 有限执行 + 后置验证 + 恢复"** 已在 **EmbodiedSkills**(具身)完整提出(2026-09)。
2. **"失败归因 + 只改失效部分"** 已在 **SkillAdaptor**(2026-05)以 step-level fault attribution 实现。
3. **"证据不足时拒判 + 部分分 + repair/regression 区分"** 已在 **GCPC**(2026-08)与 **SkillGen**(2026-05)实现。
4. Voyager 有 self-verification 与技能库;但其 verifier **是否足以防污染,摘要不足以证明**(待全文核查)。

**因此:把论文主张写成"我们首次把断言/契约/技能进化用于 agent"必然被拒。** 可行空间在"**实时、部分可观测、不可逆副作用、对抗性**的具身游戏环境中,上述机制如何专门化与测量"——见 07。

## 4. 仍可主张的差异假设(待实验证伪)

- 上述 2026 工作多在**文本/工具型或机器人 VLA**场景;**实时游戏(World 持续自变、动作不可逆、tick 级抢占)** 下的:
  - **因果归因**(状态差异≠我造成)是否被显式建模并测量?
  - **安全中断**的在途效果核对/落地/退出语义?
  - **拒判三态**(pass / fail / ambiguous-unobservable)对**误报成功**的影响?
  - **特权 oracle 的证据分级与可迁移性**(规划可见 vs 验证可见 vs 动作权限)?
- 这些是 04/05/07 要继续钉死的点。

## 5. 验证台账

| slug | id | 状态 | 备注 |
|---|---|---|---|
| embodiedskills | 2609.01281 | verified-real | 机器人/VLA,非 MC |
| coevoskills | 2604.01687 | verified-real | 生成器-验证器共演化 |
| skillgen | 2605.10999 | verified-real | 干预式技能 net-effect |
| skilladaptor | 2606.01311 | verified-real | step-level 归因+局部修复 |
| trace2skill | 2603.25158 | verified-real | 轨迹蒸馏 |
| checklist | 2608.27487 | verified-real | 证据接地+弃权部分分 |
| expel | 2308.10144 | verified-real | API |
| reflexion | 2303.11366 | verified-real | API |
| (SkillGen 旧同名) | 2511.14670 | verified-real | 另一篇同名,非本义 |
| 自愈测试工具 | — | unverifiable(非论文) | 商业/开源工具,未逐条抓取 |
