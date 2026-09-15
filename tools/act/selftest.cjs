#!/usr/bin/env node
'use strict'
// ACT 阶段 1 加载器自测
// 覆盖：$ref 解析 / defaults 应用 / extends 物化 / 导出内联 / 自包含性 / 与校验器的接续
// 用法：node selftest.cjs

const loader = require('./loader.cjs')
const { runChecks } = require('../validator/checks.cjs')

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

const LIB = {
  write_word: { id: 'write_word', kind: 'exp', prompt: '写 word', tools: ['docx_write'], output: { body: 'docx' } },
  format_doc: { id: 'format_doc', kind: 'exp', prompt: '格式化', tools: [], output: { body: 'text' } },
}

const DOC = {
  swf: {
    id: 't',
    version: 1,
    invoke: { when: '需要时' },
    defaults: { model: 'm-default' },
    amz: [
      { id: 'plan', kind: 'exp', prompt: 'p', tools: [], output: { body: 'free', signal: { fields: { go: 'bool' } } } },
      { $ref: 'amz/write_word' },
      { id: 'format_strict', kind: 'exp', extends: 'amz/format_doc', prompt: '更严格' },
    ],
    order: [{ from: 'plan', to: 'write_word', when: 'signal.go', level: 2, else: 'format_strict' }],
    terminal: ['write_word', 'format_strict'],
    ui: { page: ['AGT', 'WFW', 'DIR', 'WPC'] },
  },
}

// ── applyDefaults ──
{
  const s = loader.applyDefaults(DOC.swf)
  eq('defaults.model 应用到缺 model 的 AMZ', s.amz[0].model, 'm-default')
  eq('AMZ 自己的 model 不被覆盖', (() => { const x = loader.applyDefaults({ amz: [{ id: 'a', model: 'own', tools: [] }], defaults: { model: 'd' } }); return x.amz[0].model })(), 'own')
  eq('$ref 项不被 defaults 触碰', s.amz[1], { $ref: 'amz/write_word' })
  eq('terminal 缺省补 []', loader.applyDefaults({ amz: [] }).terminal, [])
  eq('ui.fallback 缺省补 native', loader.applyDefaults({ amz: [], ui: { page: [] } }).ui.fallback, 'native')
  eq('defaults.tools 应用到缺 tools 的 AMZ', loader.applyDefaults({ amz: [{ id: 'a' }], defaults: { tools: ['x'] } }).amz[0].tools, ['x'])
}

// ── resolveAmz ──
{
  const r1 = loader.resolveAmz([{ id: 'a' }], {})
  eq('就地 AMZ 解析', r1.amzs.map((x) => x.id), ['a'])
  eq('就地 AMZ 无问题', r1.problems.length, 0)

  const r2 = loader.resolveAmz([{ $ref: 'amz/write_word' }], LIB)
  eq('$ref 解析出 id', r2.amzs.map((x) => x.id), ['write_word'])
  eq('$ref 标记 fromRef', r2.amzs[0].fromRef, true)

  const r3 = loader.resolveAmz([{ $ref: 'amz/nope' }], LIB)
  eq('$ref 缺失 → ACT-E105', r3.problems.map((p) => p.code), ['ACT-E105'])
  eq('$ref 缺失不产出 amz', r3.amzs.length, 0)

  const r4 = loader.resolveAmz([null, 42, 'x', []], {})
  eq('非对象项全部报 E105', r4.problems.length, 4)
  eq('非对象项不产出 amz', r4.amzs.length, 0)
}

