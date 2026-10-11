# 跑 agent 的三种方式

三种方式的前提一样：**先起 server + agent**。

```sh
tools/server-up.sh                                   # server（tools/bench.sh 会自己起）
tools/agent-up.sh --server 127.0.0.1:25565 --user Bot  # agent（身体 owner）
tools/reset-world.sh 5002                            # 需要干净世界时（可选；之后要重启 agent）
```

- **系统 prompt** 在 `prompts/mc-agent-system.md`，通过 OpenCode 的 `mc-agent` agent 注入
  （`~/.config/opencode/opencode.json` → `agent.mc-agent.prompt`）。
- **工具** 由 MCP 桥（`apps/agent/dist/main-bridge.js`）从常驻进程暴露给模型。

---

## 方式 1 — 脚本 + 你自己的 prompt（单次、headless）

```sh
tools/run-prompt.sh prompts/scenarios/mine-wood-to-vein.md      # 用文件
tools/run-prompt.sh "去挖 5 个原木并捡回来"                       # 或直接给文本
tools/run-prompt.sh <file> --model opencode-go/deepseek-v4.1-flash#low --agent mc-agent
```

跑一次就结束，**不判定**（只看模型自己报告）。想跑固定套件用方式 2。

## 方式 2 — 一键 benchmark（固定任务套件 + 独立验收）

```sh
tools/bench.sh                                                  # 默认 T1,T3 × scenarios/seeds.txt
tools/bench.sh --tasks T1,T3 --seeds 5001,5002 \
               --model opencode-go/deepseek-v4.1-flash#low
```

`tools/bench.sh` 会自动起 server，然后跑 `tests/eval/runner.mjs`。每个 case：
**重置世界 → 起 resident → 装 fixture → `opencode run`（只给目标）→ 独立验收器 → 落盘 episode**。
runner **不写死步骤、不判定成功**（判定在独立验收器里）。

- 任务定义：`scenarios/tasks/<id>.json`
- 独立验收器：`tests/eval/verifiers/<id>.mjs`
- 结果：`/tmp/opencode/bench/`（可用 `--out` 改）

## 方式 3 — 你自己开 session 下任务（交互）

1. 起 server + agent（同上）。
2. 打开 OpenCode（TUI），把 agent 切成 **`mc-agent`**（它带 mc-agent 的系统 prompt）。
3. 直接输入自然语言任务，例如：
   `用 mc-agent 工具挖 5 个原木、做个木镐，然后挖一条煤矿脉`

适合边看边调、临时换任务；不需要预先写 prompt 文件。

---

## 三者对比

| | 谁给 prompt | 判定 | 适合 |
|---|---|---|---|
| 1 `run-prompt.sh` | 你（文件/文本） | 无（模型自报） | 试自己的任务 |
| 2 `bench.sh` | 固定任务套件 | **独立验收器** | 复现/度量 |
| 3 TUI session | 你在对话里打 | 无 | 边看边调 |
