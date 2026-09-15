#!/usr/bin/env node
'use strict'
// ACT 校验器 · 阶段 0
// 用法：node validate.cjs <target> [--schema=path] [--mode=author|export|import]
//                              [--lib=dir] [--tools=json] [--pages=json] [--json]
//
// 管线见 ACT-校验器规格.md §2：[1] 加载 → [2] 结构校验 → [3] 语义校验 → [4] 产出

const fs = require('node:fs')
const path = require('node:path')
const { runChecks } = require('./checks.cjs')

// ── 共享件：依赖解析、读声明、读库（全部来自阶段 1 加载器）──
const loader = require('../act/loader.cjs')

function loadAjv () {
  const mod = loader.resolveDep('ajv/dist/2020')
  if (!mod) return null
  return mod.default || mod
}

// ── 参数 ──
function parseArgs (argv) {
  const out = { _: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
    else out._.push(a)
  }
  return out
}

const readTarget = loader.readDecl
const readAmzLibrary = loader.readLibrary

function readSet (file, label) {
  if (!file) return null
  if (!fs.existsSync(file)) {
    console.error(`${label} 文件不存在：${file}`)
    process.exit(2)
  }
  let v
  try {
    v = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    console.error(`${label} 解析失败：${e.message}`)
    process.exit(2)
  }
  if (Array.isArray(v)) return new Set(v)
  if (v && Array.isArray(v.tools)) return new Set(v.tools)
  console.error(`${label} 格式不对：应为字符串数组，或 {"tools": [...]}`)
  process.exit(2)
}

// ajv 的 oneOf/anyOf/if 会对**同一个路径**抛出一串分支错误（例如一个 CSP 越权会产生 12 条 E001）。
// 按 instancePath 折叠：优先保留带 failingKeyword 的那条（它指向真正失败的条件分支）。
function condenseAjvErrors (raw) {
  const byPath = new Map()
  for (const e of raw) {
    const p = e.instancePath || '/'
    if (!byPath.has(p)) byPath.set(p, [])
    byPath.get(p).push(e)
  }
  const out = []
  for (const [p, list] of byPath) {
    const branch = list.find((e) => e.params && e.params.failingKeyword)
    const primary = branch || list[0]
    const folded = list.length - 1
    let hint
    if (branch && branch.params.failingKeyword) hint = `failingKeyword=${branch.params.failingKeyword}`
    if (folded > 0) hint = (hint ? hint + '；' : '') + `同路径另有 ${folded} 条分支错误已折叠`
    out.push({ code: 'ACT-E001', path: p, message: primary.message, hint })
  }
  return out
}

// ── 主流程 ──
function main () {
  const args = parseArgs(process.argv.slice(2))
  const target = args._[0]
  if (!target) {
    console.error('用法：node validate.cjs <target> [--schema=path] [--mode=author|export|import] [--lib=dir] [--tools=json] [--pages=json] [--json]')
    process.exit(2)
  }

  const mode = args.mode || 'author'
  const schemaPath = args.schema || path.join(__dirname, '..', '..', 'act.schema.json')

  let doc
  try { doc = readTarget(target) } catch (e) {
    console.error(`无法读取目标：${e.message}`)
    process.exit(2)
  }

  const errors = []
  const warnings = []

  // [2] 结构校验
  const Ajv2020 = loadAjv()
  let schemaChecked = false
  if (Ajv2020 && fs.existsSync(schemaPath)) {
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const validate = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')))
    if (!validate(doc)) errors.push(...condenseAjvErrors(validate.errors))
    schemaChecked = true
  } else {
    warnings.push({ code: 'ACT-W000', path: '-', message: 'ajv 或 schema 不可用，已跳过结构校验' })
  }

  // [3] 语义校验 —— 结构不合法即中止（规格 §2：继续只会产生噪音）
  const swf = doc && doc.swf ? doc.swf : doc
  let result = { surface: [], surfaceHash: '-', entry: undefined }
  if (errors.length) {
    warnings.push({ code: 'ACT-W000', path: '-', message: '结构校验未通过，已跳过语义检查（避免噪音）' })
  } else {
    try {
      result = runChecks(swf, {
        mode,
        amzLibrary: readAmzLibrary(args.lib),
        toolRegistry: readSet(args.tools, '--tools'),
        uiPages: readSet(args.pages, '--pages'),
      })
      errors.push(...result.errors)
      warnings.push(...result.warnings)
    } catch (e) {
      errors.push({ code: 'ACT-E999', path: '/', message: `校验器内部错误：${e.message}` })
    }
  }

  // [4] 输出
  if (args.json) {
    console.log(JSON.stringify({ ok: errors.length === 0, mode, target, errors, warnings, surface: result.surface, surfaceHash: result.surfaceHash, entry: result.entry }, null, 2))
  } else {
    console.log(`ACT 校验器 · mode=${mode}${schemaChecked ? '' : '（无结构校验）'}`)
    console.log(`目标: ${target}\n`)

    if (errors.length) {
      console.log(`✗ 错误 ${errors.length}`)
      for (const e of errors) console.log(`  ${e.code}  ${e.path}\n      ${e.message}${e.hint ? `\n      → ${e.hint}` : ''}`)
      console.log('')
    }
    if (warnings.length) {
      console.log(`! 警告 ${warnings.length}`)
      for (const w of warnings) console.log(`  ${w.code}  ${w.path}\n      ${w.message}${w.hint ? `\n      → ${w.hint}` : ''}`)
      console.log('')
    }

    console.log(`能力表面  ${result.surfaceHash}`)
    for (const row of result.surface) {
      console.log(`  ${row.amz.padEnd(16)} tools=[${row.tools.join(', ')}]  guards=[${row.guards.join(', ')}]`)
    }
    console.log('')
    console.log(`结果: ${errors.length ? '不通过' : '通过'}（${errors.length} 错误 / ${warnings.length} 警告）`)
  }

  process.exitCode = errors.length ? 1 : 0
}

main()
