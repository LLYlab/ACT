#!/usr/bin/env node
'use strict'
// LLMR 执行器 · 命令行 —— 它就是一个程序
//
// 用法：
//   node run.cjs <swf> [--lib=dir] [--backend=echo|http|dsh]
//                     [--args='{"goal":"…"}'] [--signal=amzId.field=value]… [--fail=amzId]…
//                     [--max-steps=n] [--trace=out.json] [--json]
//                     [--base-url=…] [--api-key=…]
//
// 退出码：0 完成 · 1 未完成/出错 · 2 用法错误

const fs = require('node:fs')
const path = require('node:path')
const loader = require('./loader.cjs')
const { executeSwf } = require('./executor.cjs')
const { echoBackend, httpBackend, dshBackend } = require('./backends.cjs')

function parseArgs (argv) {
  const out = { _: [], multi: {} }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (!m) { out._.push(a); continue }
    const k = m[1]
    const v = m[2] === undefined ? true : m[2]
    if (out.multi[k] === undefined) out.multi[k] = []
    out.multi[k].push(v)
    if (!Array.isArray(out[k])) out[k] = v
  }
  return out
}

function coerce (raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+$/.test(raw)) return Number(raw)
  if (/^[[{"]/.test(raw)) { try { return JSON.parse(raw) } catch (_) { return raw } }
  return raw
}

/** --signal=amzId.field=value → { amzId: { field: value } } */
function parseSignals (specs) {
  const out = {}
  for (const s of specs || []) {
    const m = /^([^.]+)\.([^=]+)=(.*)$/.exec(String(s))
    if (!m) continue
    const [, amz, field, raw] = m
    out[amz] = out[amz] || {}
    out[amz][field] = coerce(raw)
  }
  return out
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  const target = args._[0]
  if (!target) {
    console.error('用法：node run.cjs <swf> [--lib=dir] [--backend=echo|http|dsh] [--args=json] [--signal=amzId.field=value] [--fail=amzId] [--trace=out.json]')
    process.exit(2)
  }
  if (!fs.existsSync(target)) { console.error(`SWF 不存在：${target}`); process.exit(2) }

  const backendName = String(args.backend || 'echo')
  let backend
  if (backendName === 'echo') {
    backend = echoBackend({ signals: parseSignals(args.multi.signal), failOn: args.multi.fail || [] })
  } else if (backendName === 'http') {
    const apiKey = args['api-key'] || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY
    if (!apiKey) { console.error('http 后端需要 --api-key=… 或环境变量 DEEPSEEK_API_KEY'); process.exit(2) }
    if (!args.yes) {
      console.error('⚠ http 后端会发起**真实模型调用并消耗额度**。确认请加 --yes。')
      process.exit(2)
    }
    backend = httpBackend({ apiKey, baseUrl: args['base-url'], timeoutMs: Number(args['timeout-ms']) || undefined })
  } else if (backendName === 'dsh') {
    backend = dshBackend()
  } else {
    console.error(`未知后端：${backendName}（可选 echo / http / dsh）`)
    process.exit(2)
  }

  // 加载并归一
  const prepared = loader.prepare(target, { libraryDir: args.lib })
  if (prepared.problems) {
    console.error('✗ 加载有问题：')
    for (const p of prepared.problems) console.error(`  ${p.code}  ${p.path}\n      ${p.message}`)
    process.exit(1)
  }

  let entryArgs = {}
  if (typeof args['args-file'] === 'string') {
    try { entryArgs = JSON.parse(loader.readJsonText(path.resolve(args['args-file']))) }
    catch (e) { console.error(`--args-file 读取失败：${e.message}`); process.exit(2) }
  } else if (typeof args.args === 'string') {
    try { entryArgs = JSON.parse(args.args) }
    catch (e) {
      console.error(`--args 不是合法 JSON：${e.message}`)
      console.error('（PowerShell 会吃掉 JSON 里的内层引号——复杂参数请改用 --args-file）')
      process.exit(2)
    }
  }

  const r = await executeSwf(prepared.swf, {
    backend,
    args: entryArgs,
    maxSteps: Number(args['max-steps']) || undefined,
    amzLibrary: prepared.library,
  })

  if (args.json) {
    console.log(JSON.stringify({ ok: r.ok, status: r.status, reason: r.reason, steps: r.trace.length, trace: r.trace, finalOutput: r.finalOutput }, null, 2))
  } else {
    console.log('LLMR 运行')
    console.log(`源: ${target}`)
    console.log(`后端: ${backend.name}`)
    console.log(`入口: ${r.trace.length ? r.trace[0].amz : '(未知)'}`)
    console.log('')
    for (const s of r.trace) {
      const arrow = s.to === undefined ? '■ 终止' : `→ ${s.to}`
      const why = s.via ? `  [${s.via}${s.expr ? ` ${s.expr}` : ''}]` : ''
      console.log(`  ${String(s.seq + 1).padStart(2)}. ${String(s.amz).padEnd(18)} ${s.status.padEnd(5)} ${arrow}${why}`)
      if (s.status === 'fail' && s.meta && s.meta.error) console.log(`        ! ${s.meta.error}`)
    }
    console.log('')
    console.log(`结果: ${r.status}${r.reason ? ` —— ${r.reason}` : ''}`)
    if (r.finalOutput !== undefined) console.log(`最终产出: ${typeof r.finalOutput === 'string' ? r.finalOutput.split('\n')[0].slice(0, 120) : JSON.stringify(r.finalOutput)}`)
    console.log(`轨迹: ${r.trace.length} 步`)
  }

  if (typeof args.trace === 'string') {
    const out = path.resolve(args.trace)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.writeFileSync(out, JSON.stringify({
      swf: prepared.swf.id,
      backend: backend.name,
      args: entryArgs,
      ok: r.ok,
      status: r.status,
      reason: r.reason || null,
      steps: r.trace.map((s) => ({
        seq: s.seq, amz: s.amz, status: s.status,
        input: s.input, output: s.output, signal: s.signal,
        env: s.env, to: s.to, via: s.via, expr: s.expr, meta: s.meta,
      })),
    }, null, 2) + '\n', 'utf8')
    if (!args.json) console.log(`轨迹已写入: ${out}`)
  }

  process.exitCode = r.ok ? 0 : 1
}

main().catch((e) => { console.error(`执行器异常：${e && e.stack ? e.stack : e}`); process.exit(1) })
