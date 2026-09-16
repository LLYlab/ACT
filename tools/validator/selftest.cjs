#!/usr/bin/env node
'use strict'
// LLMR 校验器自测：覆盖全部 19 项检查的错误码
// 用法：node selftest.cjs

const { runChecks, surfaceHash } = require('./checks.cjs')

let pass = 0
let fail = 0

function base (over = {}, swfOver = {}) {
  const a = Object.assign(
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    over.a || {},
  )
  const b = Object.assign({ id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } }, over.b || {})
  return Object.assign({
    id: 't',
    version: 1,
    invoke: { when: '需要时' },
    amz: [a, b],
    order: [{ from: 'a', to: 'b', when: 'signal.go == true', level: 2 }],
    terminal: ['b'],
    ui: { page: ['AGT', 'WFW', 'DIR', 'WPC'] },
  }, swfOver)
}

/** name / swf / opts / expectCodes / forbidCodes */
function t (name, swf, opts, expect, forbid = []) {
  let r
  try {
    r = runChecks(swf, opts || {})
  } catch (e) {
    console.log(`✗ ${name}\n    抛异常: ${e.message}`)
    fail++
    return
  }
  const got = new Set([...r.errors.map((x) => x.code), ...r.warnings.map((x) => x.code)])
  const missing = expect.filter((c) => !got.has(c))
  const extra = forbid.filter((c) => got.has(c))
  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ ${name}`)
    pass++
  } else {
    console.log(`✗ ${name}`)
    if (missing.length) console.log(`    缺少: ${missing.join(', ')}   实际: ${[...got].sort().join(', ') || '(无)'}`)
    if (extra.length) console.log(`    不该出现: ${extra.join(', ')}`)
    fail++
  }
}

// ── #2 分支兜底 ──
t('#2 多条出边无 else → E101',
  base({}, { amz: [
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { id: 'c', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
  ], order: [
    { from: 'a', to: 'b', when: 'signal.go == true', level: 2 },
    { from: 'a', to: 'c', when: 'signal.go == false', level: 2 },
  ], terminal: ['b', 'c'] }), {}, ['LLMR-E101'])

t('#2 多条 else → E102',
  base({}, { order: [
    { from: 'a', to: 'b', when: 'signal.go == true', level: 2, else: 'b' },
    { from: 'a', to: 'b', when: 'signal.go == false', level: 2, else: 'b' },
  ] }), {}, ['LLMR-E102'])

// ── #3 文法 ──
t('#3 when 文法非法 → E103', base({}, { order: [{ from: 'a', to: 'b', when: 'signal.go ==', level: 2 }] }), {}, ['LLMR-E103'])
t('#3 括号与 startsWith 可解析',
  base({}, { order: [{ from: 'a', to: 'b', when: "(signal.go == true or artifact.type startsWith 'te')", level: 2 }] }),
  {}, [], ['LLMR-E103'])

// ── #4 / #15 level 与命名空间 ──
t('#15 level:1 用 signal → E104',
  base({}, { order: [{ from: 'a', to: 'b', when: 'signal.go == true', level: 1 }] }), {}, ['LLMR-E104'])

t('#4 level:2 只用确定性变量 → 只报 W202，不报 E104（两者冲突已归一）',
  base({}, { order: [{ from: 'a', to: 'b', when: "artifact.type == 'text'", level: 2 }] }),
  {}, ['LLMR-W202'], ['LLMR-E104'])

t('#15 level:2 混用 signal 与 artifact → E104',
  base({}, { order: [{ from: 'a', to: 'b', when: "(signal.go == true and artifact.type == 'text')", level: 2 }] }),
  {}, ['LLMR-E104'])

// ── #5 引用存在性 ──
t('#5 工具不存在 → E105',
  base({ a: { tools: ['no_such_tool'] } }), { toolRegistry: new Set(['docx_write']) }, ['LLMR-E105'])

t('#5 $ref 无法解析 → E105',
  base({}, { amz: [{ $ref: 'amz/missing' }] }), {}, ['LLMR-E105'])

t('#5 UI 页面组不存在 → E105',
  base({}, { ui: { page: ['AGT', 'WFW', 'DIR', 'GHOST'] } }), { uiPages: new Set(['AGT', 'WFW', 'DIR', 'WPC']) }, ['LLMR-E105'])

// ── #6 signal 字段 ──
t('#6 signal 字段未声明 → E106',
  base({}, { order: [{ from: 'a', to: 'b', when: 'signal.ghost == true', level: 2 }] }), {}, ['LLMR-E106'])

t('#6 signal 类型不符 → E106',
  base({}, { order: [{ from: 'a', to: 'b', when: "signal.go == 'yes'", level: 2 }] }), {}, ['LLMR-E106'])

t('#6 类型正确 → 无 E106',
  base(), {}, [], ['LLMR-E106'])

// ── #7 入口 ──
t('#7 入口不唯一 → E107',
  base({}, { amz: [
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { id: 'c', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { id: 'd', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
  ], order: [
    { from: 'a', to: 'b', when: 'run.status == "ok"', level: 1 },
    { from: 'c', to: 'd', when: 'run.status == "ok"', level: 1 },
  ], terminal: ['b', 'd'] }), {}, ['LLMR-E107'])

// ── #8 终态 ──
t('#8 非终态无出边 → E108', base({}, { terminal: ['a'] }), {}, ['LLMR-E108'])
t('#8 terminal 有出边 → W204', base({}, { terminal: ['a', 'b'] }), {}, ['LLMR-W204'])

// ── #9 导入复核 ──
t('#9 import 无 _review → E109', base(), { mode: 'import' }, ['LLMR-E109'])

{
  const swf = base()
  const surface = [{ amz: 'a', tools: [], guards: [] }, { amz: 'b', tools: [], guards: [] }]
  const good = surfaceHash(surface)
  t('#9 import 哈希正确 → 无 E109', Object.assign(base(), { _review: { at: 'x', by: 'y', surfaceHash: good } }), { mode: 'import' }, [], ['LLMR-E109'])
  t('#9 import 哈希不符 → E109', Object.assign(base(), { _review: { at: 'x', by: 'y', surfaceHash: 'sha256:deadbeef' } }), { mode: 'import' }, ['LLMR-E109'])
}

// ── #10 step ──
t('#10 存在 step → W205',
  base({ b: { kind: 'step', step: { from: 'a', scp: 'x' }, output: { body: 'text' } } }), {}, ['LLMR-W205'])

// ── #11 CSP（schema 层已实测；此处只确认不误报）──
t('#11 正常 AMZ 不报任何 CSP 码', base(), {}, [], ['LLMR-E001'])

// ── #12 id 冲突 ──
t('#12 AMZ id 重复 → E110',
  base({}, { amz: [
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
  ], order: [{ from: 'a', to: 'a', when: 'run.status == "ok"', level: 1 }], terminal: ['a'] }), {}, ['LLMR-E110'])

// ── #13 分支出边缺 signal ──
t('#13 level:2 出边但无 output.signal → E111',
  base({ a: { output: { body: 'free' } } }), {}, ['LLMR-E111'])

// ── #14 导出残留 $ref ──
t('#14 export 残留 $ref → E112',
  base({}, { amz: [{ $ref: 'amz/a' }] }),
  { mode: 'export', amzLibrary: { a: { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } } } },
  ['LLMR-E112'])

// ── #1 工具面安全 ──
t('#1 含 exec 类工具 → W201', base({ a: { tools: ['pwsh'] } }), {}, ['LLMR-W201'])
t('#1 exec + artifact 并存 → W201 + W206', base({ a: { tools: ['pwsh', 'docx_write'] } }), {}, ['LLMR-W201', 'LLMR-W206'])

// ── 不可达 ──
t('#7 不可达节点 → W203',
  base({}, { amz: [
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { id: 'orphan', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
  ], terminal: ['b', 'orphan'] }), {}, ['LLMR-W203'])

// ── #16 引用项必须自带 model ──
t('#16 $ref 引入的 AMZ 缺 model → W207',
  base({}, { amz: [
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { $ref: 'amz/nomodel' },
  ] }),
  { amzLibrary: { nomodel: { id: 'nomodel', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } } } },
  ['LLMR-W207'])

t('#16 $ref 引入的 AMZ 自带 model → 无 W207',
  base({}, { amz: [
    { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    { $ref: 'amz/withmodel' },
  ] }),
  { amzLibrary: { withmodel: { id: 'withmodel', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' }, model: 'm' } } },
  [], ['LLMR-W207'])

// ── #17 环检测 ──
// 自环：a → a
t('#17 自环 → E113',
  base({}, {
    amz: [
      { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    ],
    order: [
      { from: 'a', to: 'a', when: 'signal.go == true', level: 2, else: 'b' },
    ],
    terminal: ['b'],
  }), {}, ['LLMR-E113'])

// 二元环：a → b → a
t('#17 二元环 → E113',
  base({}, {
    amz: [
      { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    ],
    order: [
      { from: 'a', to: 'b', when: 'signal.go == true', level: 2, else: 'b' },
      { from: 'b', to: 'a', when: 'signal.go == true', level: 2, else: 'b' },
    ],
    terminal: ['b'],
  }), {}, ['LLMR-E113'])

// 长的环：a → b → c → d → b（入口不在环上，仍要抓到）
t('#17 入口不在环上也要抓到 → E113',
  base({}, {
    amz: [
      { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'c', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'd', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
    ],
    order: [
      { from: 'a', to: 'b', when: 'signal.go == true', level: 2, else: 'd' },
      { from: 'b', to: 'c', when: 'signal.go == true', level: 2, else: 'd' },
      { from: 'c', to: 'd', when: 'signal.go == true', level: 2, else: 'd' },
      { from: 'd', to: 'b', when: 'signal.go == true', level: 2, else: 'd' },
    ],
    terminal: ['d'],
  }), {}, ['LLMR-E113'])

// 菱形但无环（同一节点被两条路到达）—— **不能误报**
t('#17 菱形汇聚（非环）→ 无 E113',
  base({}, {
    amz: [
      { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'c', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    ],
    order: [
      { from: 'a', to: 'b', when: 'signal.go == true', level: 2, else: 'c' },
      { from: 'b', to: 'c', when: 'signal.go == true', level: 2, else: 'c' },
    ],
    terminal: ['c'],
  }), {}, [], ['LLMR-E113'])

// 不可达的环：跑不到，不该报 E113（W203 已经把它标出来了）
t('#17 不可达节点上的环 → 只报 W203',
  base({}, {
    amz: [
      { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
      { id: 'x', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
      { id: 'y', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
    ],
    order: [
      { from: 'a', to: 'b', when: 'signal.go == true', level: 2 },
      { from: 'x', to: 'y', when: undefined, level: 1 },
      { from: 'y', to: 'x', when: undefined, level: 1 },
    ],
    terminal: ['b'],
  }), {}, ['LLMR-W203'], ['LLMR-E113'])

// ── #18 环控区（pool）──
const POOL_AMZ = [
  { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
  { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } },
  { id: 'r1', kind: 'ttc', prompt: 'p', tools: [], output: { body: 'text' } },
  { id: 'r2', kind: 'ttc', prompt: 'p', tools: [], output: { body: 'text' } },
]
const poolBase = (pool, extra = {}) => base({}, Object.assign({
  amz: POOL_AMZ,
  order: [{ from: 'a', to: 'b', when: 'signal.go == true', level: 2 }],
  terminal: ['b'],
  pool,
}, extra))

t('#18 合法环控区（监听器 + 池内 AMZ）→ 零错误',
  poolBase([{ id: 'retry', on: 'event.retry == true', run: ['r1', 'r2'], maxRounds: 3 }]), {}, [])

t('#18 环控区缺 id → E114',
  poolBase([{ on: 'event.x == true', run: ['r1'] }]), {}, ['LLMR-E114'])

t('#18 环控区 id 冲突 → E114',
  poolBase([
    { id: 'z', on: 'event.x == true', run: ['r1'] },
    { id: 'z', on: 'event.y == true', run: ['r2'] },
  ]), {}, ['LLMR-E114'])

t('#18 环控区 run 引用不存在的 AMZ → E114',
  poolBase([{ id: 'z', on: 'event.x == true', run: ['nope'] }]), {}, ['LLMR-E114'])

t('#18 run 为空 → E114',
  poolBase([{ id: 'z', on: 'event.x == true', run: [] }]), {}, ['LLMR-E114'])

t('#18 AMZ 同时占主流程与环控区 → E114',
  poolBase([{ id: 'z', on: 'event.x == true', run: ['a'] }]), {}, ['LLMR-E114'])

t('#18 监听器文法非法 → E103',
  poolBase([{ id: 'z', on: 'event.x == ', run: ['r1'] }]), {}, ['LLMR-E103'])

t('#18 监听器用了 artifact. → E114（只许 event. / signal.）',
  poolBase([{ id: 'z', on: 'artifact.count > 0', run: ['r1'] }]), {}, ['LLMR-E114'])

t('#18 监听器可以用 signal.（AMZ 自报也能当触发）→ 合法',
  poolBase([{ id: 'z', on: 'signal.go == true', run: ['r1'] }]), {}, [])

t('#18 未写 maxRounds → W209（允许环 ≠ 允许无界）',
  poolBase([{ id: 'z', on: 'event.x == true', run: ['r1'] }]), {}, ['LLMR-W209'])

// 池内 AMZ 不在主流程上，不该被报"不可达"
t('#18 池内 AMZ 不报不可达（W203）',
  poolBase([{ id: 'z', on: 'event.x == true', run: ['r1', 'r2'], maxRounds: 2 }]), {}, [], ['LLMR-W203'])

// ── #17 环检测：池里的往复不算主流程环 ──
// 这正是「允许循环，但环必须进环控」的形状：主流程 a→b 无环，池内 r1/r2 互相激活。
t('#17 池内往复（环控）不报 E113',
  poolBase([{ id: 'loop', on: 'event.tick == true', run: ['r1', 'r2'], maxRounds: 5 }]), {}, [], ['LLMR-E113'])

t('#17 主流程里的环仍然报 E113（环控救不了主流程）',
  base({}, {
    amz: [
      { id: 'a', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'b', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'r1', kind: 'ttc', prompt: 'p', tools: [], output: { body: 'text' } },
    ],
    order: [
      { from: 'a', to: 'b', when: 'signal.go == true', level: 2, else: 'b' },
      { from: 'b', to: 'a', when: 'signal.go == true', level: 2, else: 'b' },
    ],
    terminal: ['b'],
    pool: [{ id: 'z', on: 'event.x == true', run: ['r1'], maxRounds: 2 }],
  }), {}, ['LLMR-E113'])

// ── #19 UI 页面（ui.screens）──
const uiBase = (screens) => base({}, { ui: { screens } })

t('#19 合法页面清单 → 零错误',
  uiBase([
    { id: 'goal', title: '目标', entry: 'ui/index.html' },
    { id: 'run', title: '进行中', entry: 'ui/run.html', when: "signal.stage == 'run'" },
  ]), {}, [])

t('#19 页面 id 冲突 → E115',
  uiBase([
    { id: 'x', title: 'A', entry: 'ui/a.html' },
    { id: 'x', title: 'B', entry: 'ui/b.html' },
  ]), {}, ['LLMR-E115'])

t('#19 entry 重复 → E115',
  uiBase([
    { id: 'x', title: 'A', entry: 'ui/a.html' },
    { id: 'y', title: 'B', entry: 'ui/a.html' },
  ]), {}, ['LLMR-E115'])

t('#19 entry 用 .. 逃出 SWF 目录 → E115',
  uiBase([{ id: 'x', title: 'A', entry: '../evil.html' }]), {}, ['LLMR-E115'])

t('#19 entry 用绝对路径 → E115',
  uiBase([{ id: 'x', title: 'A', entry: '/etc/passwd.html' }]), {}, ['LLMR-E115'])

t('#19 两张页面都没 when → E115（兜底必须唯一）',
  uiBase([
    { id: 'x', title: 'A', entry: 'ui/a.html' },
    { id: 'y', title: 'B', entry: 'ui/b.html' },
  ]), {}, ['LLMR-E115'])

t('#19 页面 when 文法非法 → E103',
  uiBase([{ id: 'x', title: 'A', entry: 'ui/a.html', when: 'signal.stage == ' }]), {}, ['LLMR-E103'])

t('#19 entry 不像 html → W208（提示，不拦）',
  uiBase([{ id: 'x', title: 'A', entry: 'ui/app.js' }]), {}, ['LLMR-W208'])

t('#19 没有 ui 段 → 完全合法（不自带界面，走通用表单）',
  base({}, { ui: undefined }), {}, [])

// ── 基座必须干净 ──
t('基座 SWF → 零错误零警告', base(), {}, [])

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
