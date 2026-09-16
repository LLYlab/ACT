#!/usr/bin/env node
'use strict'
// expression.cjs 的健壮性测试
//
// 动机：LLMR 校验器要吃**别人手写的**声明（"拷贝大佬的"路径）。
// 解析器对畸形输入只允许抛 ParseError；抛别的（TypeError / RangeError）或挂死
// 都是真缺陷——那意味着一份坏文件能把工具打崩。
//
// 用法：node fuzztest.cjs [轮数]

const expr = require('./expression.cjs')

const N = Number(process.argv[2] || 20000)
let bad = 0
let parsed = 0
let rejected = 0

// 确定性 PRNG，保证可复现
let seed = 20260915
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const pick = (a) => a[Math.floor(rnd() * a.length)]

const ALPHABET = [
  'signal', 'artifact', 'run', 'args', 'go', 'n', 'type',
  '==', '!=', 'in', '>', '<', 'startsWith', 'and', 'or', 'not',
  'true', 'false', "'x'", '1', '[', ']', '(', ')', ',', '.', ' ',
]

const ENV = {
  signal: { go: true, n: 5 },
  artifact: { type: 'docx', count: 2 },
  run: { status: 'ok' },
  args: { goal: 'g' },
}

function check (src, label) {
  let ast
  try {
    ast = expr.parse(src)
  } catch (e) {
    if (e instanceof expr.ParseError) { rejected++; return }
    console.log(`✗ 抛了非 ParseError：${e.constructor.name}: ${e.message}`)
    console.log(`    输入(${src.length} 字符): ${JSON.stringify(src.slice(0, 120))}`)
    bad++
    return
  }
  parsed++
  if (ast === undefined || ast === null) {
    console.log(`✗ parse 返回了 ${ast}（应为 AST 或抛错）: ${JSON.stringify(src.slice(0, 120))}`)
    bad++
    return
  }
  try {
    const r = expr.evaluate(ast, ENV)
    if (!r || typeof r.ok !== 'boolean') {
      console.log(`✗ evaluate 返回形状不对: ${JSON.stringify(r)}  来自 ${JSON.stringify(src.slice(0, 120))}`)
      bad++
    }
  } catch (e) {
    console.log(`✗ evaluate 抛出：${e.constructor.name}: ${e.message}`)
    console.log(`    输入: ${JSON.stringify(src.slice(0, 120))}`)
    bad++
  }
}

// ── 1. 随机 token 汤 ──
console.log(`随机 token 汤 × ${N} …`)
for (let i = 0; i < N; i++) {
  const len = 1 + Math.floor(rnd() * 8)
  const toks = []
  for (let j = 0; j < len; j++) toks.push(pick(ALPHABET))
  // 一半带空格分隔，一半直接拼接（造出更畸形的 token）
  check(rnd() < 0.5 ? toks.join(' ') : toks.join(''), 'soup')
}

// ── 2. 深度嵌套（递归深度攻击）──
const DEPTHS = [100, 1000, 5000, 20000, 60000]
for (const d of DEPTHS) {
  check('('.repeat(d) + 'signal.go' + ')'.repeat(d), `嵌套括号 ×${d}`)
  check('not '.repeat(d) + 'signal.go', `not ×${d}`)
  check("signal.go == true" + ' and signal.go == true'.repeat(d), `and 链 ×${d}`)
}

// ── 3. 超长字形 ──
check("signal.go == '" + 'a'.repeat(500000) + "'", '超长字符串字面量')
check('signal.' + 'a'.repeat(200000) + ' == true', '超长标识符')
check('signal.go == [' + '1,'.repeat(100000) + '1]', '超长数组')

// ── 4. 奇怪的字节 ──
for (const s of ['\u0000', '\uFEFF', 'signal\u0000.go', 'signal.go == \u201Cx\u201D', '🐦 == true', 'signal.go == 🐦', '\t\n\r signal.go']) {
  check(s, 'weird')
}

// ── 5. 合法表达式必须仍然可解析（防止 fuzz 误伤）──
const GOOD = [
  'signal.go',
  'signal.go == true',
  'not signal.go',
  "artifact.type == 'docx'",
  "signal.n > 1 and (signal.go or run.status == 'ok')",
  "signal.n in [1,2,3]",
  "artifact.type startsWith 'doc'",
]
for (const g of GOOD) {
  try {
    const ast = expr.parse(g)
    const r = expr.evaluate(ast, ENV)
    if (typeof r.ok !== 'boolean') { console.log(`✗ 合法表达式返回形状不对: ${g}`); bad++ }
    parsed++
  } catch (e) {
    console.log(`✗ 合法表达式被拒: ${g}  (${e.message})`)
    bad++
  }
}

console.log(`\n解析成功 ${parsed} · 正常拒绝 ${rejected} · 异常 ${bad}`)
console.log(bad === 0 ? '健壮性: 通过' : '健壮性: 不通过')
process.exitCode = bad ? 1 : 0
