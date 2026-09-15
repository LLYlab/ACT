#!/usr/bin/env node
'use strict'
// 文档一致性审计：码空间 + 检查项数
//
// 文档集有 9 份文件、5 份已废弃，单靠人读一定会漂。
// 码空间是唯一能被机器对齐的接缝——任何一份漏了码，或写了实现里不存在的码，这里都会露出来。
//
// 项数同理：实测文档里同时写着「15 项」「16 项」两种数字，而实现里是 17 项。
// 所以项数也从代码取真值（`checks.cjs` 的 `CHECKS`），文档只能与它一致。
//
// 用法：node auditcodes.cjs

const fs = require('node:fs')
const path = require('node:path')
const { CHECKS } = require('./checks.cjs')

const ROOT = path.join(__dirname, '..', '..')
const RE = /ACT-[EW]\d{3}/g

const readDoc = (rel) => {
  const abs = path.join(ROOT, rel)
  return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null
}

const codesOf = (rel) => {
  const s = readDoc(rel)
  return s === null ? null : new Set(s.match(RE) || [])
}

// 「实现」= 两个文件并集：checks.cjs 出语义码，validate.cjs 出结构/降级码
const impl = new Set()
const implFiles = ['tools/validator/checks.cjs', 'tools/validator/validate.cjs']
for (const f of implFiles) {
  const s = codesOf(f)
  if (!s) { console.error(`缺少实现文件：${f}`); process.exit(2) }
  for (const c of s) impl.add(c)
}

const specs = {
  'ACT-校验器规格.md': codesOf('ACT-校验器规格.md'),
  'ACT-设计规格.md': codesOf('ACT-设计规格.md'),
}

let bad = 0
const fmt = (s) => (s.size ? [...s].sort().join(', ') : '(无)')

console.log(`实现 ${impl.size} 个码 · 来源 ${implFiles.join(' + ')}`)
console.log(fmt(impl))
console.log('')

for (const [name, set] of Object.entries(specs)) {
  if (!set) { console.log(`✗ ${name} 不存在`); bad++; continue }
  const missing = [...impl].filter((c) => !set.has(c))
  const extra = [...set].filter((c) => !impl.has(c))
  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ ${name}  ${set.size} 个码，与实现完全一致`)
  } else {
    bad++
    console.log(`✗ ${name}  ${set.size} 个码`)
    if (missing.length) console.log(`    实现有、它没有：${missing.join(', ')}`)
    if (extra.length) console.log(`    它有、实现没有：${extra.join(', ')}`)
  }
}

// ── 项数一致性 ──
console.log('')
const N = CHECKS.length
console.log(`实现 ${N} 项检查 · 来源 checks.cjs 的 CHECKS`)

// (1) 码目录：CHECKS 里声明的码，必须恰好等于实现用的语义码集合
//     （反过来也查：实现里出现、CHECKS 没登记 → 有人加了检查却忘了登记）
const listed = new Set()
for (const c of CHECKS) for (const code of c.codes) listed.add(code)
const structOnly = new Set(['ACT-E001', 'ACT-E999', 'ACT-W000']) // 结构 / 工具自身状态，不属语义项
const semImpl = new Set([...impl].filter((c) => !structOnly.has(c)))
{
  const missing = [...semImpl].filter((c) => !listed.has(c))
  const extra = [...listed].filter((c) => !semImpl.has(c))
  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ CHECKS 登记齐全  ${listed.size} 个语义码`)
  } else {
    bad++
    console.log('✗ CHECKS 与实现不符')
    if (missing.length) console.log(`    实现有、CHECKS 没登记：${missing.join(', ')}`)
    if (extra.length) console.log(`    CHECKS 有、实现没有：${extra.join(', ')}`)
  }
}

