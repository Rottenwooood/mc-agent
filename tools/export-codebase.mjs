#!/usr/bin/env node
// 把某个提交里的被跟踪文本文件按依赖顺序导出成单个纯文本文件，并自校验往返一致。
// 用法: node tools/export-codebase.mjs [输出文件] [提交]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

// 不进入产物的文件：依赖锁定、旧原型、调研语料、生成的约束视图、二进制。
const EXCLUDED_PREFIX = ['docs/research/', 'agent/', 'exports/'];
const EXCLUDED_FILE = new Set([
  'pnpm-lock.yaml',
  'mods/mcagent/gradle/wrapper/gradle-wrapper.jar',
  'mods/mcagent/gradlew.bat',
  'constraints/CONSTRAINTS.md',
  'constraints/constraints.html',
]);
function excluded(path) {
  return EXCLUDED_FILE.has(path) || EXCLUDED_PREFIX.some(p => path.startsWith(p));
}

// 阅读顺序：被依赖者在前；同一目录内先给出口清单，再按名字排序。
const SEGMENTS = [
  { label: 'S1 项目定位', files: ['README.md', '.nvmrc', 'env.sh'] },
  {
    label: 'S2 构建与运行',
    files: [
      'package.json', 'pnpm-workspace.yaml',
      'tsconfig.base.json', 'tsconfig.json', 'vitest.config.ts', '.gitignore',
      'tools/export-codebase.mjs',
    ],
  },
  {
    label: 'S3 类型契约',
    dir: 'packages/contracts',
    first: [
      'package.json', 'tsconfig.json', 'src/index.ts', 'src/contract.ts', 'src/fact.ts',
      'src/predicate.ts', 'src/result.ts', 'src/target.ts', 'src/world.ts', 'src/task.ts',
      'src/method.ts', 'src/skill.ts', 'src/secondary-action.ts', 'src/ports.ts',
    ],
  },
  {
    label: 'S4 基础设施',
    dir: 'packages/foundation',
    first: ['package.json', 'tsconfig.json', 'src/index.ts', 'src/errors.ts', 'src/http.ts', 'src/config.ts'],
  },
  {
    label: 'S5 世界模型',
    dir: 'packages/world',
    first: [
      'package.json', 'tsconfig.json', 'src/index.ts', 'src/geometry.ts', 'src/match.ts',
      'src/queries.ts', 'src/shell.ts', 'src/discovery.ts', 'src/objects.ts',
    ],
  },
  {
    label: 'S6 执行引擎与原子动作库',
    dir: 'packages/execution',
    first: [
      'package.json', 'tsconfig.json', 'src/index.ts', 'src/token.ts', 'src/result.ts',
      'src/guard.ts', 'src/reflex.ts', 'src/contract/engine.ts', 'src/contract/signature.ts',
      'src/actions/index.ts', 'src/actions/types.ts', 'src/actions/helpers.ts',
      'src/actions/target.ts', 'src/actions/perception.ts', 'src/actions/movement.ts',
      'src/actions/blocks.ts', 'src/actions/items.ts', 'src/actions/entities.ts',
      'src/actions/inventory.ts', 'src/actions/containers.ts', 'src/actions/meta.ts',
    ],
  },
  {
    label: 'S7 有界编排与二级动作',
    dir: 'packages/tasks',
    first: [
      'package.json', 'tsconfig.json', 'src/index.ts', 'src/args.ts', 'src/predicate.ts',
      'src/sets.ts', 'src/executor.ts', 'src/secondaryAction.ts',
    ],
  },
  {
    label: 'S8 知识库',
    dir: 'packages/knowledge',
    first: ['package.json', 'tsconfig.json', 'src/index.ts', 'src/actionLibrary.ts', 'src/skillLibrary.ts'],
  },
  {
    label: 'S9 MCP 工具面',
    dir: 'packages/interfaces/mcp',
    first: ['package.json', 'tsconfig.json', 'src/index.ts', 'src/tool.ts', 'src/tools.ts'],
  },
  {
    label: 'S10 后端适配器',
    dir: 'packages/adapters',
    first: [
      'mineflayer/package.json', 'mineflayer/tsconfig.json', 'mineflayer/src/index.ts', 'mineflayer/src/controlPort.ts',
      'telemetry/package.json', 'telemetry/tsconfig.json', 'telemetry/src/index.ts',
      'telemetry/src/wire.ts', 'telemetry/src/worldPort.ts',
      'client-mod/package.json', 'client-mod/tsconfig.json', 'client-mod/src/index.ts',
      'client-mod/src/wire.ts', 'client-mod/src/controlPort.ts',
    ],
  },
  {
    label: 'S11 常驻进程与 MCP 桥',
    dir: 'apps/agent',
    first: [
      'package.json', 'tsconfig.json', 'src/index.ts', 'src/context.ts', 'src/protocol.ts',
      'src/resident.ts', 'src/bridge.ts', 'src/main-resident.ts', 'src/main-bridge.ts',
    ],
  },
  {
    label: 'S12 Fabric Mod：构建与服务端只读观测',
    files: [
      'mods/mcagent/build.gradle', 'mods/mcagent/gradle.properties', 'mods/mcagent/settings.gradle',
      'mods/mcagent/gradle/wrapper/gradle-wrapper.properties', 'mods/mcagent/gradlew',
      'mods/mcagent/src/main/resources/fabric.mod.json', 'mods/mcagent/src/main/resources/mcagent.mixins.json',
      'mods/mcagent/src/main/java/com/mcagent/observer/ObserverMod.java',
      'mods/mcagent/src/main/java/com/mcagent/observer/HttpApi.java',
      'mods/mcagent/src/main/java/com/mcagent/observer/EventLog.java',
      'mods/mcagent/src/main/java/com/mcagent/observer/mixin/BlockItemPlaceMixin.java',
    ],
  },
  {
    label: 'S13 Fabric Mod：真实客户端本地玩家控制',
    files: [
      'mods/mcagent/src/client/resources/mcagent.client.mixins.json',
      'mods/mcagent/src/client/java/com/mcagent/client/ClientControllerMod.java',
      'mods/mcagent/src/client/java/com/mcagent/client/ControlHttp.java',
      'mods/mcagent/src/client/java/com/mcagent/client/ControlDispatcher.java',
      'mods/mcagent/src/client/java/com/mcagent/client/ControlTask.java',
      'mods/mcagent/src/client/java/com/mcagent/client/ControlledInput.java',
      'mods/mcagent/src/client/java/com/mcagent/client/Wire.java',
      'mods/mcagent/src/client/java/com/mcagent/client/ClientReads.java',
      'mods/mcagent/src/client/java/com/mcagent/client/Aim.java',
      'mods/mcagent/src/client/java/com/mcagent/client/Nav.java',
      'mods/mcagent/src/client/java/com/mcagent/client/WalkTask.java',
      'mods/mcagent/src/client/java/com/mcagent/client/Digger.java',
      'mods/mcagent/src/client/java/com/mcagent/client/PlayerActions.java',
      'mods/mcagent/src/client/java/com/mcagent/client/ProductionTasks.java',
      'mods/mcagent/src/client/java/com/mcagent/client/mixin/PlayerAccessor.java',
    ],
  },
  {
    label: 'S14 工具脚本',
    dir: 'tools',
    skip: ['export-codebase.mjs'],
    first: [
      'server-up.sh', 'server-down.sh', 'reset-world.sh', 'agent-up.sh', 'agent-down.sh',
      'client-up.sh', 'launch-client.mjs', 'fetch-fabric-api.mjs',
      'bench.sh', 'run-prompt.sh', 'smoke.sh', 'setup-bot.mjs', 'view-up.sh', 'view.mjs',
    ],
  },
  {
    label: 'S15 种子与场景',
    dir: 'scenarios',
    first: ['seeds.txt', 'actions.seed.json', 'skills.seed.json', 'actions/get_wood.v1.json', 'actions/get_wood.v2.json', 'tasks/T1.json', 'tasks/T3.json'],
  },
  {
    label: 'S16 测试与验收器',
    dir: 'tests',
    first: [
      'eval/runner.mjs', 'eval/g1-verifier.mjs', 'eval/g2-verifier.mjs',
      'eval/g3-runner.mjs', 'eval/g3-verifier.mjs',
      'eval/metrics/report.mjs', 'eval/verifiers/t1.mjs', 'eval/verifiers/t3.mjs',
    ],
  },
  { label: 'S17 提示词', dir: 'prompts' },
  {
    label: 'S18 设计契约与运行指南',
    files: [
      'docs/mcp-implementation-framework.md',
      'docs/world-map-and-composition.md',
      'docs/client-controller.md',
      'docs/running-the-agent.md',
      'docs/manual-test-mineflayer.md',
    ],
  },
  { label: 'S19 阶段记录', dir: 'stages' },
  { label: 'S20 约束清单', files: ['constraints/constraints.yaml'] },
];

