#!/usr/bin/env node
'use strict'
// checks.cjs 的畸形输入测试
//
// 动机：runChecks 是导出的库函数，将来会被「阶段 1 加载器」「编辑器插件」直接调用，
// 不一定都经过 CLI 的 schema 前置门。它应当**总是返回报告**，而不是抛 TypeError。
//
// 注意：经 CLI 调用时结构已过 schema，所以这里测的是**库 API 的下限**。
//
// 用法：node schemfuzz.cjs [轮数]

const { runChecks } = require('./checks.cjs')

const N = Number(process.argv[2] || 8000)
let crashes = 0
let ok = 0
const seen = new Set()

let seed = 777001
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = (a) => a[Math.floor(rnd() * a.length)]
const int = (n) => Math.floor(rnd() * n)

const KEYS = [
  'id', 'kind', 'prompt', 'tools', 'guards', 'model', 'output', 'body', 'signal', 'fields',
  'from', 'to', 'when', 'level', 'else', '$ref', 'extends', 'pipe', 'step', 'tcp', 'scp',
  'page', 'fallback', 'panels', 'terminal', 'amz', 'order', 'invoke', 'args', 'version',
  'ui', '_review', 'surfaceHash', 'title', 'tags', 'defaults', 'refs',
]

function randValue (depth) {
  const r = rnd()
  if (depth > 2) return pick([null, 1, 'a', true])
  if (r < 0.12) return null
  if (r < 0.24) return pick([0, 1, -1, 3.5, NaN])
  if (r < 0.40) return pick(['', 'a', 'signal.go == true', 'amz/x', 'exp', 'ttc', 'step', 'pipe'])
  if (r < 0.52) return pick([true, false])
  if (r < 0.70) {
    const n = int(4)
    const arr = []
    for (let i = 0; i < n; i++) arr.push(randValue(depth + 1))
    return arr
  }
  const o = {}
  const n = int(4)
  for (let i = 0; i < n; i++) o[pick(KEYS)] = randValue(depth + 1)
  return o
}

function attempt (doc, label) {
  try {
    const r = runChecks(doc, { mode: pick(['author', 'export', 'import']) })
    if (!r || !Array.isArray(r.errors) || !Array.isArray(r.warnings)) {
      crashes++
      const k = `${label}:badshape`
      if (!seen.has(k)) { seen.add(k); console.log(`✗ [${label}] 返回形状不对: ${JSON.stringify(r)?.slice(0, 120)}`) }
      return
    }
    ok++
  } catch (e) {
    crashes++
    const k = `${label}:${e.constructor.name}`
    if (!seen.has(k) && seen.size < 25) {
      seen.add(k)
      console.log(`✗ [${label}] ${e.constructor.name}: ${e.message}`)
      console.log(`    doc: ${JSON.stringify(doc)?.slice(0, 200)}`)
    }
  }
}

// ── 1. 显然不是对象 ──
for (const v of [null, undefined, 0, 1, '', 'str', true, [], NaN, () => {}]) attempt(v, 'nonobj')
attempt({ swf: null }, 'swf-null')
attempt({ swf: 'str' }, 'swf-str')

// ── 2. 定向畸形（每个字段都换成错类型）──
const SHAPES = [
  { amz: 'not-array' }, { amz: [null] }, { amz: [1] }, { amz: ['s'] }, { amz: [{}] },
  { amz: [{ id: 'a' }] }, { amz: [{ id: 'a', tools: 'x' }] }, { amz: [{ id: 'a', tools: [null] }] },
  { amz: [{ id: 'a', tools: [], output: 'x' }] },
  { amz: [{ id: 'a', tools: [], output: { signal: 'x' } }] },
  { amz: [{ id: 'a', tools: [], output: { signal: { fields: 'x' } } }] },
  { amz: [{ id: 'a', tools: [], output: { signal: { fields: { g: 'bool' } } } }] },
  { amz: [{ id: 'a', guards: 'x' }] }, { amz: [{ id: 'a', guards: [null] }] },
  { order: 'not-array' }, { order: [null] }, { order: [{}] },
  { order: [{ from: 'a', to: 'b', when: 123, level: 2 }] },
  { order: [{ from: 'a', to: 'b', when: null, level: 2 }] },
  { order: [{ from: 'a', to: 'b', when: 'signal.x == 1', level: 'two' }] },
  { order: [{ from: 'a', to: 'b', when: 'signal.x == 1', level: null }] },
  { order: [{ from: null, to: null, when: 'signal.x == 1', level: 2 }] },
  { terminal: 'x' }, { terminal: null }, { terminal: [null] }, { terminal: [1] },
  { ui: null }, { ui: 'x' }, { ui: { page: 'x' } }, { ui: { page: [null] } }, { ui: { panels: 'x' } },
  { _review: 'x' }, { _review: null }, { _review: { surfaceHash: 1 } },
  { amz: [{ $ref: null }] }, { amz: [{ $ref: 'amz/x' }] },
  { amz: [{ id: 'a', kind: 'pipe' }] }, { amz: [{ id: 'a', kind: 'step' }] },
  { amz: [{ id: 'a', extends: 'amz/b', tools: ['x'] }] },
]
for (const s of SHAPES) {
  attempt(s, 'shape')
  attempt({ swf: s }, 'shape.swf')
}

// ── 3. 随机结构 ──
console.log(`随机结构 × ${N} …`)
for (let i = 0; i < N; i++) {
  attempt(randValue(0), 'rand')
  attempt({ swf: randValue(0) }, 'rand.swf')
}

// ── 4. 深链：环检测必须是**显式栈**，不能被文档高度压爆 ──
// 这是这个项目吃过一次的亏（畸形输入压爆调用栈 → RangeError）。
// 环检测是第一个"要遍历整张图"的检查，所以它必须扛得住任意深度。
{
  const DEEP = 50000
  const build = (closeLoop) => {
    const amz = []
    const order = []
    for (let i = 0; i < DEEP; i++) {
      amz.push({ id: 'n' + i, kind: 'exp', prompt: 'p', tools: [], output: { body: 'text' } })
    }
    for (let i = 0; i < DEEP - 1; i++) {
      order.push({ from: 'n' + i, to: 'n' + (i + 1), when: undefined, level: 1 })
    }
    if (closeLoop) order.push({ from: 'n' + (DEEP - 1), to: 'n0', when: undefined, level: 1 })
    return { id: 'deep', version: 1, invoke: { when: 'w' }, amz, order, terminal: ['n' + (DEEP - 1)], ui: { page: ['AGT'] } }
  }
  console.log(`深链 ${DEEP} 节点 × 2（直链 / 首尾成环）…`)
  attempt({ swf: build(false) }, 'deep-chain')
  attempt({ swf: build(true) }, 'deep-cycle')
}

console.log(`\n返回报告 ${ok} · 崩溃 ${crashes}（去重后 ${seen.size} 种）`)
console.log(crashes === 0 ? 'checks.cjs 健壮性: 通过' : 'checks.cjs 健壮性: 不通过')
process.exitCode = crashes ? 1 : 0