// ── 导出：extends 物化 + $ref 内联 ──
{
  const p = loader.prepare(DOC, { library: LIB, forExport: true })
  eq('导出无问题', p.problems, undefined)

  const ids = p.swf.amz.map((a) => a.id)
  eq('导出后三个 AMZ 就位', ids, ['plan', 'write_word', 'format_strict'])

  const fw = p.swf.amz.find((a) => a.id === 'write_word')
  eq('$ref 已内联为实际 AMZ', fw.tools, ['docx_write'])

  const fs2 = p.swf.amz.find((a) => a.id === 'format_strict')
  eq('extends 已物化：继承基座 tools', fs2.tools, [])
  eq('extends 已物化：继承基座 output', fs2.output, { body: 'text' })
  eq('extends 已物化：prompt 被覆写', fs2.prompt, '更严格')
  eq('extends 已物化：字段已消失', fs2.extends, undefined)

  const dump = JSON.stringify(p.swf)
  ok('导出产物无残留 $ref', !dump.includes('"$ref"'), dump.slice(0, 200))
  ok('导出产物无残留 extends', !dump.includes('"extends"'), dump.slice(0, 200))
}

// ── 导出失败：$ref 无法解析 ──
{
  const p = loader.prepare(DOC, { library: {}, forExport: true })
  ok('缺库时导出报问题', Array.isArray(p.problems) && p.problems.length > 0)
  ok('报的是 E105/E112',
    p.problems.every((x) => x.code === 'ACT-E105' || x.code === 'ACT-E112'),
    JSON.stringify(p.problems))
}

// ── 非导出模式保留引用 ──
{
  const p = loader.prepare(DOC, { library: LIB })
  ok('非导出模式保留 $ref', JSON.stringify(p.swf).includes('"$ref"'))
  ok('非导出模式保留 extends', JSON.stringify(p.swf).includes('"extends"'))
}

// ── 与校验器接续：导出产物应当通过校验 ──
{
  const p = loader.prepare(DOC, { library: LIB, forExport: true })
  const r = runChecks(p.swf, { mode: 'author', amzLibrary: LIB })
  eq('导出产物通过校验（0 错误）', r.errors.map((e) => e.code), [])
  eq('导出产物通过校验（0 警告）', r.warnings.map((w) => w.code), [])
  eq('能力表面 3 行', r.surface.length, 3)
}

// ── summarize ──
{
  const p = loader.prepare(DOC, { library: LIB, forExport: true })
  const s = loader.summarize(p.swf, { library: LIB })
  ok('摘要含 id', s.includes('SWF t'))
  ok('摘要含入口', s.includes('入口: plan'))
  ok('摘要含 AMZ 行', s.includes('write_word') && s.includes('docx_write'))
  ok('摘要含 UI', s.includes('AGT, WFW, DIR, WPC'))
  ok('摘要含边条件', s.includes('level 2'))
}

// ── 健壮性：垃圾输入不抛异常 ──
{
  const junk = [null, undefined, 0, '', 'x', true, [], NaN, () => {}, { swf: null }, { swf: 'x' }, { swf: { amz: 'nope' } }, { swf: { amz: [null], order: 'x', terminal: 'y', ui: 3 } }]
  let threw = 0
  for (const j of junk) {
    try {
      const p = loader.prepare(j, { library: LIB })
      if (!p || typeof p !== 'object') { threw++; continue }
      loader.summarize(p.swf, { library: LIB })
    } catch (e) { threw++; console.log(`  崩溃于 ${JSON.stringify(j)}: ${e.message}`) }
  }
  eq('垃圾输入不抛异常', threw, 0)
}

// ── 文件读取 ──
{
  const path = require('node:path')
  const fixture = path.join(__dirname, '..', '..', 'verify', 'write_doc.swf.json')
  const p = loader.prepare(fixture)
  eq('从文件加载', p.swf.id, 'write_doc')
  eq('从文件加载无问题', p.problems, undefined)
  const bad = loader.prepare(path.join(__dirname, 'no_such_file.json'))
  eq('文件不存在 → 报 E999', bad.problems.map((x) => x.code), ['ACT-E999'])
}

console.log(`\n加载器: ${pass} 通过 / ${fail} 失败`)
process.exitCode = fail ? 1 : 0
