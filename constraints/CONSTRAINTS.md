# 约束清单

项目：mc-agent

阶段：S1 — 实机测试：从零获取钻石

## 约束

| 编号 | 约束 |
|---|---|
| C1 | 范围限定为 MC 1.20.1 生存模式单机器人，经 mc-agent MCP 工具链从零采集到至少 1 颗钻石并留在背包；不做源码修改、不做 mod 修改、不做创造模式/作弊。 |
| C2 | 产出物为 constraints/constraints.yaml（本文件）、CONSTRAINTS.md、constraints.html、stages/S1.md、以及 /tmp/opencode/diamond-run/evidence.json 运行证据。 |
| C3 | 验收以服务端权威数据为准：观测 Mod（127.0.0.1:8765）的 /inventory?player=Bot 中 minecraft:diamond 数量 ≥ 1，且 /events 中存在 actor=Bot 对 minecraft:diamond_ore 的破坏记录。 |
| C4 | 允许执行的命令限于 tools/ 下的 server-up/agent-up/agent-down/server-down/reset-world、curl 访问 127.0.0.1:8765、ss/pgrep 查看进程与端口、node 运行只读校验脚本；其余命令不执行。 |
| C5 | 禁止 run_command 的 /give、/gamemode、/setblock、/tp 等作弊指令；禁止 set_block 直接改写世界以伪造结果；禁止 push、reset --hard、pkill -f、killall。 |
| C6 | 时间预算 90 分钟墙钟（服务端启动 5 分钟、资源与工具链推进 60 分钟、钻石层作业 25 分钟）；单次工具调用上限 300 秒；超时即收尾并如实记录失败。 |

## 范围

做：
- 启动带只读观测 Mod 的本地 1.20.1 服务器与 mc-agent 常驻进程
- 用 mc-agent 工具完成 木头→工作台→木镐→石镐→石具→铁镐→钻石 的完整生存链
- 以服务端权威背包与事件作为唯一验收口径，落盘证据

不做：
- 修改 packages/、apps/、mods/ 下任何源码
- 使用作弊指令或直接写方块伪造结果
- 视觉/截图参与决策回路
- 多机器人协作、跨维度与下界作业

## 产物

| 编号 | 路径 | 形态 |
|---|---|---|
| A1 | constraints/constraints.yaml | YAML 约束清单（六项必填） |
| A2 | constraints/CONSTRAINTS.md | 由 constraints.yaml 生成的 Markdown 视图 |
| A3 | constraints/constraints.html | 由 constraints.yaml 生成的 HTML 视图 |
| A4 | stages/S1.md | 阶段收尾文档（五部分） |
| A5 | /tmp/opencode/diamond-run/evidence.json | 运行证据（背包、事件、时间戳） |

## 验收

入口：本会话用户指令「你来进行一个测试。暂定目标为拿到钻石。」经 mc-agent 工具执行

| 检查项 | 来源 | 判定 |
|---|---|---|
| K1 | C3 | curl 127.0.0.1:8765/inventory?player=Bot 返回 minecraft:diamond 数量 ≥ 1 |
| K2 | C3 | curl 127.0.0.1:8765/events 中存在 actor=Bot 对 minecraft:diamond_ore 的破坏事件 |
| K3 | C1 | 全程未调用 /give、/gamemode、/setblock、/tp，未修改源码（git status 只含 constraints/ 与 stages/） |
| K4 | C2 | A1–A5 五个产物均存在且内容与本约束一致 |

## 命令

允许：
- tools/server-up.sh / tools/server-down.sh
- tools/agent-up.sh / tools/agent-down.sh
- tools/reset-world.sh
- curl 127.0.0.1:8765/*
- ss -tlnp / pgrep -a java / pgrep -af node
- node（只读校验、证据落盘脚本）
- ~/.config/opencode/scripts/stage-close.sh、render-constraints.mjs、secrets-audit.sh、net-preflight.sh

禁止：
- run_command 执行 /give、/gamemode、/setblock、/tp、/fill
- 用 set_block 直接写入 diamond 或伪造方块变化
- 修改仓库源码、mod、服务端配置以放宽难度
- git push、reset --hard、改写已推送历史、pkill -f、killall
- 回显密钥内容

## 预算

- 时间：90 分钟墙钟（start 后计时），单次工具调用 ≤ 300 秒
- 成本：本地服务器与本地模型调用，无外部付费 API；token 消耗受单会话长度约束
