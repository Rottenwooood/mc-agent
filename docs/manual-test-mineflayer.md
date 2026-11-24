# 手动测试指南（mineflayer 后端）

从起 server 到开 agent、跑测试场景、重置世界、收尾。所有命令都在仓库根目录执行。

---

## 0. 前置

```sh
cd /path/to/mc-agent
. ./env.sh          # 设置 JDK 25（Gradle/Loom 需要）
```

## 1. 构建

```sh
pnpm build          # 编译所有 TS 包（改过 packages/** 后必做）
```

只有**改过 `mods/mcagent`** 时才需要重编 mod 并安装到客户端 profile（client-mod 后端才用）：

```sh
. ./env.sh && ( cd mods/mcagent && ./gradlew build --no-daemon )
cp -f mods/mcagent/build/libs/mcagent-0.1.0.jar "$HOME/.local/share/red.ghs.axolotl/profiles/1.20.1-Fabric 0.19.5/mods/"
```

## 2. 起本地 server（Fabric dev，含只读观测 mod）

```sh
setsid tools/server-up.sh > /tmp/opencode/mc-server.log 2>&1 < /dev/null &
# 等就绪（首次生成世界要十几秒）
for i in $(seq 1 60); do sleep 3; curl -s --max-time 2 http://127.0.0.1:8765/health >/dev/null 2>&1 && { echo up; break; }; done
curl -s http://127.0.0.1:8765/health      # {"ok":true,...} 即就绪
```

- 观测 HTTP：`127.0.0.1:8765`（只读）。
- 服务器：`127.0.0.1:25565`，离线模式，难度 peaceful。
- **停 server**（优雅退出，会存档）：
  ```sh
  tools/server-down.sh
  ```

## 3. 重置世界（换/固定种子）

```sh
tools/reset-world.sh 5002      # 停 server → 删世界 → 设 level-seed → 重启 → 等 health
```

会**清空玩家数据**（背包/位置），但 `ops.json` 保留。重置后 server 会重启，**必须重启 agent**（见下）。

## 4. 起 agent（默认 mineflayer 后端）

```sh
tools/agent-down.sh                    # 先清残留（见第 8 节）
setsid tools/agent-up.sh --server 127.0.0.1:25565 --user Bot \
  > /tmp/opencode/resident.log 2>&1 < /dev/null &
sleep 8
cat /tmp/opencode/resident.log         # agent-up: backend=... ; [resident] listening ...; bot Bot connected
```

换服务器 / 后端 / 名字：

```sh
tools/agent-up.sh --server 192.168.1.10:25566 --user Bot  # 别的服务器
tools/agent-up.sh --backend client-mod --user Agent      # 真实客户端本地玩家
tools/agent-up.sh --help                                 # 全部参数
```

- `--backend`：`mineflayer`（默认，协议客户端 bot）或 `client-mod`（真实客户端本地玩家）。
- `--server HOST[:PORT]` / `--user` / `--version` / `--reflex` / `--actions` / `--skills`。
- 常驻进程监听 `/tmp/opencode/mc-agent.sock`；MCP 桥 `apps/agent/dist/main-bridge.js`（opencode.json 里配置）连它，把工具暴露给模型。

## 5. 测试场景

工具来自 `mc-agent` MCP server（`opencode.json` 里的 `main-bridge.js`）。核心工具：`view` / `scan_blocks` / `go_to` / `set_block` / `run_method` / `craft` / `collect` / `get_inventory` / `get_self_status`。

### 场景 A — 完整生存链
目标：`挖木头 → 合成木镐 → 挖石头 → 合成石镐 → 挖矿脉`。
1. `view({radius:8,height:5})` 看地形；`scan_blocks({match:"#minecraft:logs",radius:32})` 找树。
2. `go_to({target:{kind:"object",ref:<treeHandle>},range:2})`。
3. 挖整棵：`run_method({budgetMs:60000,steps:[{op:"for_each",set:{op:"members",handle:<treeHandle>},as:"c",body:[{action:"set_block",args:{target:{kind:"cell",pos:{from:"c"}},block:"minecraft:air",navigate:true,allowModify:true,breakThrough:true}}]}]})`。
4. `collect({radius:8})` 捡掉落物（**关键**：破坏方块 ≠ 获得物品）。
5. `craft({item:"minecraft:spruce_planks",count:12})` → `craft({item:"minecraft:stick",count:4})` → `craft({item:"minecraft:crafting_table",count:1})`。
6. 放工作台：`set_block({target:{kind:"relative",dir:"east",steps:1},block:"minecraft:crafting_table"})`（先确保站在实心地面上）。
7. `craft({item:"minecraft:wooden_pickaxe",count:1,table:{kind:"cell",pos:[x,y,z]}})`（3 木板 + 2 木棍）。
8. `equip({item:"minecraft:wooden_pickaxe"})` → 挖石头（`scan_blocks({match:"minecraft:stone"})` → `go_to allowModify:true` → `run_method` 挖）→ `collect`。
9. `craft({item:"minecraft:stone_pickaxe",count:1,table:...})`（3 圆石 + 2 木棍）。
10. 挖矿脉：`scan_blocks({match:"#minecraft:coal_ores",radius:48})` → `go_to allowModify:true` → `run_method`（同上 for_each members）→ `collect`。

