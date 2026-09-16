'use strict'
// LLMR 执行后端
//
// AMZ 的「执行」是可插拔的：同一条 SWF，可以交给
//   · echo  —— 确定性后端，不调模型（测试用，也让整条图可端到端跑）
//   · http  —— LLMR 自己调模型（OpenAI 兼容 /chat/completions）
//   · dsh   —— 交给 DSH 的对话执行（spawn / fork 子会话）
//
// 后端接口：
//   async call({ amz, input, args }) -> { ok, output, signal?, meta? }
//   input = { req, refs, prev }   // 诉求 / 资料标号 / 上一步产出
//
// AMZ 失败不是异常：返回 { ok:false } 即可，执行器会把它折成 run.status='fail'，
// 交给判断边去分支（规格 §9.3 的 run.status）。

const { asArray, asObject } = require('./loader.cjs')

// ── 输入渲染（http 后端用；独立出来是为了可测）──────────────────────────
function renderUserMessage (input, amz) {
  const out = asObject(asObject(amz).output)
  const fields = asObject(asObject(out.signal).fields)
  const L = []
  const req = asObject(input).req
  if (req.goal !== undefined) L.push(`诉求：${req.goal}`)
  else if (Object.keys(req).length) L.push(`诉求：${JSON.stringify(req)}`)
  const refs = asArray(asObject(input).refs)
  if (refs.length) L.push(`资料标号：${refs.join(', ')}`)
  const prev = asObject(input).prev
  if (prev !== undefined) L.push(`上一步产出：\n${typeof prev === 'string' ? prev : JSON.stringify(prev)}`)
  if (Object.keys(fields).length) {
    const shape = Object.fromEntries(Object.entries(fields).map(([k, t]) => [k, t === 'bool' ? false : t === 'int' ? 0 : t === 'refs' ? [] : '']))
    L.push(`正文照常写。**最后另起一段**，附一个 JSON 信号块，字段与类型如下：\n${JSON.stringify(shape, null, 2)}`)
  }
  return L.join('\n\n')
}

// ── 从模型输出里抽尾部信号块（规格 §9.5 的级 2 机制）────────────────────
function extractSignal (text, fields) {
  const declared = asObject(fields)
  if (!Object.keys(declared).length) return {}
  const s = typeof text === 'string' ? text : ''
  // 取最后一个 ```json ... ``` 或最后一个平衡的 {...}
  const fenced = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
  let candidate = fenced.length ? fenced[fenced.length - 1][1] : null
  if (candidate === null) {
    const start = s.lastIndexOf('{')
    if (start >= 0) {
      let depth = 0
      for (let i = start; i < s.length; i++) {
        if (s[i] === '{') depth++
        else if (s[i] === '}') { depth--; if (depth === 0) { candidate = s.slice(start, i + 1); break } }
      }
    }
  }
  if (candidate === null) return {}
  let obj
  try { obj = JSON.parse(candidate) } catch (_) { return {} }
  const out = {}
  for (const [k, t] of Object.entries(declared)) {
    if (!(k in asObject(obj))) continue
    const v = obj[k]
    const okType =
      (t === 'bool' && typeof v === 'boolean') ||
      (t === 'int' && typeof v === 'number' && Number.isFinite(v)) ||
      (t === 'text' && typeof v === 'string') ||
      (t === 'refs' && Array.isArray(v))
    if (okType) out[k] = v
  }
  return out
}

// ── echo：确定性后端 ─────────────────────────────────────────────────────
/**
 * @param {{signals?: object, failOn?: string[], outputs?: object}} opts
 *   signals: { amzId: { field: value } } 覆写默认信号，用来走不同的边
 *   failOn:  让这些 AMZ 返回失败（测 run.status 分支）
 *   outputs: { amzId: '正文' } 覆写输出正文。默认是 `[body] amzId`，
 *            做 UI 时要看**像样的成品**长什么样，就靠这个喂一段真的进去。
 */
function echoBackend (opts = {}) {
  const overrides = asObject(opts.signals)
  const outs = asObject(opts.outputs)
  const failOn = new Set(asArray(opts.failOn))
  return {
    name: 'echo',
    async call ({ amz }) {
      const a = asObject(amz)
      if (failOn.has(a.id)) return { ok: false, meta: { backend: 'echo', reason: 'failOn' } }
      const declared = asObject(asObject(asObject(a.output).signal).fields)
      const signal = {}
      for (const [k, t] of Object.entries(declared)) {
        // `ask` 是**唯一会被人直接读到**的字段：它会被当成暂停时的问题显示出来。
        // 给它填 `'x'` 的话，干跑一次界面上就只有一个光秃秃的 `x` —— 那不像话。
        signal[k] = k === 'ask' ? '（echo 后端：这一句本来是你真正要问用户的话）'
          : t === 'bool' ? true : t === 'int' ? 1 : t === 'refs' ? [1] : 'x'
      }
      Object.assign(signal, asObject(overrides[a.id]))
      const body = asObject(a.output).body
      const out = outs[a.id] !== undefined ? outs[a.id] : `[${body}] ${a.id}`
      return { ok: true, signal, output: out, meta: { backend: 'echo', model: a.model } }
    },
  }
}

