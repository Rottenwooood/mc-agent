# 07 · 综合:空白、精炼方案与可证伪问题

> 汇总 01–06。核查日期:2026-10-05。这是本次调研的结论文档。

## 0. 一句话结论

**"预声明断言 + 三态 + 技能沉淀 + 局部修复"很可能已不再是空白**:2026 年软件/工具域的
(EmbodiedSkills / CoEvoSkills / SkillGen / SkillAdaptor / GCPC)**摘要显示其提出了相关机制**,
但**完整实现范围与可靠性尚未经全文核查**(见 §7 待办;`sources/` 目前基本只有摘要)。
**可做的不是提出该机制,而是把它在"实时、部分可观测、副作用不可逆、对抗性"的
具身游戏环境里专门化,并用可复现实验证明其增益。**

## 1. 地貌:机制各环都已有先例

| 机制环节 | 已有先例 |
|---|---|
| pre/post-condition 契约 | EmbodiedSkills、PDDL/Hoare、BT |
| 三值判定/弃权 | Bauer-Leucker-Schallhart 三值 RV、GCPC(证据缺失 abstain) |
| 世界状态 diff 作为证据 | agent-gavel |
| 证据分级(预测 vs 权威) | 服务端权威真值(本设计);软件域:官方 verifier |
| 技能库 + 防污染 | Voyager |
| 失败归因 + 局部修复 | SkillAdaptor(step-level fault)、agent-gavel(runner repair) |
| 技能 intervenion net-effect | SkillGen(repairs vs regressions) |
| 生成器-验证器共演化 | CoEvoSkills |
| 安全抢占 | shielding(1708.08611)、CBF(1903.11199) |
| 自我改进闭环 | Voyager、DGM(2505.22954)、STOP(2310.02304) |
| 逐过程监督优于终局 | Let's Verify Step by Step(2305.20050) |

## 2. 真正的 delta(可主张、待证伪)

**前提(避免与前文自相矛盾)**:三值 RV、弃权、shielding/安全监视在经典文献中**已有先例**(见 `04`),
故以下**不是机制首创**,而是**具体实例化 + 因果归因 + 评测**:

1. **在实时/部分可观测/不可逆副作用的 MC 环境中具体实例化三态**:把 `ambiguous` 落到
   "因果邻域世界签名 diff",把 `unobservable` 落到"未加载/失去跟踪",给出可操作判据与证据格式。
2. **因果归因**:区分 self/foreign/unattributed,并**明确证据等级**(temporal association vs
   server action confirmation,见 `14`)——经典 RV 假设事件流完整且已归因,游戏不满足。
3. **执行期安全监视的即时性**:预测包络 vs 后置监视在 tick 级游戏中的切分与**延迟边界**(见 `15`)。
4. **不可逆副作用的处理**:检查点/补偿语义(不只是审计日志)。
5. **能力分级报告**:规划可见 / 验证可见 / 动作权限三分,测"特权是否必要条件"。
6. **评测**:误报成功 / 拒判 / 污染 / repair-regression / 安全延迟 / 代价,且**用独立外部验收器**
   定义误报(见 `06`)。
7. **跨域迁移**:同一实例化在 MC 与软件/机器人基准上的对照。

> 表述纪律:以上为**待证伪假设**,非已证结论;`01/02/05` 中依赖摘要的论断须标注"待全文核查"。

## 3. 精炼架构(把既有文档 + 各近邻工作的教训合并)

```
L0 Embodiment Adapter (Fabric 服务端 Mod + 玩家协议)
   证据分级: {sent | predicted | observed | attributed} × {scope,time,source,version}
   对象引用版本化;未加载/失去跟踪 → 显式 unknown
L1 Reflex / Shield (tick 高频, 无 LLM)      ← 唯一能"拦截"的一层(预测式)
   安全包络 + 控制资源独占 + 中断/退出语义
L2 Primitive (可中断, 效果可解释, 底层判据不可删)
   副作用分类: read / 幂等 / 消耗 / 不可逆(→检查点+确认)
L3 Contract Engine
   点后置条件判定代数: pass | fail(cause) | ambiguous | unobservable
       ambiguous/unobservable 由"因果邻域世界签名 diff + 因果归因"判定
   连续不变量(安全/进展/终止) monitor → 违反则 tick 级中断并交还
   终止后置(整体验收, 不汇总子步)
L4 Skill Layer
   低熵 → 冻结模板(目标条件化, 非字面重放) + 局部修复 + 版本
   高熵 → 进化技能, 同一契约当适应度; 干预式 net-effect 验证(repair vs regression)
   防污染: 仅整体成功 + 留出多种子重放通过才入库
L5 Meta / Eval
   课程(能力边缘) + 技能库晋升/退役 + 误报/拒判/污染/代价评测
```