### 场景 B — 复现/验证导航修复（重点）
就是"卡在导航"那个场景：**目标可达但嵌在石头里**。
```
# 1) 找矿脉，拿 handle
scan_blocks({match:"#minecraft:coal_ores", radius:48})
# 2) 走/挖过去（allowModify:true 会边走边挖；修复后不会假成功卡死）
go_to({target:{kind:"object",ref:"<coalHandle>"}, range:3, allowModify:true, timeoutMs:60000})
# 3) 原样挖整条脉
run_method({budgetMs:120000, steps:[{op:"for_each",
  set:{op:"members", handle:"<coalHandle>"}, as:"c",
  body:[{action:"set_block", args:{target:{kind:"cell",pos:{from:"c"}},
    block:"minecraft:air", navigate:true, allowModify:true, breakThrough:true}}]}]})
# 4) 捡 + 看背包
collect({radius:8}); get_inventory()
```

**判定标准**：`go_to` / `run_method` 应在有限时间内返回（不再无限挂起），且角色**真的移动/挖穿**到目标（`get_self_status` 位置变化、`get_inventory` 出现 `coal`）。

> 上面是手动一步步调；三种"跑 agent"的方式（① 脚本+自定义 prompt `tools/run-prompt.sh`、
> ② 一键 benchmark `tools/bench.sh`、③ 自己开 TUI session 下任务）见 `docs/running-the-agent.md`。

## 6. 观察

- 只读观测（脚本）：
  ```sh
  curl -s -X POST http://127.0.0.1:8765/snapshot -H 'Content-Type: application/json' \
    -d '{"player":"Bot","scope":{"kind":"egocentric","r":0},"want":["self"]}'
  ```
- **用真人客户端进去看**：地址 `localhost:25565`，版本 **1.20.1**，用户名随便填（**别用 `Bot`**）。离线服，任何启动器都能进。

## 7. 给玩家 OP

`ops.json` 里已有 `Agent`、`Setup`。用仓库自带的 setup/干扰 bot（`tools/setup-bot.mjs`，以已在 ops.json 的 `Setup` 身份连服并执行命令）给新玩家 OP：
```sh
# 第 1 个参数：能解析 mineflayer 的目录（adapter 包）
node tools/setup-bot.mjs packages/adapters/mineflayer cmd "/op Rotten_wooood"
# 其它用法：cmd "<任意命令>" / dig <x> <y> <z> / fixture <n>
```
（或直接编辑 `mods/mcagent/run/ops.json` 后重启 server；离线 UUID = md5("OfflinePlayer:<name>") 加版本位。）

## 8. 收尾 / 清理

```sh
tools/agent-down.sh    # 杀所有常驻进程（bot owner）
tools/server-down.sh   # 停 server（优雅退出，会存档）
```

`agent-down.sh` 用 /proc 精确匹配，避免 `pkill -f main-resident` 误杀自己的 shell。

---

## 附：后端切换一览

| 目的 | 命令 |
|---|---|
| mineflayer（协议客户端 bot） | `MCAGENT_CONTROL=mineflayer MC_USER=Bot node apps/agent/dist/main-resident.js` |
| 真实客户端本地玩家 | `MCAGENT_CONTROL=client-mod MC_USER=Agent node apps/agent/dist/main-resident.js`（另需先开客户端，见 `tools/launch-client.mjs`） |
| 起真实客户端 | `DISPLAY=:0 node tools/launch-client.mjs --server 127.0.0.1:25565` |

上层（执行引擎 / 契约 / 工具面）对两者**完全一致**，只换 `ControlPort` 后端。