// (2) 设计规格 §13.3 的检查表，行数必须等于 N
{
  const s = readDoc('ACT-设计规格.md')
  const sec = s && s.split('### 13.3')[1]
  const rows = sec ? (sec.split(/\n### /)[0].match(/^\|\s*(\d+)\s*\|/gm) || []) : []
  const nums = rows.map((r) => Number(r.replace(/[^\d]/g, '')))
  if (nums.length === N && nums.every((n, i) => n === i + 1)) {
    console.log(`✓ ACT-设计规格.md §13.3  ${N} 行，编号连续`)
  } else {
    bad++
    console.log(`✗ ACT-设计规格.md §13.3  表里 ${nums.length} 行（应为 ${N}），编号：${nums.join(',') || '(解析不到)'}`)
  }
}

// (3) 散文里写的项数，必须等于 N。
//     抓的就是「N 项检查」「检查（N 项）」「校验规则（N 项）」这几种写法——
//     实测它们同时写着 15、16、17 三个数字。
{
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '_shot' || e.name === 'node_modules') continue
      const p = path.join(dir, e.name)
      // 两处不扫：
      //   docs/history/ —— 归档的旧规格，里面的项数是**它自己当时的**，不是断言现在有几项
      //   auditcodes.cjs 自己 —— 这段说明文字必然要举例提到数字
      if (e.isDirectory()) { if (e.name !== 'history') walk(p); continue }
      if (e.name === 'auditcodes.cjs') continue
      if (/\.(md|cjs|json)$/.test(e.name)) files.push(path.relative(ROOT, p).replace(/\\/g, '/'))
    }
  }
  walk(ROOT)

  // 先剥掉 markdown 强调与代码标记：`**16 项**语义检查` 里的星号会让正则漏掉它
  const normalize = (s) => s.replace(/[*`]/g, '')

  // 中文数字也写进文档了（「十五项检查」）。只做 0–29，够用且不会猜错。
  const CN = { 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const cn2num = (t) => {
    if (!t) return NaN
    if (t === '十') return 10
    if (t.length === 1) return CN[t]
    if (t[0] === '十') return 10 + (CN[t[1]] || 0)
    if (t[1] === '十') return (CN[t[0]] || 0) * 10 + (t[2] ? CN[t[2]] || 0 : 0)
    return NaN
  }
  const CN_RE = /([一二三四五六七八九十]{1,3})项/g
  const cnNorm = (s) => s.replace(CN_RE, (m, t) => {
    const v = cn2num(t)
    return Number.isNaN(v) ? m : `${v} 项`
  })

  const PATTERNS = [
    /(\d+)\s*项[\s\S]{0,3}?检查/g,
    /检查[（(]\s*(\d+)\s*项/g,
    /校验规则[（(]\s*(\d+)\s*项/g,
    /检查表[^\n]{0,6}?(\d+)\s*行/g,
  ]
  const hits = []
  for (const rel of files) {
    const txt = readDoc(rel)
    if (!txt) continue
    txt.split('\n').forEach((raw, i) => {
      // 历史陈述不是断言：那是「当时的规格只有 10 行表」，不是「现在有 10 项检查」。
      // 这类行用 `（历史）` 显式标出，审计就不该管它。
      if (raw.includes('（历史）') || raw.includes('(历史)')) return
      const line = cnNorm(normalize(raw))
      for (const re of PATTERNS) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(line))) {
          if (Number(m[1]) !== N) hits.push(`${rel}:${i + 1}  写着「${raw.trim().slice(0, 70)}」，实现是 ${N} 项`)
        }
      }
    })
  }
  if (hits.length === 0) {
    console.log(`✓ 所有文档的项数与实现一致（${N} 项）`)
  } else {
    bad++
    console.log(`✗ ${hits.length} 处项数不一致：`)
    for (const h of hits) console.log(`    ${h}`)
  }
}

console.log('')
console.log(bad === 0 ? '码空间一致性: 通过' : `码空间一致性: 不通过（${bad} 处）`)
process.exitCode = bad ? 1 : 0