**与既有文档的三处升级**:① `ambiguous` 的**可操作判据** + 因果归因;② 字面重放 → 目标条件化重放;
③ 安全从"断言拦截"拆成"预测包络 + 后置监视"。

**技能入库的门禁(promotion gate,防数据泄漏)**:训练/验证/测试**种子必须隔离**;
晋升只在训练+验证种子上评估,**测试种子只用于最终报告、不参与任何选择**;
晋升需满足阈值 + 统计置信区间;支持版本回退。详见 `06` 与 `10 §4`。

## 4. 精炼后的研究问题(建议)

> **在实时、部分可观测的 Minecraft 世界中,证据约束的技能执行与选择性拒判,能否在可接受的
> 额外成本下,降低长链任务的误报成功与不安全恢复?其增益是否依赖于服务端特权 oracle?**

比"断言让 agent 实现 RSI"更窄、更可证伪。子问题:
- Q1 `ambiguous/unobservable` 细分是否比二元 `VERIFIED/UNVERIFIED` 显著降低误报、且拒判率可控?
- Q2 因果归因是否必要(区分"我造成 / 他人造成 / 未观察到")?
- Q3 LLM 声明的通用不变量是否优于硬编码反射(覆盖/开销)?
- Q4 撤掉服务端特权验证后,性能如何退化(= 特权是否必要条件)?
- Q5 局部修复 + 干预式入库是否降低技能库污染并产生净 repair>regression?

## 5. 必须解决的矛盾/风险(承接上一轮)

| # | 矛盾 | 处置 |
|---|---|---|
| D1 | gemini "断言≈100%/0%污染" vs framework 的"预测≠真值" | 仅在完整模式 + 因果归因下声明 certified;分模式报数 |
| D2 | "断言拦截致命动作" | 改为"预测包络拦截;监视发现+交还" |
| D3 | 字面重放 vs framework"不得按步骤重放" | 采用目标条件化重放 |
| D4 | Voyager 基线公平性 | 匹配环境(同暂停/特权);用公开 MC agent 作基线并核对其实验假设 |
| D5 | 规划在 MCP 客户端 = RSI 自包含性弱 | 把验证器/技能库/课程暴露为协议;或实验仓内置 agent |
| D6 | LLM 生成断言 = 重新引入自裁判 | 用特权 oracle 的宽谓词集替代 LLM 判断;Q4 检验 |
| D7 | 几何简化 vs 真实碰撞 | 采 framework:真实碰撞形状 + 方向约定 |

## 6. 与另一个模型观点的比较(优劣)

- **它做对的**:指出 EmbodiedSkills 等是紧邻、劝收缩新颖性,提出"误报/拒判"
  配对指标与五种消融链——**这是对的方法论**,我采纳(Q 与 §2/§6)。
- **它可加强的**:
  1. 它未提 **GCPC/SkillGen/SkillAdaptor/CoEvoSkills** 这四篇 2026 直接近邻——它们把
     "拒判/部分分/归因/局部修复"做在软件域,**进一步压缩叙事**,必须纳入。
  2. 它未涉及**因果归因**与**能力分级**(规划/验证/动作三权限)——这是我提出的可主张 delta。
  3. 它提到的第三方 MC 工程 MineAgent 经用户判断来源不可信,**已排除、不纳入**。
- **结论**:它的研究问题(Q)与我一致;我的增量是"三值细分/因果归因 + 能力分级"
  与更完整的近邻地图。

## 7. 待办(下一步)

1. **补经典原文**:Bauer/Leucker/Schallhart、Sutton 1999、Icarte 2018、Schmidhuber——正式引用。
2. **细读**(未做完):EmbodiedSkills 全文;CoEvoSkills/SkillGen 方法细节。
3. **确定目标形态**(论文 vs 原型)与**环境绑定**(是否只用完整模式)——上一轮已倾向:接近通用
   coding agent、用完整模式。
4. **搭建最小可复位实验**(任务 1–3 + 消融链),用 ManiSkill/ALFWorld 做跨域。
5. **解决 D5**(运行形态),它决定"RSI 闭环"能否自包含与可复现。

## 8. 本次调研台账汇总

- 01 Voyager 谱系:13 条全部 verified-real(纠正 2 处)。
- 02 技能验证/契约:8 条 verified-real;自愈测试工具 unverifiable。
- 04 RV/安全:shielding/CBF/step-verify verified-real;options/三值RV/RewardMachines canonical 未抓。
- 05 RSI:DGM/STOP/Self-Rewarding/step-verify/reward-hack verified-real;Gödel Machine canonical 未抓。
- 06 基准:MineDojo/MineRL/Odyssey/MineAnyBuild/Crafter verified-real;ALFWorld 等 canonical 未抓。
