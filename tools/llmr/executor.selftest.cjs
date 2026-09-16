#!/usr/bin/env node
'use strict'
// LLMR 执行器 + 后端自测
// 用法：node executor.selftest.cjs

const loader = require('./loader.cjs')
const { executeSwf, buildGraph, safeEval, selectScreen } = require('./executor.cjs')
const { echoBackend, httpBackend, dshBackend, renderUserMessage, extractSignal } = require('./backends.cjs')

let pass = 0
let fail = 0
function eq (name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`✓ ${name}`); pass++ } else { console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`); fail++ }
}
function ok (name, cond, detail) {
  if (cond) { console.log(`✓ ${name}`); pass++ } else { console.log(`✗ ${name}${detail ? '\n    ' + detail : ''}`); fail++ }
}

const SWF = {
  id: 't', version: 1, invoke: { when: 'x' },
  amz: [
    { id: 'plan', kind: 'exp', prompt: 'P', tools: [], output: { body: 'free', signal: { fields: { go: 'bool', n: 'int' } } } },
    { id: 'a', kind: 'exp', prompt: 'A', tools: [], output: { body: 'docx' } },
    { id: 'b', kind: 'exp', prompt: 'B', tools: [], output: { body: 'text' } },
  ],
  order: [{ from: 'plan', to: 'a', when: 'signal.go', level: 2, else: 'b' }],
  terminal: ['a', 'b'],
  ui: { page: ['AGT', 'WFW', 'DIR', 'WPC'] },
}

const main = async () => {
  // ── 图构建 ──
  {
    const g = buildGraph(SWF)
    eq('入口唯一', g.entries, ['plan'])
    eq('终态集合', [...g.terminal], ['a', 'b'])
    eq('节点表', [...g.amzById.keys()], ['plan', 'a', 'b'])
  }

  // ── 走 when 分支 ──
  {
    const r = await executeSwf(SWF, { backend: echoBackend(), args: { goal: 'g' } })
    eq('when 分支：完成', r.status, 'completed')
    eq('when 分支：ok', r.ok, true)
    eq('when 分支：节点序列', r.trace.map((s) => s.amz), ['plan', 'a'])
    eq('when 分支：via', r.trace[0].via, 'when')
    eq('when 分支：最终产出', r.finalOutput, '[docx] a')
  }

  // ── 走 else 分支 ──
  {
    const r = await executeSwf(SWF, { backend: echoBackend({ signals: { plan: { go: false } } }) })
    eq('else 分支：节点序列', r.trace.map((s) => s.amz), ['plan', 'b'])
    eq('else 分支：via', r.trace[0].via, 'else')
    eq('else 分支：最终产出', r.finalOutput, '[text] b')
  }

  // ── 求值失败 → 走 else（规格 §9.4）──
  {
    const swf = { ...SWF, order: [{ from: 'plan', to: 'a', when: 'signal.nope', level: 2, else: 'b' }] }
    const r = await executeSwf(swf, { backend: echoBackend() })
    eq('求值失败 → else', r.trace.map((s) => s.amz), ['plan', 'b'])
    eq('求值失败 → via 标记', r.trace[0].via, 'else(eval-failed)')
  }

  // ── 求值失败且无 else → stopped ──
  {
    const swf = { ...SWF, order: [{ from: 'plan', to: 'a', when: 'signal.nope', level: 2 }] }
    const r = await executeSwf(swf, { backend: echoBackend() })
    eq('求值失败且无 else：stopped', r.status, 'stopped')
    ok('求值失败且无 else：原因提到 else', String(r.reason).includes('else'), r.reason)
  }

  // ── AMZ 失败折成 run.status，不抛异常 ──
  {
    const r = await executeSwf(SWF, { backend: echoBackend({ failOn: ['plan'] }) })
    eq('AMZ 失败：状态记为 fail', r.trace[0].status, 'fail')
    eq('AMZ 失败：env.run.status', r.trace[0].env.run.status, 'fail')
    ok('AMZ 失败：仍继续走图', r.trace.length === 2, JSON.stringify(r.trace.map((s) => s.amz)))
  }

  // ── 用 run.status 分支（确定性变量）──
  {
    const swf = {
      ...SWF,
      order: [{ from: 'plan', to: 'a', when: "run.status == 'ok'", level: 1, else: 'b' }],
    }
    const good = await executeSwf(swf, { backend: echoBackend() })
    eq('run.status 分支：成功走 a', good.trace.map((s) => s.amz), ['plan', 'a'])
    const bad = await executeSwf(swf, { backend: echoBackend({ failOn: ['plan'] }) })
    eq('run.status 分支：失败走 b', bad.trace.map((s) => s.amz), ['plan', 'b'])
    eq('run.status 分支：via', bad.trace[0].via, 'else')
  }

  // ── 非终态无出边 → stopped ──
  {
    const swf = { ...SWF, terminal: ['b'], order: [{ from: 'plan', to: 'a', when: 'signal.go', level: 2, else: 'b' }] }
    const r = await executeSwf(swf, { backend: echoBackend() })
    eq('a 不在终端表 → stopped', r.status, 'stopped')
    ok('原因提到非终态', String(r.reason).includes('非终态'), r.reason)
  }

  // ── 入口不唯一 ──
  {
    // plan 与 b 都是 from，且都不是任何边的目标 → 两个入口
    const swf = { ...SWF, order: [
      { from: 'plan', to: 'a', when: 'signal.go', level: 2, else: 'a' },
      { from: 'b', to: 'a', when: 'signal.go', level: 2, else: 'a' },
    ] }
    const r = await executeSwf(swf, { backend: echoBackend() })
    eq('入口不唯一 → error', r.status, 'error')
    eq('入口不唯一：轨迹为空', r.trace.length, 0)
  }

  // ── 从入口走进环 → maxSteps 保护 ──
  {
    // 注意：纯环（无入口）会被"入口不唯一（0 个）"先拦下，
    // 所以必须造一个**有入口、进去后成环**的图，才能测到 maxSteps。
    const swf = { ...SWF, order: [
      { from: 'plan', to: 'a', when: 'signal.go', level: 2, else: 'a' },
      { from: 'a', to: 'b', when: 'signal.go', level: 2, else: 'b' },
      { from: 'b', to: 'a', when: 'signal.go', level: 2, else: 'a' },
    ], terminal: ['a', 'b'] }
    const r = await executeSwf(swf, { backend: echoBackend(), maxSteps: 10 })
    eq('环 → error', r.status, 'error')
    ok('环：原因提到最大步数', String(r.reason).includes('最大步数'), r.reason)
    eq('环：轨迹被截断在 maxSteps', r.trace.length, 10)
  }

  // ── 节点不存在 ──
  {
    const swf = { ...SWF, order: [{ from: 'ghost', to: 'a', when: 'signal.go', level: 2 }] }
    const r = await executeSwf(swf, { backend: echoBackend() })
    eq('节点不存在 → error', r.status, 'error')
  }

  // ── 后端抛异常不崩 ──
  {
    const boom = { name: 'boom', async call () { throw new Error('炸了') } }
    const r = await executeSwf(SWF, { backend: boom })
    eq('后端抛异常：状态 fail', r.trace[0].status, 'fail')
    ok('后端抛异常：错误被记下', String(r.trace[0].meta.error).includes('炸了'), JSON.stringify(r.trace[0].meta))
  }

  // ── 缺 backend ──
  {
    let threw = false
    try { await executeSwf(SWF, {}) } catch (_) { threw = true }
    ok('缺 backend 时明确抛错', threw)
  }

  // ── 数据传递：prev / args / env ──
  {
    const r = await executeSwf(SWF, { backend: echoBackend(), args: { goal: 'G', refs: [7, 8] } })
    eq('第一步无 prev', r.trace[0].input.prev, undefined)
    eq('第二步收到 prev', r.trace[1].input.prev, '[free] plan')
    eq('args 透传', r.trace[0].input.req, { goal: 'G', refs: [7, 8] })
    eq('refs 透传', r.trace[0].input.refs, [7, 8])
    eq('env.artifact.type 取自 output.body', r.trace[0].env.artifact.type, 'free')
    eq('env.artifact.count', r.trace[0].env.artifact.count, 1)
  }

  // ── trace 形状（训练语料的形状）──
  {
    const r = await executeSwf(SWF, { backend: echoBackend() })
    const keys = Object.keys(r.trace[0]).sort()
    eq('trace 字段完整', keys, ['amz', 'env', 'expr', 'input', 'meta', 'output', 'seq', 'signal', 'status', 'to', 'via'].sort())
  }

  // ── onStep 回调 ──
  {
    const seen = []
    await executeSwf(SWF, { backend: echoBackend(), onStep: (s) => seen.push(s.amz) })
    eq('onStep 每步回调', seen, ['plan', 'a'])
  }

  // ── safeEval ──
  eq('safeEval 真', safeEval('signal.go', { signal: { go: true }, artifact: {}, run: {}, args: {} }), true)
  eq('safeEval 假', safeEval('signal.go', { signal: { go: false }, artifact: {}, run: {}, args: {} }), false)
  eq('safeEval 失败', safeEval('signal.nope', { signal: {}, artifact: {}, run: {}, args: {} }), 'fail')
  eq('safeEval 非字符串', safeEval(null, {}), 'fail')

  // ── loader.prepare 接执行器 ──
  {
    const p = loader.prepare(SWF, { library: {} })
    const r = await executeSwf(p.swf, { backend: echoBackend() })
    eq('prepare 输出可直接执行', r.status, 'completed')
  }

  // ── echo 后端 ──
  {
    const be = echoBackend()
    const r = await be.call({ amz: { id: 'x', output: { body: 'text', signal: { fields: { f1: 'bool', f2: 'int', f3: 'text', f4: 'refs' } } } } })
    eq('echo 默认信号', r.signal, { f1: true, f2: 1, f3: 'x', f4: [1] })
    eq('echo 产出带 body 标记', r.output, '[text] x')

    const be2 = echoBackend({ signals: { x: { f2: 9 } } })
    const r2 = await be2.call({ amz: { id: 'x', output: { body: 'text', signal: { fields: { f2: 'int' } } } } })
    eq('echo overrides 生效', r2.signal, { f2: 9 })

    const be3 = echoBackend({ failOn: ['x'] })
    const r3 = await be3.call({ amz: { id: 'x', output: { body: 'text' } } })
    eq('echo failOn 返回失败', r3.ok, false)
  }

  // ── 用户消息渲染 ──
  {
    const msg = renderUserMessage({ req: { goal: '写文档' }, refs: [1, 2], prev: '草稿' },
      { id: 'x', output: { body: 'docx', signal: { fields: { go: 'bool' } } } })
    ok('渲染含诉求', msg.includes('写文档'), msg)
    ok('渲染含标号', msg.includes('1, 2'), msg)
    ok('渲染含上一步', msg.includes('草稿'), msg)
    ok('渲染含信号块说明', msg.includes('JSON 信号块'), msg)
  }

  // ── 信号抽取（级 2 机制）──
  {
    const F = { go: 'bool', n: 'int' }
    eq('抽 fenced json', extractSignal('正文\n```json\n{"go":true,"n":3}\n```', F), { go: true, n: 3 })
    eq('抽尾部裸对象', extractSignal('正文\n{"go":false}', F), { go: false })
    eq('抽最后一个对象', extractSignal('{"go":true}\n后面还有\n{"go":false,"n":2}', F), { go: false, n: 2 })
    eq('类型不符的字段被丢', extractSignal('{"go":"yes","n":2}', F), { n: 2 })
    eq('未声明字段被丢', extractSignal('{"go":true,"extra":1}', F), { go: true })
    eq('无 JSON → 空对象', extractSignal('纯文本没有 JSON', F), {})
    eq('非法 JSON → 空对象', extractSignal('{"go":', F), {})
    eq('无声明字段 → 空对象', extractSignal('{"go":true}', {}), {})
    eq('非字符串输入', extractSignal(null, F), {})
  }

  // ── http 后端：请求构建（纯函数）──
  {
    const be = httpBackend({ apiKey: 'K', baseUrl: 'https://api.example.com/' })
    const req = be.buildRequest({
      amz: { id: 'x', model: 'M', prompt: 'SYS', output: { body: 'text', signal: { fields: { go: 'bool' } } } },
      input: { req: { goal: 'G' }, refs: [], prev: undefined },
    })
    eq('http url 拼接', req.url, 'https://api.example.com/chat/completions')
    req.headers.authorization === 'Bearer K'
    eq('http 鉴权头', req.headers.authorization, 'Bearer K')
    eq('http model', req.body.model, 'M')
    eq('http 消息角色', req.body.messages.map((m) => m.role), ['system', 'user'])
    ok('http system 是 AMZ 的 prompt', req.body.messages[0].content === 'SYS')
  }

  // ── http 后端：完整 call 路径（注入假 fetch，不联网）──
  {
    const calls = []
    const fakeFetch = async (url, init) => {
      calls.push({ url, init })
      return { ok: true, async json () { return { choices: [{ message: { content: '正文\n{"go":true}' } }], usage: { total_tokens: 7 } } } }
    }
    const be = httpBackend({ apiKey: 'K', fetchImpl: fakeFetch })
    const r = await be.call({
      amz: { id: 'x', model: 'M', prompt: 'SYS', output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      input: { req: {}, refs: [], prev: undefined },
    })
    eq('http call 成功', r.ok, true)
    ok('http call 返回正文', String(r.output).startsWith('正文'))
    eq('http call 抽出信号', r.signal, { go: true })
    eq('http call 发出一次请求', calls.length, 1)

    const beNoKey = httpBackend({ fetchImpl: fakeFetch })
    const rNoKey = await beNoKey.call({ amz: { id: 'x', model: 'M', output: {} }, input: { req: {} } })
    eq('http 缺 key → 失败', rNoKey.ok, false)

    const beBad = httpBackend({ apiKey: 'K', fetchImpl: async () => ({ ok: false, status: 429, async text () { return 'rate limited' } }) })
    const rBad = await beBad.call({ amz: { id: 'x', model: 'M', output: {} }, input: { req: {} } })
    eq('http 非 2xx → 失败', rBad.ok, false)
    ok('http 非 2xx 带状态码', String(rBad.meta.error).includes('429'), JSON.stringify(rBad.meta))

    const beBoom = httpBackend({ apiKey: 'K', fetchImpl: async () => { throw new Error('网络炸了') } })
    const rBoom = await beBoom.call({ amz: { id: 'x', model: 'M', output: {} }, input: { req: {} } })
    eq('http 网络异常 → 失败不抛', rBoom.ok, false)
    ok('http 网络异常带原因', String(rBoom.meta.error).includes('网络炸了'), JSON.stringify(rBoom.meta))
  }

  // ── dsh 后端：适配点 ──
  {
    const beNo = dshBackend()
    const r = await beNo.call({ amz: { id: 'x' }, input: {} })
    eq('dsh 无适配实现 → 失败', r.ok, false)

    const seen = []
    const be = dshBackend({ spawn: async ({ amz }) => { seen.push(['spawn', amz.id]); return { ok: true, output: 'O', sessionId: 's1' } },
      fork: async ({ amz }) => { seen.push(['fork', amz.id]); return { ok: true, output: 'F' } } })
    await be.call({ amz: { id: 'a', kind: 'exp' }, input: {} })
    await be.call({ amz: { id: 'b', kind: 'step' }, input: {} })
    eq('dsh：exp 走 spawn、step 走 fork', seen, [['spawn', 'a'], ['fork', 'b']])
  }

  // ── 用 $ref 的 SWF 必须也能跑（回归：节点表曾建自未解析的 amz 数组）──
  {
    const LIB = { write_word: { id: 'write_word', kind: 'exp', prompt: 'W', tools: ['docx_write'], model: 'm', output: { body: 'docx' } } }
    const swf = {
      id: 't', version: 1, invoke: { when: 'x' },
      amz: [
        { id: 'plan', kind: 'exp', prompt: 'P', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
        { $ref: 'amz/write_word' },
      ],
      order: [{ from: 'plan', to: 'write_word', when: 'signal.go', level: 2, else: 'write_word' }],
      terminal: ['write_word'],
      ui: { page: ['AGT', 'WFW', 'DIR', 'WPC'] },
    }
    const noLib = await executeSwf(swf, { backend: echoBackend() })
    eq('$ref 未给库 → 报节点不存在', noLib.status, 'error')

    const withLib = await executeSwf(swf, { backend: echoBackend(), amzLibrary: LIB })
    eq('$ref 给了库 → 跑通', withLib.status, 'completed')
    eq('$ref 节点序列', withLib.trace.map((s) => s.amz), ['plan', 'write_word'])
    eq('$ref 用的是库里的 AMZ（body=docx）', withLib.trace[1].env.artifact.type, 'docx')

    const g = buildGraph(swf, LIB)
    eq('buildGraph 解析 $ref 后节点表完整', [...g.amzById.keys()], ['plan', 'write_word'])
  }

  // ── 暂停 / 恢复（`signal.ask` 约定）──
  {
    const ASK = {
      id: 't', version: 1, invoke: { when: 'x' },
      amz: [
        { id: 'judge', kind: 'exp', prompt: 'J', tools: [], output: { body: 'free', signal: { fields: { is_homework: 'bool' } } } },
        { id: 'extract', kind: 'exp', prompt: 'E', tools: [], output: { body: 'free', signal: { fields: { ask: 'text', ok: 'bool' } } } },
        { id: 'work', kind: 'exp', prompt: 'W', tools: [], output: { body: 'text' } },
        { id: 'other', kind: 'exp', prompt: 'O', tools: [], output: { body: 'text' } },
      ],
      order: [
        { from: 'judge', to: 'extract', when: 'signal.is_homework', level: 2, else: 'other' },
        { from: 'extract', to: 'work', when: 'signal.ok', level: 2, else: 'other' },
      ],
      terminal: ['work', 'other'],
      ui: { page: ['AGT', 'WFW', 'DIR', 'WPC'] },
    }

    // echo 的 text 默认是 'x' → ask 非空 → 应暂停
    const p1 = await executeSwf(ASK, { backend: echoBackend() })
    eq('报出 ask → 暂停', p1.status, 'paused')
    eq('暂停点', p1.pause.at, 'extract')
    eq('恢复目标：出边已选好', p1.pause.next, 'work')
    ok('问题非空', typeof p1.pause.question === 'string' && p1.pause.question.length > 0)
    eq('暂停步也进轨迹，via=pause', p1.trace.map((s) => s.via), ['when', 'pause'])

    const p2 = await executeSwf(ASK, { backend: echoBackend(), startAt: p1.pause.next })
    eq('从 next 恢复 → 完成', p2.status, 'completed')
    eq('恢复只走剩余步骤', p2.trace.map((s) => s.amz), ['work'])

    const p3 = await executeSwf(ASK, { backend: echoBackend({ signals: { extract: { ask: '' } } }) })
    eq('ask 为空 → 不暂停', p3.status, 'completed')
    eq('ask 为空 → 一路走完', p3.trace.map((s) => s.amz), ['judge', 'extract', 'work'])

    const p4 = await executeSwf(ASK, { backend: echoBackend(), startAt: 'ghost' })
    eq('startAt 指向不存在的节点 → error', p4.status, 'error')
  }

  // ── BOM 处理 ──
  {
    const fs = require('node:fs')
    const path = require('node:path')
    const os = require('node:os')
    const f = path.join(os.tmpdir(), 'llmr-bom-test.json')
    fs.writeFileSync(f, '\uFEFF{"swf":{"id":"bom","amz":[]}}', 'utf8')
    const p = loader.prepare(f)
    eq('带 BOM 的声明可读', p.swf.id, 'bom')
    eq('stripBom 直接可用', loader.stripBom('\uFEFFx'), 'x')
    eq('stripBom 对无 BOM 无副作用', loader.stripBom('x'), 'x')
    fs.unlinkSync(f)
  }


// ══════════ 环控区（pool）══════════
// 「允许环，但环必须进环控」：主流程无环；池由监听器激活，maxRounds 封顶。

const POOL_SWF = {
  id: 'pooled', version: 1, invoke: { when: 'x' },
  amz: [
    { id: 'a', kind: 'exp', prompt: 'P', tools: [], output: { body: 'free', signal: { fields: { go: 'bool', build_ok: 'bool' } } } },
    { id: 'done', kind: 'exp', prompt: 'D', tools: [], output: { body: 'text' } },
    { id: 'diagnose', kind: 'ttc', prompt: 'X', tools: [], output: { body: 'text' } },
    { id: 'patch', kind: 'ttc', prompt: 'Y', tools: [], output: { body: 'text' } },
  ],
  // 只有一条出边 → 不需要 else；不匹配时就"走不通"，正好交给环控区
  order: [{ from: 'a', to: 'done', when: 'signal.build_ok == true', level: 2 }],
  terminal: ['done'],
}

// ① 池不触发 → 主流程照常，零开销
{
  const r = await executeSwf(POOL_SWF, {
    backend: echoBackend({ signals: { a: { build_ok: true } } }),
    args: {},
    pool: undefined,
  })
  eq('池未触发：主流程照常走完', r.status, 'completed')
  eq('池未触发：轨迹只有主流程两步', r.trace.map((x) => x.amz), ['a', 'done'])
  eq('池未触发：poolRounds 为空', r.poolRounds, {})
}

// ② 监听器触发 → 池跑一轮；resume 把主流程接回 a
{
  const r = await executeSwf(Object.assign({}, POOL_SWF, {
    pool: [{ id: 'retry', on: 'signal.build_ok == false', run: ['diagnose', 'patch'], resume: 'a', maxRounds: 3 }],
  }), {
    backend: echoBackend({ signals: { a: { build_ok: false } } }),
    args: {},
  })
  const ids = r.trace.map((x) => x.amz)
  ok('池触发：diagnose / patch 都跑到了', ids.includes('diagnose') && ids.includes('patch'), ids.join(' → '))
  ok('池步骤带 pool 标记与轮次', r.trace.some((x) => x.pool === 'retry' && x.round === 1), JSON.stringify(r.trace.map((x) => x.pool)))
  eq('池步骤的 via = pool', r.trace.filter((x) => x.pool).every((x) => x.via === 'pool'), true)
}

// ③ maxRounds 封顶：监听器恒为真也不会无限
{
  const r = await executeSwf(Object.assign({}, POOL_SWF, {
    pool: [{ id: 'spin', on: 'signal.build_ok == false', run: ['diagnose'], resume: 'a', maxRounds: 2 }],
  }), { backend: echoBackend({ signals: { a: { build_ok: false } } }), args: {} })
  eq('maxRounds=2：池恰好跑 2 轮', r.poolRounds.spin, 2)
  eq('maxRounds=2：池步骤数 = 2 × run 长度', r.trace.filter((x) => x.pool === 'spin').length, 2)
}

// ④ resume 让主流程回到指定节点（这是 AutoRun「改坏了自己回头修」的形状）
{
  const swf = Object.assign({}, POOL_SWF, {
    pool: [{ id: 'fix', on: 'signal.build_ok == false', run: ['diagnose'], resume: 'a', maxRounds: 1 }],
  })
  const r = await executeSwf(swf, { backend: echoBackend({ signals: { a: { build_ok: false } } }), args: {} })
  const ids = r.trace.map((x) => x.amz)
  ok('resume 生效：池跑完后主流程又执行了一次 a', ids.filter((x) => x === 'a').length === 2, ids.join(' → '))
}

// ⑤ 没有 resume → 池跑完就停在主流程的原处
{
  const swf = Object.assign({}, POOL_SWF, {
    pool: [{ id: 'react', on: 'signal.build_ok == false', run: ['diagnose'], maxRounds: 1 }],
  })
  const r = await executeSwf(swf, { backend: echoBackend({ signals: { a: { build_ok: false } } }), args: {} })
  eq('无 resume：池只跑一轮（rounds 用满）', r.poolRounds.react, 1)
  eq('无 resume：主流程停在非终态', r.status, 'stopped')
}

// ⑥ 池内 ask → 暂停（跑团「该你行动了」靠这个）
{
  const swf = {
    id: 'dndish', version: 1, invoke: { when: 'x' },
    amz: [
      { id: 'a', kind: 'exp', prompt: 'P', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { id: 'done', kind: 'exp', prompt: 'D', tools: [], output: { body: 'text' } },
      { id: 'judge', kind: 'exp', prompt: 'J', tools: [], output: { body: 'text' } },
      { id: 'narrate', kind: 'exp', prompt: 'N', tools: [], output: { body: 'text', signal: { fields: { ask: 'text' } } } },
    ],
    order: [{ from: 'a', to: 'done', when: 'signal.go == true', level: 2 }],
    terminal: ['done'],
    pool: [{ id: 'turn', on: 'event.player_action == true', run: ['judge', 'narrate'], maxRounds: 50 }],
  }
  const r = await executeSwf(swf, { backend: echoBackend({ signals: {} }), args: {}, events: { player_action: true } })
  eq('池内 ask → 整个运行暂停', r.status, 'paused')
  eq('暂停点在池内节点', r.pause.at, 'narrate')
  eq('暂停带 pool 归属', r.pause.pool, 'turn')
}

// ⑦ event. 来自 opts.events，不是 AMZ 自报
{
  const swf = Object.assign({}, POOL_SWF, {
    pool: [{ id: 'z', on: 'event.tick == true', run: ['diagnose'], maxRounds: 1 }],
  })
  const noEvent = await executeSwf(swf, { backend: echoBackend({ signals: { a: { build_ok: true } } }), args: {} })
  eq('未注入 event → 池不触发', noEvent.poolRounds, {})
  const withEvent = await executeSwf(swf, {
    backend: echoBackend({ signals: { a: { build_ok: true } } }), args: {}, events: { tick: true },
  })
  eq('注入 event.tick → 池触发', withEvent.poolRounds.z, 1)
}

// ══════════ selectScreen ══════════
{
  const swf = { ui: { screens: [
    { id: 'run', title: 'R', entry: 'ui/r.html', when: "signal.stage == 'run'" },
    { id: 'goal', title: 'G', entry: 'ui/g.html' },
  ] } }
  eq('selectScreen：when 命中就用它', selectScreen(swf, { signal: { stage: 'run' } }).id, 'run')
  eq('selectScreen：都不命中用兜底', selectScreen(swf, { signal: { stage: 'zzz' } }).id, 'goal')
  eq('selectScreen：没有 ui 段返回 null', selectScreen({}, {}), null)
  eq('selectScreen：按数组顺序，第一个为真者胜出',
    selectScreen({ ui: { screens: [
      { id: 'x', title: 'X', entry: 'ui/x.html', when: 'signal.go == true' },
      { id: 'y', title: 'Y', entry: 'ui/y.html', when: 'signal.go == true' },
    ] } }, { signal: { go: true } }).id, 'x')
}
  console.log(`\n执行器与后端: ${pass} 通过 / ${fail} 失败`)
  process.exitCode = fail ? 1 : 0
}

main().catch((e) => { console.error(`自测异常：${e && e.stack ? e.stack : e}`); process.exit(1) })
