#!/usr/bin/env node
'use strict'
// ACT 阶段 1 加载器 · 命令行
//
// 用法：
//   node cli.cjs <decl.json|yml> [--lib=dir]          打印摘要（默认）
//   node cli.cjs <decl> --export=out.json            写出自包含单文件
//   node cli.cjs <decl> --json                        输出规范化后的对象
//
// 退出码：0 正常 · 1 有未解析引用等问题 · 2 用法/读取错误

const fs = require('node:fs')
const path = require('node:path')
const loader = require('./loader.cjs')

function parseArgs (argv) {
  const out = { _: [] }
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
    else out._.push(a)
  }
  return out
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  const target = args._[0]
  if (!target) {
    console.error('用法：node cli.cjs <decl> [--lib=dir] [--export=out.json] [--json]')
    process.exit(2)
  }
  if (!fs.existsSync(target)) {
    console.error(`声明文件不存在：${target}`)
    process.exit(2)
  }

  // ── 前端用的机器接口（与 ACT WebUI 共用 view.cjs 一份实现）──
  if (args.view) {
    const { viewOf } = require('./view.cjs')
    const view = viewOf(target, { libraryDir: args.lib })
    console.log(JSON.stringify(view, null, 2))
    process.exitCode = view.ok ? 0 : 1
    return
  }

  const forExport = typeof args.export === 'string'
  const r = loader.prepare(target, { libraryDir: args.lib, forExport })

  if (args.json) {
    console.log(JSON.stringify({ swf: r.swf, problems: r.problems || [] }, null, 2))
    process.exitCode = r.problems ? 1 : 0
    return
  }

  console.log('ACT 加载器')
  console.log(`源: ${target}`)
  console.log(`库: ${args.lib || '(未指定)'}`)
  console.log('')
  console.log(loader.summarize(r.swf, { library: r.library }))

  if (r.problems) {
    console.log('')
    console.log(`✗ 问题 ${r.problems.length}`)
    for (const p of r.problems) console.log(`  ${p.code}  ${p.path}\n      ${p.message}${p.hint ? `\n      → ${p.hint}` : ''}`)
  }

  if (forExport) {
    const outPath = path.resolve(args.export)
    const payload = { swf: r.swf }
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
    console.log('')
    console.log(r.problems ? `✗ 未写出（有未解析引用）：${outPath}` : `导出: ${outPath}（自包含，$ref 已内联、extends 已物化）`)
  }

  console.log('')
  console.log(`结果: ${r.problems ? '有问题' : '正常'}`)
  process.exitCode = r.problems ? 1 : 0
}

main()
