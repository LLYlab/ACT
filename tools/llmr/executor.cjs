'use strict'
// LLMR 执行器：按 SWF 声明走图，把每个 AMZ 交给一个 backend 执行
//
// 语义依据 LLMR-设计规格.md：
//   §6.2  边是硬编码的；有分支的边组必须有 else
//   §9.3  判断边的确定性变量：artifact.* / run.* / args.*
//   §9.4  求值失败（缺字段/类型不符）→ **走 else**，不中止
//   §9.5  级 2 信号由 AMZ 自报，backend 负责产出
//
// AMZ 执行失败**不是异常**：折成 run.status='fail'，交给判断边分支。

const { asArray, asObject, resolveAmz } = require('./loader.cjs')
const expr = require('./expression.cjs')

const DEFAULT_MAX_STEPS = 64

/** 求值一条 when：true / false / 'fail'（规格 §9.4） */
function safeEval (src, env) {
  if (typeof src !== 'string') return 'fail'
  let ast
  try { ast = expr.parse(src) } catch (_) { return 'fail' }
  const r = expr.evaluate(ast, env)
  return r.ok ? r.value : 'fail'
}

/**
 * 暂停约定：AMZ 报出**非空** `signal.ask`(text) → 执行器在此停下，把这段话当问题交给用户。
 *
 * 为什么用 signal 而不是新字段：`output.signal` 本来就是"AMZ 自报的结构化信息"，
 * 且 schema 已冻结在 v1.0。用现成通道，不新增结构。
 * AMZ 想暂停，就在 `output.signal.fields` 里声明 `ask: "text"`，并在需要确认时报出它。
 */
function askOf (signal) {
  const q = asObject(signal).ask
  return (typeof q === 'string' && q.trim() !== '') ? q.trim() : null
}

/** 从声明里建图（纯函数，可单测） */
function buildGraph (swf, library) {
  const src = asObject(swf)
  const adj = new Map()
  for (const e of asArray(src.order)) {
    const o = asObject(e)
    if (!adj.has(o.from)) adj.set(o.from, [])
    adj.get(o.from).push(o)
  }
  const froms = new Set(asArray(src.order).map((e) => asObject(e).from))
  const targets = new Set()
  for (const e of asArray(src.order)) {
    const o = asObject(e)
    targets.add(o.to)
    if (o.else !== undefined) targets.add(o.else)
  }
  const entries = [...froms].filter((n) => !targets.has(n))

  // ⚠ 必须解析 $ref。声明里常见 `{ "$ref": "amz/xxx" }`，那种项**没有 id**；
  // 直接拿 swf.amz 建节点表，图里那些节点就查不到，走到那一步会报「节点不存在」。
  // 这个坑只在「用 AMZ 库的 SWF」上出现——全内联的测试永远撞不到。
  const { amzs } = resolveAmz(asArray(src.amz), asObject(library))
  const amzById = new Map()
  for (const a of amzs) {
    if (typeof a.id === 'string' && a.amz && typeof a.amz === 'object') amzById.set(a.id, a.amz)
  }

  return { adj, entries, amzById, terminal: new Set(asArray(src.terminal)) }
}

/**
 * @param {object} swf      已加载/归一化的 SWF（loader.prepare 的输出）
 * @param {{backend, args?, maxSteps?, onStep?}} opts
 * @returns {{ok, status:'completed'|'stopped'|'error', reason?, trace, finalOutput?, last?}}
 */
async function executeSwf (swf, opts = {}) {
  const backend = opts.backend
  if (!backend || typeof backend.call !== 'function') throw new Error('executeSwf 需要 backend')
  const args = asObject(opts.args)
  const maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : null

  const g = buildGraph(swf, opts.amzLibrary)
  const trace = []

  // 恢复：从指定节点接着走（暂停后的第二次调用）
  const startAt = typeof opts.startAt === 'string' && opts.startAt !== '' ? opts.startAt : null
  if (!startAt && g.entries.length !== 1) {
    return { ok: false, status: 'error', reason: `入口不唯一（${g.entries.length} 个）`, trace }
  }

  let cur = startAt || g.entries[0]
  let prev
  let steps = 0

  while (cur !== undefined) {
    if (++steps > maxSteps) {
      return { ok: false, status: 'error', reason: `超过最大步数 ${maxSteps}（图里可能有环）`, trace }
    }
    const amz = g.amzById.get(cur)
    if (!amz) return { ok: false, status: 'error', reason: `节点不存在：${cur}`, trace }

    const input = { req: args, refs: asArray(args.refs), prev }

    let res
    try {
      res = asObject(await backend.call({ amz, input, args }))
    } catch (e) {
      res = { ok: false, meta: { error: `后端抛异常：${e && e.message ? e.message : e}` } }
    }

    const status = res.ok === true ? 'ok' : 'fail'
    const output = res.output
    const signal = asObject(res.signal)
    const env = {
      signal,
      artifact: {
        type: asObject(asObject(amz).output).body,
        count: output === undefined ? 0 : 1,
        refs: asArray(args.refs),
      },
      run: { status },
      args,
    }

    // ── 选出边 ──
    const outs = g.adj.get(cur) || []
    let to
    let via
    let exprText
    let evalFailed = false

    if (outs.length) {
      for (const e of outs) {
        if (e.when === undefined) continue
        const r = safeEval(e.when, env)
        if (r === 'fail') { evalFailed = true; break } // 规格 §9.4：失败即走 else
        if (r === true) { to = e.to; via = 'when'; exprText = e.when; break }
      }
      if (to === undefined) {
        const def = outs.find((e) => e.else !== undefined)
        if (def) {
          to = def.else
          via = evalFailed ? 'else(eval-failed)' : 'else'
          exprText = evalFailed ? def.when : undefined
        }
      }
    }

    const step = { seq: trace.length, amz: cur, status, input, output, signal, env, to, via, expr: exprText, meta: res.meta }

    // ── 暂停：AMZ 报出 `ask` → 停下来问用户，出边已经选好，恢复时从那里继续 ──
    const question = askOf(signal)
    if (question) {
      step.via = 'pause'
      trace.push(step)
      if (onStep) onStep(step)
      return {
        ok: false,
        status: 'paused',
        pause: { at: cur, question, next: to === undefined ? null : to, seq: step.seq },
        trace,
        finalOutput: output,
        last: step,
      }
    }

    trace.push(step)
    if (onStep) onStep(step)

    // ── 终止判定 ──
    if (to === undefined) {
      const isTerm = g.terminal.has(cur)
      return {
        ok: isTerm && status === 'ok',
        status: isTerm ? 'completed' : 'stopped',
        reason: isTerm
          ? undefined
          : `停在非终态节点 ${cur}（${outs.length ? (evalFailed ? '判断边求值失败且无 else' : '无边匹配且无 else') : '无出边'}）`,
        trace,
        finalOutput: output,
        last: step,
      }
    }

    prev = output
    cur = to
  }

  return { ok: false, status: 'error', reason: '走到了 undefined', trace }
}

module.exports = { executeSwf, buildGraph, safeEval, DEFAULT_MAX_STEPS }