const git = (...args) => execFileSync('git', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });
const root = git('rev-parse', '--show-toplevel').toString().trim();
const commit = process.argv[3] ?? 'HEAD';
const sha = git('rev-parse', commit).toString().trim();
const target = resolve(process.argv[2] ?? `${homedir()}/exports/mc-agent-code-${sha.slice(0, 7)}.txt`);

const tracked = git('ls-files', '-z').toString().split('\0').filter(Boolean);
const wanted = tracked.filter(p => !excluded(p));

// 展开目录段：先放 first 指定的文件，再按名字排序放其余。
const plan = [];
for (const segment of SEGMENTS) {
  if (segment.files) {
    plan.push({ label: segment.label, files: [...segment.files] });
    continue;
  }
  const prefix = `${segment.dir}/`;
  const skip = segment.skip ?? [];
  const kept = wanted.filter(p => {
    if (!p.startsWith(prefix)) return false;
    const rest = p.slice(prefix.length);
    return !skip.includes(rest);
  });
  const members = kept.filter(p => !p.slice(prefix.length).includes('/')).map(p => p.slice(prefix.length));
  const nested = kept.filter(p => p.slice(prefix.length).includes('/'));
  const ordered = [];
  const first = segment.first ?? [];
  for (const name of first) {
    const full = `${prefix}${name}`;
    if (!wanted.includes(full)) throw new Error(`${segment.dir} 缺少 ${name}`);
    ordered.push(full);
  }
  const taken = new Set(ordered);
  members.filter(n => !taken.has(`${prefix}${n}`)).sort().forEach(n => ordered.push(`${prefix}${n}`));
  nested.filter(p => !taken.has(p)).sort().forEach(p => ordered.push(p));
  plan.push({ label: segment.label, files: ordered });
}
const placed = plan.flatMap(s => s.files);