// ── http：LLMR 自己调模型（OpenAI 兼容）──────────────────────────────────
function httpBackend (opts = {}) {
  const baseUrl = String(opts.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
  const apiKey = opts.apiKey
  const fetchImpl = opts.fetchImpl
  const timeoutMs = opts.timeoutMs || 120000
  const maxTokens = opts.maxTokens

  return {
    name: 'http',

    /** 纯函数：把 AMZ + 输入变成一次 HTTP 请求。可单测。 */
    buildRequest ({ amz, input }) {
      const a = asObject(amz)
      const messages = []
      if (a.prompt) messages.push({ role: 'system', content: String(a.prompt) })
      messages.push({ role: 'user', content: renderUserMessage(input, a) })
      const body = { model: a.model, messages }
      if (maxTokens) body.max_tokens = maxTokens
      return {
        url: `${baseUrl}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey ?? ''}` },
        body,
      }
    },

    async call (ctx) {
      const a = asObject(ctx.amz)
      const req = this.buildRequest(ctx)
      const f = fetchImpl || (typeof fetch === 'function' ? fetch : null)
      if (typeof f !== 'function') return { ok: false, meta: { backend: 'http', error: '当前运行时没有 fetch' } }
      if (!apiKey) return { ok: false, meta: { backend: 'http', error: '缺少 apiKey' } }

      const ac = typeof AbortController === 'function' ? new AbortController() : null
      const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null
      let res
      try {
        res = await f(req.url, { method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ac ? ac.signal : undefined })
      } catch (e) {
        if (timer) clearTimeout(timer)
        return { ok: false, meta: { backend: 'http', error: `请求失败：${e && e.message ? e.message : e}` } }
      }
      if (timer) clearTimeout(timer)

      if (!res || !res.ok) {
        let detail = ''
        try { detail = (await res.text()).slice(0, 200) } catch (_) { /* ignore */ }
        return { ok: false, meta: { backend: 'http', error: `HTTP ${res ? res.status : '?'} ${detail}` } }
      }
      let json
      try { json = await res.json() } catch (e) { return { ok: false, meta: { backend: 'http', error: '响应不是 JSON' } } }
      const text = json?.choices?.[0]?.message?.content
      if (typeof text !== 'string') return { ok: false, meta: { backend: 'http', error: '响应里没有 choices[0].message.content' } }

      const fields = asObject(asObject(asObject(a.output).signal).fields)
      const signal = extractSignal(text, fields)
      return { ok: true, output: text, signal, meta: { backend: 'http', model: req.body.model, usage: json.usage } }
    },
  }
}

// ── dsh：交给 DSH 的对话执行（适配点，未实测）──────────────────────────
/**
 * 在 DSH 里，一个 AMZ 就是一个 DSH 对话：
 *   ttc / exp  → 一个全新子会话（`subagent`，对应 spawn）
 *   step       → 从某个端点分叉（`subagent_fork`，对应 fork）
 * 工具表固定 → 该子会话的 preset，或对该 agent scope 施加 `tools.restrict`
 * 模型固定   → preset 的模型路由
 *
 * 这里只留接口；真正实现要跑在 DSH 进程里（见 LLMR-设计规格.md §5.1）。
 */
function dshBackend (handlers = {}) {
  const spawn = handlers.spawn
  const fork = handlers.fork
  return {
    name: 'dsh',
    async call ({ amz, input }) {
      const a = asObject(amz)
      const fn = a.kind === 'step' ? fork : spawn
      if (typeof fn !== 'function') return { ok: false, meta: { backend: 'dsh', error: '缺少 dsh 适配实现（spawn/fork）' } }
      const r = asObject(await fn({ amz: a, input }))
      return { ok: r.ok !== false, output: r.output, signal: asObject(r.signal), meta: { backend: 'dsh', sessionId: r.sessionId } }
    },
  }
}

module.exports = { echoBackend, httpBackend, dshBackend, renderUserMessage, extractSignal }
