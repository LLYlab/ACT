'use strict'
// ACT 阶段 1：加载器
//
// 职责：文件 → 内存中规范化的 SWF。只读，不改任何东西。
//   ① 读声明（JSON / YAML）与 AMZ 库
//   ② 解析 $ref
//   ③ 应用 defaults
//   ④ 导出时物化 extends（CSP_AMZ）为普通 AMZ
//   ⑤ 生成人类可读摘要
//
// 这是「共享库」：校验器也从这里取归一化与 $ref 解析，
// 避免同一套逻辑在两处各写一份而悄悄漂移。

const fs = require('node:fs')
const path = require('node:path')

// ── 依赖解析（本工具不在 DSH 包内运行，需显式探测）──────────────────────
const PROJECT_ROOT = path.join(__dirname, '..', '..')
const DEP_BASES = [
  process.cwd(),
  PROJECT_ROOT,
  'C:/Users/L2959/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh',
  'C:/Users/L2959/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules',
]

function resolveDep (spec) {
  for (const b of DEP_BASES) {
    try { return require(require.resolve(spec, { paths: [b] })) } catch (_) { /* next */ }
  }
  return null
}

function loadYaml () {
  const mod = resolveDep('js-yaml')
  return mod && mod.default ? mod.default : mod
}

// ── 归一（校验器也用它）──────────────────────────────────────────────────
// 注意 `v || []` 只在 null/undefined 时兜底；值是字符串或数字时它原样穿过，
// 下一行就炸。所以必须显式判类型。
const asArray = (v) => (Array.isArray(v) ? v : [])
const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})

// ── 读文件 ───────────────────────────────────────────────────────────────
// ⚠ UTF-8 BOM：Windows 工具（记事本、PowerShell 的 Set-Content）默认会写 BOM，
// 而 `JSON.parse` 遇到 U+FEFF 会直接抛错。这不是理论问题——实测踩到过。
const stripBom = (s) => (typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

function readJsonText (file) {
  return stripBom(fs.readFileSync(file, 'utf8'))
}

function readDecl (file) {
  const raw = readJsonText(file)
  if (/\.ya?ml$/i.test(file)) {
    const yaml = loadYaml()
    if (!yaml) throw new Error('需要 js-yaml 才能读 YAML；请改用 .json 或安装 js-yaml')
    return yaml.load(raw)
  }
  return JSON.parse(raw)
}

/** 读一个目录下的 AMZ 声明，返回 {id: amz} */
function readLibrary (dir) {
  const lib = {}
  if (!dir || !fs.existsSync(dir)) return lib
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(json|ya?ml)$/i.test(f)) continue
    try {
      const doc = readDecl(path.join(dir, f))
      const amz = doc && doc.amz ? doc.amz : doc
      if (amz && typeof amz.id === 'string') lib[amz.id] = amz
    } catch (_) { /* 坏文件不吞掉问题：缺失会由 E105 暴露 */ }
  }
  return lib
}

// ── $ref 解析（校验器也用）──────────────────────────────────────────────
/**
 * @returns {{amzs: Array, problems: Array<{path,code,message,hint?}>}}
 */
function resolveAmz (entries, library) {
  const lib = asObject(library)
  const amzs = []
  const problems = []

  asArray(entries).forEach((e, i) => {
    const p = `/swf/amz/${i}`
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      problems.push({ path: p, code: 'ACT-E105', message: `AMZ 项不是对象：${String(JSON.stringify(e)).slice(0, 40)}` })
      return
    }
    if (typeof e.$ref === 'string') {
      const key = e.$ref.replace(/^amz\//, '')
      const target = lib[key]
      if (!target) {
        problems.push({ path: `${p}/$ref`, code: 'ACT-E105', message: `引用的 AMZ 不存在：${e.$ref}`, hint: '确认 AMZ 库里有这个 id，或就地内联定义' })
        return
      }
      amzs.push({ id: target.id, amz: target, path: p, fromRef: true })
      return
    }
    amzs.push({ id: e.id, amz: e, path: p, fromRef: false })
  })

  return { amzs, problems }
}

// ── 应用 defaults（SWF 级默认，AMZ 可覆盖）──────────────────────────────
function applyDefaults (swf) {
  const out = { ...asObject(swf) }
  const d = asObject(out.defaults)
  out.amz = asArray(out.amz).map((e) => {
    if (!e || typeof e !== 'object' || '$ref' in e) return e
    const a = { ...e }
    if (a.model === undefined && d.model !== undefined) a.model = d.model
    if (a.tools === undefined && Array.isArray(d.tools)) a.tools = [...d.tools]
    return a
  })
  if (out.terminal === undefined) out.terminal = []
  const ui = asObject(out.ui)
  if (ui.fallback === undefined) out.ui = { ...ui, fallback: 'native' }
  return out
}

// ── 物化 extends（CSP_AMZ）────────────────────────────────────────────────
/**
 * 导出时把 `extends` 展平为普通 AMZ：基座字段 + 覆写的 prompt。
 *
 * 为什么展平：自包含导出必须不依赖本地库。展平后 `extends` 消失、变成普通 AMZ，
 * 导出的产物描述的是一个**已实例化**的工作流。
 * CSP 约束（不得声明 tools/guards/model）在**编写期**由校验器保证，不在导出后重复检查。
 */
