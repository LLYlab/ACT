#!/usr/bin/env node
'use strict'
// ACT when-求值器与静态分析的测试
// 上一轮发布的 expression.cjs 里 evaluate() 是阶段 2 要复用的那份实现，但当时未测。
// 用法：node exprtest.cjs

const expr = require('./expression.cjs')

let pass = 0
let fail = 0

function eq (name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { console.log(`✓ ${name}`); pass++ } else { console.log(`✗ ${name}\n    期望 ${e}\n    实际 ${a}`); fail++ }
}

function ev (src, env) {
  return expr.evaluate(expr.parse(src), env)
}

const ENV = {
  signal: { go: true, n: 5, k: 'b', note: 'abc' },
  artifact: { type: 'docx', count: 2, refs: [1, 2] },
  run: { status: 'ok' },
  args: { goal: '写一份文档' },
}

// ── 基本比较 ──
eq('bool ==', ev('signal.go == true', ENV), { ok: true, value: true })
eq('bool == 反例', ev('signal.go == false', ENV), { ok: true, value: false })
eq('bool !=', ev('signal.go != false', ENV), { ok: true, value: true })
eq('int >', ev('signal.n > 3', ENV), { ok: true, value: true })
eq('int < 反例', ev('signal.n < 3', ENV), { ok: true, value: false })
eq('string ==', ev("run.status == 'ok'", ENV), { ok: true, value: true })
eq('artifact.type', ev("artifact.type == 'docx'", ENV), { ok: true, value: true })

// ── in / startsWith ──
eq('in 命中', ev("signal.k in ['a','b']", ENV), { ok: true, value: true })
eq('in 未命中', ev("signal.k in ['x','y']", ENV), { ok: true, value: false })
eq('in 空数组', ev('signal.k in []', ENV), { ok: true, value: false })
eq('startsWith 命中', ev("signal.note startsWith 'ab'", ENV), { ok: true, value: true })
eq('startsWith 未命中', ev("signal.note startsWith 'zz'", ENV), { ok: true, value: false })

// ── 逻辑与优先级 ──
eq('not', ev('not signal.go', ENV), { ok: true, value: false })
eq('not (not x)', ev('not not signal.go', ENV), { ok: true, value: true })
eq('and', ev('signal.go == true and signal.n > 1', ENV), { ok: true, value: true })
eq('or', ev('signal.go == false or signal.n > 1', ENV), { ok: true, value: true })
eq('and 优先于 or', ev('signal.go == false or signal.go == true and signal.n > 99', ENV), { ok: true, value: false })
eq('括号改变结合', ev('(signal.go == false or signal.go == true) and signal.n > 1', ENV), { ok: true, value: true })
eq('多层嵌套', ev("(signal.n > 1 and (signal.k in ['b'] or run.status == 'no')) or artifact.count > 9", ENV), { ok: true, value: true })

// ── 裸布尔字段（本轮新增文法）──
eq('裸布尔 真', ev('signal.go', ENV), { ok: true, value: true })
eq('裸布尔 假', ev('signal.go', { signal: { go: false } }), { ok: true, value: false })
eq('裸布尔 not', ev('not signal.go', ENV), { ok: true, value: false })
eq('裸布尔 not not', ev('not not signal.go', ENV), { ok: true, value: true })
eq('裸布尔 与比较混用', ev('signal.go and signal.n > 1', ENV), { ok: true, value: true })
eq('裸非布尔 → 求值失败（只有 bool 可以）', ev('signal.n', ENV), { ok: false, reason: 'signal.n 不是布尔值，不能单独作为条件' })
eq('裸文本 → 求值失败', ev('artifact.type', ENV), { ok: false, reason: 'artifact.type 不是布尔值，不能单独作为条件' })

// ── 短路 ──
eq('or 短路：右侧字段缺失也不失败', ev('signal.go == true or signal.missing == 1', ENV), { ok: true, value: true })
eq('and 左真右假', ev('signal.go == true and signal.missing == 1', ENV), { ok: false, reason: '字段未定义 signal.missing' })
eq('and 左假仍会失败（不短路掉失败）', ev('signal.go == false and signal.missing == 1', ENV), { ok: true, value: false })

// ── 求值失败（调用方据此走 else，不是校验错误）──
eq('字段未定义', ev('signal.nope == 1', ENV), { ok: false, reason: '字段未定义 signal.nope' })
eq('命名空间未定义', ev('ghost.x == 1', ENV), { ok: false, reason: '字段未定义 ghost.x' })
eq('类型不匹配 bool vs int', ev('signal.go == 1', ENV), { ok: false, reason: '类型不匹配：boolean vs number' })
eq('类型不匹配 int vs text', ev("signal.n == '5'", ENV), { ok: false, reason: '类型不匹配：number vs string' })
eq('> 用字符串', ev("signal.note > 'a'", ENV), { ok: false, reason: '> / < 两侧必须是数字' })
eq('startsWith 用数字', ev("signal.n > 'a'", ENV), { ok: false, reason: '> / < 两侧必须是数字' })
eq('== 不支持数组', ev('artifact.refs == true', ENV), { ok: false, reason: '== / != 不支持数组' })
eq('非法变量名（三段）', ev('a.b.c == 1', ENV), { ok: false, reason: '非法变量名 a.b.c' })

// ── 静态分析 ──
const A = (s) => expr.parse(s)
eq('namespacesOf 单', [...expr.namespacesOf(A("signal.go == true"))].sort(), ['signal'])
eq('namespacesOf 多', [...expr.namespacesOf(A("signal.go == true and artifact.type == 'x'"))].sort(), ['artifact', 'signal'])
eq('signalFieldsOf', [...expr.signalFieldsOf(A("signal.a == true or signal.b == 2"))].sort(), ['a', 'b'])
eq('signalFieldsOf 忽略其它命名空间', [...expr.signalFieldsOf(A("artifact.type == 'x' and signal.a == true"))], ['a'])
eq('badIdentsOf 全部合法', expr.badIdentsOf(A("signal.a == true"), ['signal', 'artifact', 'run', 'args']), [])
eq('badIdentsOf 抓到越界命名空间', expr.badIdentsOf(A("ghost.a == true"), ['signal', 'artifact']), ['ghost.a'])
eq('badIdentsOf 抓到三段名', expr.badIdentsOf(A('a.b.c == 1'), ['a']), ['a.b.c'])

// ── 文法报错 ──
function throws (name, src) {
  try { A(src); console.log(`✗ ${name}（未报错）`); fail++ } catch (e) {
    if (e.name === 'ParseError') { console.log(`✓ ${name}`); pass++ } else { console.log(`✗ ${name}（抛的是 ${e.name}）`); fail++ }
  }
}
throws('未闭合括号', '(signal.go == true')
throws('未闭合字符串', "signal.go == 'x")
throws('缺字面量', 'signal.go ==')
throws('缺运算符', 'signal.go true')
throws('末尾多余', 'signal.go == true extra')
throws('非法字符', 'signal.go @ true')
throws('空表达式', '')

console.log(`\n求值器/分析: ${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
