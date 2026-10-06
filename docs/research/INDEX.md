# Minecraft Agent 调研工作区

对象:把 agent-gavel 的"预声明断言 + 模板/技能复用 + 局部修复"机制迁移到具身/游戏域
(Minecraft 优先,完整服务端 Mod 模式)。本目录是**二手/一手核查文档 + 原始抓取**。

## 怎么读

1. `00-arxiv-access-procedure.md` — 统一取数流程(agent-gavel 浏览器 + curl 回退 + 台账纪律)。
2. `01-voyager-lineage.md` — LLM Minecraft Agent 架构对比(对比表 12 篇 + Crafter 基准)。
3. `02-skill-verification-and-contracts.md` — 跨域近邻:EmbodiedSkills / CoEvoSkills /
   SkillGen / SkillAdaptor / Trace2Skill / GCPC / ExpeL / Reflexion。
4. `04-runtime-verification-and-safe-rl.md` — 术语锚定:三值 RV / shielding / CBF /
   options / 约束 MDP / 过程监督 / 弃权。
5. `05-rsi-self-improving-agents.md` — RSI 谱系与"验证器质量"瓶颈。
6. `06-benchmarks-and-eval.md` — 基准选择 + 可证伪评测协议 + 独立外部验收器。
7. `07-synthesis-and-gaps.md` — 综合:空白、精炼方案、可证伪问题、矛盾处置。
8. `08-control-backend-api-matrix.md` — **控制后端 API 对比**:Mineflayer(客户端协议)
   vs Fabric 服务端,含完整 API 清单、能力矩阵、选型权衡、对原子动作设计的含义。
9. `09-api-usage-cookbook.md` — **原子动作 API 使用手册**(签名+说明+示例):
   Mineflayer 控制 + Fabric 特权观测 + 有头/无头与视觉 + 与 Voyager 对照。
10. `10-atomic-and-composed-actions.md` — **原子动作与组合动作设计**:统一 target/result/副作用模型、
    约 40 个通用 L1 原子动作、分域 L2 组合动作、组合落地三路线(命名模板 / 动态 tool / 混合)。
11. `11-privileged-perception-and-3d-semantics.md` — **特权感知与 3D 体素语义**:有界观测范围、
    四层表示(体素→关系→语义对象→任务抽象)、同步/时间/来源、LLM 接口纪律、感知工具、
    因果邻域签名与归因、简化/精度权衡。
12. `12-gap-register.md` — **缺口清单**:P0/P1/P2 与待拍板决策。
13. `13-action-contract-and-assertion-schema.md` — **动作契约与断言 schema**(设计草案):
    谓词语言、动作契约、结果双状态、因果邻域三态、模板 schema。
14. `14-runtime-topology-and-mod-contract.md` — **运行时拓扑与 Mod 数据契约**:进程/协议/时钟、
    HTTP 只读接口(snapshot/events/markers)、因果归因等级。
15. `15-execution-engine-scheduling-interrupt.md` — **执行引擎**:三速度闭环、控制权拍卖、
    延迟预算、中断语义、预测包络 vs 后置监视、局部修复、目标条件化重放。
16. `16-environment-and-toolchain.md` — **环境与工具链**:版本矩阵(待锁定)、仓库脚手架、启动栈、
    可复位世界、开发/测试循环。

## 关键结论(速览)

- 机制各环已有先例(三值 RV / 弃权 / shielding 等经典工作);**不能宣称机制首创**。
- 最紧邻(摘要级,待全文核查):软件/工具域 **EmbodiedSkills、CoEvoSkills、SkillGen、SkillAdaptor、GCPC**。
  (第三方 MC 工程 MineAgent 经用户判断来源不可信,**已排除、文档已删**。)
- 可主张的 delta = **在实时/部分可观测/不可逆的 MC 环境中的具体实例化 + 因果归因 + 独立评测**
  (不是机制本身),详见 `07 §2`。
- 建议研究问题:见 `07 §4`;误报率必须用**独立外部验收器**定义(`06 §2.1`)。

## 原始抓取

`sources/*-abstract.txt`(arXiv API 摘要)、`sources/apis/`(Mineflayer / Fabric / Voyager 等官方 API 与用法原文)。

## 纪律

所有引用以 `07` §8 台账为准。`canonical 未抓` 表示凭常识引用,正式写作前必须补原文。