function materializeExtends (swf, library) {
  const lib = asObject(library)
  const problems = []
  const out = { ...asObject(swf) }

  out.amz = asArray(out.amz).map((e, i) => {
    const p = `/swf/amz/${i}`
    if (!e || typeof e !== 'object' || typeof e.extends !== 'string') return e
    const key = e.extends.replace(/^amz\//, '')
    const base = lib[key]
    if (!base) {
      problems.push({ path: `${p}/extends`, code: 'ACT-E105', message: `extends 引用的基座 AMZ 不存在：${e.extends}` })
      return e
    }
    const merged = { ...base, ...e }
    delete merged.extends
    if (e.prompt !== undefined) merged.prompt = e.prompt
    return merged
  })

  return { swf: out, problems }
}

// ── 导出：内联所有 $ref，产出自包含单文件 ─────────────────────────────
function inlineRefs (swf, library) {
  const lib = asObject(library)
  const src = asObject(swf)
  const problems = []
  const out = { ...src }

  out.amz = asArray(src.amz).map((e, i) => {
    if (!e || typeof e !== 'object' || typeof e.$ref !== 'string') return e
    const key = e.$ref.replace(/^amz\//, '')
    const target = lib[key]
    if (!target) {
      problems.push({ path: `/swf/amz/${i}/$ref`, code: 'ACT-E112', message: `导出失败：引用的 AMZ 不存在 ${e.$ref}` })
      return e
    }
    return JSON.parse(JSON.stringify(target))
  })

  return { swf: out, problems }
}

// ── 一站式准备 ───────────────────────────────────────────────────────────
/**
 * @param {string|object} source 文件路径或已解析的对象
 * @param {{library?: object, libraryDir?: string, forExport?: boolean}} opts
 */
function prepare (source, opts = {}) {
  const problems = []

  let doc
  if (typeof source === 'string') {
    try { doc = readDecl(source) } catch (e) { return { problems: [{ path: '/', code: 'ACT-E999', message: `无法读取声明：${e.message}` }] } }
  } else {
    doc = source
  }

  const library = { ...readLibrary(opts.libraryDir), ...asObject(opts.library) }

  let swf = asObject(doc && doc.swf !== undefined ? doc.swf : doc)
  swf = applyDefaults(swf)

  if (opts.forExport) {
    const m = materializeExtends(swf, library)
    swf = m.swf
    problems.push(...m.problems)
    const inl = inlineRefs(swf, library)
    swf = inl.swf
    problems.push(...inl.problems)
  }

  const { amzs, problems: refProblems } = resolveAmz(swf.amz, library)
  problems.push(...refProblems)

  return { swf, amzs, library, problems: problems.length ? problems : undefined }
}

// ── 人类可读摘要 ─────────────────────────────────────────────────────────
function summarize (swf, opts = {}) {
  const src = asObject(swf)
  const { amzs } = resolveAmz(src.amz, asObject(opts.library))
  const lines = []

  const title = src.title ? `「${src.title}」` : ''
  lines.push(`SWF ${src.id || '(无 id)'}  v${src.version ?? '?'}  ${title}`.trimEnd())

  // 图
  const adj = new Map()
  for (const e of asArray(src.order)) {
    const o = asObject(e)
    if (!adj.has(o.from)) adj.set(o.from, [])
    adj.get(o.from).push(o)
  }
  const froms = new Set(asArray(src.order).map((e) => asObject(e).from))
  const targets = new Set()
  for (const e of asArray(src.order)) { const o = asObject(e); targets.add(o.to); if (o.else !== undefined) targets.add(o.else) }
  const entry = [...froms].filter((n) => !targets.has(n))

  lines.push(`入口: ${entry.length === 1 ? entry[0] : `不唯一（${entry.length} 个）`}`)
  lines.push('')
  lines.push('图:')
  const printed = new Set()
  const walk = (node, depth) => {
    const pad = '  '.repeat(depth)
    lines.push(`${pad}${node}`)
    printed.add(node)
    for (const e of adj.get(node) || []) {
      const cond = `${e.when ?? '?'}  (level ${e.level ?? '?'})`
      lines.push(`${pad}  └─[${cond}]─> ${e.to}`)
      if (e.else !== undefined) lines.push(`${pad}  └─[else]─> ${e.else}`)
      if (!printed.has(e.to) && !adj.has(e.to)) { lines.push(`${pad}      ${e.to} (终态)`); printed.add(e.to) }
      if (e.else !== undefined && !printed.has(e.else) && !adj.has(e.else)) { lines.push(`${pad}      ${e.else} (终态)`); printed.add(e.else) }
      if (adj.has(e.to) && !printed.has(e.to)) walk(e.to, depth + 2)
    }
  }
  if (entry.length === 1) walk(entry[0], 0)
  else for (const n of froms) if (!printed.has(n)) walk(n, 0)

  for (const a of amzs) {
    if (!froms.has(a.id) && !targets.has(a.id)) lines.push(`  ${a.id}  (游离，不在任何边上)`)
  }

  // 能力表面
  lines.push('')
  lines.push('AMZ:')
  for (const a of amzs) {
    const t = asArray(a.amz.tools)
    const g = asArray(a.amz.guards)
    lines.push(`  ${String(a.id).padEnd(18)} tools=[${t.join(', ')}]${g.length ? ` guards=${g.length}` : ''}${a.amz.model ? ` model=${a.amz.model}` : ''}`)
  }

  const ui = asObject(src.ui)
  lines.push('')
  lines.push(`UI: [${asArray(ui.page).join(', ')}]  fallback=${ui.fallback ?? '(未设)'}`)

  return lines.join('\n')
}

module.exports = {
  PROJECT_ROOT, resolveDep, loadYaml,
  asArray, asObject, stripBom, readJsonText,
  readDecl, readLibrary,
  resolveAmz, applyDefaults, materializeExtends, inlineRefs,
  prepare, summarize,
}