const duplicate = placed.filter((p, i) => placed.indexOf(p) !== i);
const missing = wanted.filter(p => !placed.includes(p));
const stale = placed.filter(p => !wanted.includes(p));
if (duplicate.length || missing.length || stale.length) {
  console.error(JSON.stringify({ duplicate, missing, stale }, null, 2));
  throw new Error('导出顺序表与被跟踪文件不一致；先更新 SEGMENTS');
}

const body = [];
const index = [];
for (const segment of plan) {
  body.push(`### ${segment.label}`);
  for (const path of segment.files) {
    const raw = git('show', `${sha}:${path}`).toString('utf8');
    if (raw.includes('\r')) throw new Error(`${path} 含 CR，已中止`);
    const content = raw.endsWith('\n') ? raw : `${raw}\n`;
    const start = body.length + 1;
    body.push(path);
    for (const line of content.slice(0, -1).split('\n')) body.push(line === '' ? '  ' : `  ${line}`);
    body.push('');
    index.push({ path, start, end: body.length - 1 });
  }
}

const meta = [
  '# mc-agent 代码包',
  `# 仓库: ${root}`,
  `# 提交: ${sha}`,
  `# 生成时间: ${new Date().toISOString()}`,
  `# 文件数: ${placed.length}`,
  `# 正文字节: ${Buffer.byteLength(body.join('\n') + '\n')}`,
  '# 排序: 被依赖者在前；同一目录内先出口清单，再按名字',
  '# 排除: pnpm-lock.yaml、gradle-wrapper.jar（二进制）、gradlew.bat（CRLF 的 Windows 批处理）、agent/（里程碑 0 旧原型）、docs/research/（调研语料）、constraints 生成视图、未跟踪的 node_modules/ 与构建产物',
  '# 读法: 路径行不缩进；代码行以两个空格开头，空行写成两个空格；### 开头是分段标记',
  '# 归一化: 文件末尾统一为一个换行；原文末尾无换行的文件会补一个 \\n',
  '## 文件索引',
];
const offset = meta.length + index.length + 1;
const indexLines = index.map((e, i) =>
  `${String(i + 1).padStart(4, '0')}  行 ${offset + e.start}-${offset + e.end}  ${e.path}`);
const text = [...meta, ...indexLines, '## 正文', ...body].join('\n') + '\n';

const textLines = text.split('\n');
const bodyAt = textLines.indexOf('## 正文');
if (bodyAt < 0) throw new Error('产物缺少正文标记');
const rebuilt = new Map();
let current = null;
for (const line of textLines.slice(bodyAt + 1)) {
  if (line === '') continue;
  if (!line.startsWith(' ') && !line.startsWith('#')) {
    current = [];
    rebuilt.set(line, current);
    continue;
  }
  if (line.startsWith('  ')) {
    if (!current) throw new Error(`孤立代码行: ${line.slice(0, 40)}`);
    current.push(line.slice(2));
  }
}
const mismatches = [];
for (const path of placed) {
  const raw = git('show', `${sha}:${path}`);
  const expected = createHash('sha256')
    .update(raw.toString('utf8').endsWith('\n') ? raw : Buffer.concat([raw, Buffer.from('\n')]))
    .digest('hex');
  const actual = createHash('sha256').update(Buffer.from(rebuilt.get(path).join('\n') + '\n')).digest('hex');
  if (expected !== actual) mismatches.push(path);
}
if (rebuilt.size !== placed.length) throw new Error(`还原文件数 ${rebuilt.size} ≠ ${placed.length}`);
if (mismatches.length) throw new Error(`往返不一致: ${mismatches.join(', ')}`);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text);

console.log(JSON.stringify({
  output: isAbsolute(target) ? target : resolve(root, target),
  commit: sha,
  files: placed.length,
  bodyLines: body.length,
  bytes: Buffer.byteLength(text),
  roundTrip: 'ok',
}, null, 2));
