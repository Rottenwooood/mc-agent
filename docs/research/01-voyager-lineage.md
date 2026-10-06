# 01 · Voyager 谱系:LLM Minecraft Agent 架构对比

> 抓取方式:arXiv API 元数据 + 摘要(见 `sources/*-abstract.txt`),部分全文经 agent-gavel 浏览器。
> 核查日期:2026-10-05。台账见文末。

## 1. 对比表

| 工作 | 年 | 动作空间 | 技能库 | 成功判定/验证 | 失败恢复 | 感知 | 环境假设 | 备注 |
|---|---|---|---|---|---|---|---|---|
| **Voyager** 2305.16291 | 2023 | 自由写 JS 代码调用 Mineflayer | 是,可执行代码,检索 | **LLM 自我验证** + 环境反馈 + 执行错误;非程序契约 | 迭代提示改写代码 | 文本(Mineflayer 状态注入),无像素 | 实验环境含暂停/特权 Mod(见 framework §3.2) | 自动课程;3.3x items, 2.3x 距离, 15.3x tech-tree |
| **DEPS** 2302.01560 | 2023 | 文本子目标 + 底层控制器 | 否(计划级) | 环境反馈 + self-explanation | 解释失败并重规划;goal selector 排序 | 文本 | 零样本 70+ 任务 | 也适用于 ALFWorld/桌面操作 |
| **Ghost in the Minecraft** 2305.17144 | 2023 | 文本知识/记忆驱动 | 记忆 | 文本知识 + memory | — | 文本 | — | 通用能力 agent |
| **Odyssey** 2407.15325 | 2024 | **40 原语 + 183 组合技能** | 是,两层 | 未见明确程序化后置契约(以任务完成/评测为主) | — | 文本(微调 LLaMA-3 on MC Wiki) | — | 提出长程/动态即时/自主探索三类基准 |
| **JARVIS-1** 2311.05997 | 2023 | 计划 + goal-conditioned 控制器 | 多模态记忆 | 控制器级 | 记忆增强规划 | **多模态(视觉+指令)** | 观测/动作空间接近人类 | 200+ 任务;ObtainDiamondPickaxe 5x |
| **MineDojo** 2206.08853 | 2022 | RL 动作空间 | — | 环境 reward | — | **像素** | 真实实时 | 互联网规模知识;MineCLIP 奖励模型 |
| **MineAnyBuild** 2505.20148 | 2025 | 建筑计划 | — | 基准评测 | — | 多模态指令 | — | 4000 空间规划任务;建筑专向 |
| **Nebula** 2406.18164 | 2024 | 语言到建筑动作 | — | — | — | 文本对话 | — | discourse-aware 建造 |
| **VPT** 2206.11795 | 2022 | **低层键鼠** | — | behavior cloning(监督) | — | **像素** | 真实实时,无特权 | 未标注视频预训练 |
| **STEVE-1** 2306.00937 | 2023 | 低层,文本条件 | — | 生成模型 | — | **像素** | 真实实时 | VPT 之上的文本指令跟随 |
| **DreamerV3** 2301.04104 | 2023 | 低层 | — | **世界模型 + reward** | 从零训练 | **像素** | 真实实时 | 无人类数据即达钻石 |
| **Cradle** 2403.03186 | 2024 | 通用电脑控制 | — | 视觉闭环 | — | **像素** | 真实软件 | 跨游戏/软件,非 MC 专属 |

## 2. 关键观察

1. **技能库已是标配**。Voyager(代码库)、Odyssey(两层 40+183)、JARVIS-1(多模态记忆)。**"有技能库/能复用"不构成新颖性。**
2. **成功判定普遍偏弱**。Voyager 靠 **LLM self-verification**;DEPS/Ghost 靠环境文本反馈;Odyssey/JARVIS-1 以任务完成或基准分为准。**用程序化 pre/post-condition 契约(而非 LLM 自评)判定技能成功,是本方向的对比点之一。**
3. **技术路线不止两条**:
   - **文本/符号 + Mineflayer**(Voyager/DEPS/Ghost/Odyssey):可读状态,但依赖第三方库的"预测 vs 真值"未严格区分。
   - **多模态规划 + goal-conditioned 控制器**(JARVIS-1):用**视觉观察做规划**、底层是控制器级;
     其感知是多模态、控制非纯文本——**不能简单归入文本路线**(各模块边界见其原文)。
   - **像素 + 低层 RL/BC**(VPT/STEVE-1/DreamerV3/MineDojo):真实实时,成功信号是 reward,不解决"长链任务哪一步失败"。
   我们的"特权语义 + 证据分级"介于其间,需要在公平性上把"规划可见信息 / 验证器可见信息 / 动作权限"分开报告(见 04 与 07)。
4. **环境假设差异巨大**(`minecraft-framework.md §3.2` 已警示;证据见 `09 §15`):Voyager 的实验运行在 **Creative 模式 + cheats ON**,并用 **Multi Server Pause** 暂停服务器。**任何与 Voyager 的对比都必须在匹配环境下进行,否则无效。**
5. **长链失败恢复**多为"重规划/反思",少有**局部修复**:只重做失效的那一步,并验证;更少有**安全中断语义**(中断时在途操作的核对/落地/退出)。

## 3. 已做 vs 真空白(初判)

**已做(不要声称为首次)**:
- LLM 驱动、自动课程、可执行技能库、技能检索复用;
- 组合技能/层次化任务;
- 环境反馈 + 执行错误 + 自我验证的迭代改进;
- 多模态记忆、建筑/空间规划基准。

**可能仍开放(待第二步细化)**:
- **程序化契约 + 证据分级**的成功判定(区分 sent/predicted/observed/attributed),而非 LLM 自评或单一 reward;
- **"证据不足时拒判(abstain)"** 作为一等输出,并量化其与误报的权衡;
- **因果归因**:状态差异 ≠ 我造成;
- **安全中断语义**与**局部修复**的严格定义与可复现评测;
- **成本**:验证/监控/检索的额外开销是否可接受。

## 4. 验证台账

| slug | id | 状态 | 方式 |
|---|---|---|---|
| voyager | 2305.16291 | verified-real | browser abs + API |
| deps | 2302.01560 | verified-real | API |
| ghost | 2305.17144 | verified-real | API |
| jarvis1 | 2311.05997 | verified-real | API |
| minedoj | 2206.08853 | verified-real | API |
| odyssey | 2407.15325 | verified-real | API + browser html |
| nebula | 2406.18164 | verified-real | API |
| mineanybuild | 2505.20148 | verified-real | API(纠正:并非 2406.18164) |
| vpt | 2206.11795 | verified-real | API |
| steve1 | 2306.00937 | verified-real | API(纠正:2306.00971 是 ViCo) |
| dreamerv3 | 2301.04104 | verified-real | API |
| cradle | 2403.03186 | verified-real | API |
| crafter | 2109.06780 | verified-real | API |

> 纠正了另一个模型清单中的两处错误:`2406.18164` 是 Nebula 而非 MineAnyBuild;`2306.00971` 是 ViCo 而非 STEVE-1。
