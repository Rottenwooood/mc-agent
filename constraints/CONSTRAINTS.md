# 约束清单

项目：mc-agent

阶段：S2 — 旧文档清理与单文件代码包

## 约束

| 编号 | 约束 |
|---|---|
| C1 | 范围为删除已失效的设计/计划/状态文档（docs/ 下 9 份），并对仍生效的设计契约文档与 README 做最小一致性修订；不新增设计文档，不改动 packages/、apps/、mods/、tests/ 的行为代码，不删除 docs/research/ 调研语料。 |
| C2 | 产出物为 docs/ 删除后的仓库树、README 与保留文档的引用修订、tools/export-codebase.mjs（单文件导出器）、/home/c6h4o2/exports/mc-agent-code-<sha>.txt（代码包）、constraints/ 三件套与 stages/S2.md。 |
| C3 | 代码包验收：头部含提交号、文件数、正文字节、排除清单与文件索引（路径+行区间）；正文每个文件先给路径行，再给每行缩进两个空格的代码行；导出器自校验往返 sha256 一致、索引覆盖全部被跟踪文本文件、无遗漏无重复。 |
| C4 | 允许执行的命令限于 git 只读与提交、node 运行导出器、render-constraints.mjs、stage-close.sh、secrets-audit.sh、grep/sed/ls/tree 等文件检查；单次命令超时不超过 300 秒。 |
| C5 | 禁止 push、reset --hard、改写历史、pkill -f/killall、删除未跟踪的用户资料（.cache-papers/、grasp/、gw.txt、docs/research/ 下未跟踪文件）、回显密钥；禁止把二进制文件与构建产物写入代码包。 |
| C6 | 时间预算 45 分钟墙钟，单次命令 ≤300 秒；超时即收尾并按实际状态记录。 |

## 范围

做：
- 删除 grep 可证已无引用的设计/计划/状态文档
- 修订保留文档与代码注释中被删文件的引用
- 编写并运行单文件代码导出器，产出代码包

不做：
- 重写新设计文档或补写新内容章节
- 修改动作库、执行引擎、Mod、测试的行为
- 删除 docs/research/ 调研语料与未跟踪的用户资料
- 发布、打标签、推送远端

## 产物

| 编号 | 路径 | 形态 |
|---|---|---|
| A1 | constraints/constraints.yaml | YAML 约束清单（六项必填） |
| A2 | constraints/CONSTRAINTS.md | 由 constraints.yaml 生成的 Markdown 视图 |
| A3 | constraints/constraints.html | 由 constraints.yaml 生成的 HTML 视图 |
| A4 | tools/export-codebase.mjs | 单文件代码导出器（含往返校验） |
| A5 | /home/c6h4o2/exports/mc-agent-code-<sha>.txt | 单文件代码包 |
| A6 | stages/S2.md | 阶段收尾文档（五部分） |

## 验收

入口：node tools/export-codebase.mjs /home/c6h4o2/exports/mc-agent-code-<sha>.txt

| 检查项 | 来源 | 判定 |
|---|---|---|
| K1 | C3 | 导出器退出码 0，输出 roundTrip=ok、files 与索引条目数一致 |
| K2 | C3 | 从产物还原的每个文件 sha256 与 git show <sha>:<path> 一致 |
| K3 | C1 | git status 只含 docs/ 删除、README 与保留文档修订、tools/export-codebase.mjs、constraints/、stages/ |
| K4 | C1 | 保留下来的 docs/*.md 与 README 中不存在指向已删除文档的路径引用 |
| K5 | C2 | A1–A6 六个产物均存在 |

## 命令

允许：
- git status / diff / log / show / ls-files / add / commit / rm
- node tools/export-codebase.mjs <out>
- ~/.config/opencode/scripts/render-constraints.mjs constraints/constraints.yaml
- ~/.config/opencode/scripts/stage-close.sh --stage S2 --entry "<entry>"
- ~/.config/opencode/scripts/secrets-audit.sh
- grep / rg / sed / ls / wc / tree / file / sha256sum

禁止：
- git push、reset --hard、改写已推送历史、删除分支
- pkill -f、killall、按名字模糊终止进程
- 删除未跟踪的用户资料（.cache-papers/、grasp/、gw.txt、docs/research/ 下未跟踪文件）
- 修改 packages/、apps/、mods/、tests/ 的行为代码
- 把二进制（gradle-wrapper.jar、png、jar）或构建产物写入代码包
- 回显密钥内容

## 预算

- 时间：45 分钟墙钟，单次命令 ≤300 秒
- 成本：本地文件操作与 node 进程，无外部付费 API
