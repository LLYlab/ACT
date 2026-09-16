#!/usr/bin/env node
'use strict'
// 作业 SWF 端到端冒烟：拿一份真实的老师作业消息，走完 7 步效果。
//
// 这测的不是「函数对不对」（那是 executor.selftest.cjs 的 96 项），
// 而是「这份**真实声明**在真消息上会不会走到该走的地方」——
// 声明里的 when / signal 字段 / ask 约定，只有拿真流程跑才暴露得出来。
//
// 用法：
//   node tools/llmr/homework.smoke.cjs                 # 用内置的老师作业消息
//   node tools/llmr/homework.smoke.cjs "老师刚发的…"    # 用你自己的消息

const path = require('path')
const loader = require('./loader.cjs')
const { executeSwf, buildGraph } = require('./executor.cjs')
const { echoBackend } = require('./backends.cjs')

const SWF = path.resolve(__dirname, '..', '..', 'swfs', 'homework.swf.json')
const PDF = 'C:\\Users\\L2959\\Desktop\\项目\\LLMR\\_shot\\hw4.pdf'

const TEACHER = process.argv[2] || [
  'MATH2201.01 Homework 2 —— 老师在群里发的：',
  '§7.1 八题、§7.2 八题，合计 100 分。',
  '要求：英文题面翻译成中文，解答中英对照，公式要用 Word 里能编辑的公式，交 docx，',
  '文件名 学号_姓名_HW2.docx，周日 24:00 前交。',
  '作业单我下到 ' + PDF,
].join('\n')

let pass = 0
let fail = 0
function ok (name, cond, detail) {
  if (cond) { console.log('✓ ' + name); pass++ } else { console.log('✗ ' + name + (detail ? '\n    ' + detail : '')); fail++ }
}
function eq (name, actual, expected) {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected)
  if (a === e) { console.log('✓ ' + name); pass++ } else { console.log('✗ ' + name + '\n    期望 ' + e + '\n    实际 ' + a); fail++ }
}

// 用户眼里的 7 步  →  声明里的节点
const STAGES = [
  ['1 判断是作业任务', 'judge_task'],
  ['2 从中提取信息', 'extract_info'],
  ['3 与用户确认作业', 'confirm_homework'],
  ['4 自动读取作业 pdf', 'read_pdf'],
  ['5 开始转换', 'translate'],
  ['5 开始转换', 'solve_cn'],
  ['5 开始转换', 'solve_en'],
  ['5 开始转换', 'draw_figures'],
  ['5 开始转换', 'render_docx'],
  ['6 搞好', 'verify_docx'],
  ['7 显示作业于页面上', 'show_result'],
]

const main = async () => {
  console.log('LLMR · 作业 SWF 冒烟  ' + SWF)
  console.log('─'.repeat(64))
  console.log('输入（模拟用户把老师的话贴进来）：')
  console.log(TEACHER.split('\n').map((l) => '  │ ' + l).join('\n'))
  console.log('─'.repeat(64))

  const p = loader.prepare(SWF)
  ok('声明能加载（无 LLMR-E 级问题）', !p.problems, JSON.stringify(p.problems))
  if (p.problems) process.exit(1)

  // ── 结构：入口唯一 ──
  const g = buildGraph(p.swf, p.library)
  eq('入口唯一，就是 judge_task', g.entries, ['judge_task'])
  const confirmNode = p.swf.amz.find((a) => a.id === 'confirm_homework')
  ok('confirm_homework 声明了 ask 信号字段（执行器的暂停约定靠它）',
    confirmNode && confirmNode.output.signal.fields.ask === 'text',
    JSON.stringify(confirmNode && confirmNode.output.signal))

  const args = { req: TEACHER, pdf: PDF, goal: TEACHER }

  // ══════ 第一次运行：应该停在「与用户确认作业」 ══════
  const b1 = echoBackend({ signals: { judge_task: { is_homework: true }, extract_info: { has_task: true } } })
  const r1 = await executeSwf(p.swf, { backend: b1, args, amzLibrary: p.library })

  eq('第一次运行 status = paused', r1.status, 'paused')
  ok('暂停点是 confirm_homework', r1.pause && r1.pause.at === 'confirm_homework', JSON.stringify(r1.pause))
  eq('恢复入口是 read_pdf（确认后接着读 PDF）', r1.pause && r1.pause.next, 'read_pdf')
  ok('确实有个问题要问用户（非空）', r1.pause && typeof r1.pause.question === 'string' && r1.pause.question.trim() !== '',
    JSON.stringify(r1.pause && r1.pause.question))
  eq('前 3 步：判断 → 提取 → 确认', r1.trace.map((s) => s.amz), ['judge_task', 'extract_info', 'confirm_homework'])

  // ══════ 恢复运行：从确认后一路到出成品 ══════
  const ANSWER = '对，就是这份。PDF 路径没问题，按老师要求中英对照 + Word 原生公式。'
  const b2 = echoBackend({
    signals: {
      read_pdf: { problem_count: 6 },
      render_docx: { omml_count: 42 },
      verify_docx: { verified: true },
    },
  })
  const r2 = await executeSwf(p.swf, {
    backend: b2,
    args: Object.assign({}, args, { confirm: ANSWER }), // 服务器把用户答复放进 args.confirm
    amzLibrary: p.library,
    startAt: r1.pause.next,
  })

  ok('恢复运行完成', r2.ok === true && r2.status === 'completed', r2.status + ' / ' + r2.reason)
  eq('恢复后从 read_pdf 开始（不重复前面）', r2.trace[0].amz, 'read_pdf')
  eq('用户的确认答复确实带到了下游', r2.trace[0].input.req.confirm, ANSWER)

  const chain = r1.trace.map((s) => s.amz).concat(r2.trace.map((s) => s.amz))
  eq('全流程节点 = 7 步效果的 11 个节点，顺序一致', chain, STAGES.map((s) => s[1]))
  ok('成品来自 show_result（页面上显示的就是它）', r2.finalOutput === '[text] show_result', String(r2.finalOutput))
  ok('verify（搞好）确实在显示之前', chain.indexOf('verify_docx') === chain.length - 2)

  // ══════ 负路径：不能硬套流程 ══════
  const nb = async (signals, args2, startAt) => executeSwf(p.swf, {
    backend: echoBackend({ signals }), args: args2 || args, amzLibrary: p.library, startAt,
  })

  const r3 = await nb({ judge_task: { is_homework: false } })
  ok('不是作业 → 走 not_homework 收尾，不往下跑',
    r3.status === 'completed' && r3.trace.map((s) => s.amz).join() === 'judge_task,not_homework',
    r3.status + ' ' + r3.trace.map((s) => s.amz).join())

  const r4 = await nb({ judge_task: { is_homework: true }, extract_info: { has_task: false } })
  ok('看得出是作业但抽不出信息 → 也停在 not_homework（不硬凑）',
    r4.trace.map((s) => s.amz).join() === 'judge_task,extract_info,not_homework',
    r4.trace.map((s) => s.amz).join())

  const r5a = await nb({ judge_task: { is_homework: true }, extract_info: { has_task: true } })
  ok('每次运行都会停在「确认」这一步（第 3 步是硬性的）', r5a.status === 'paused', r5a.status)
  const r5 = await nb({ read_pdf: { problem_count: 0 } }, Object.assign({}, args, { confirm: ANSWER }), 'read_pdf')
  ok('PDF 里读不出题目 → 走 needs_input 要材料',
    r5.status === 'completed' && r5.trace[r5.trace.length - 1].amz === 'needs_input',
    r5.trace.map((s) => s.amz).join())

  // ══════ 修复环：公式没变成 OMML 要能回头修一次 ══════
  const r6 = await executeSwf(p.swf, {
    backend: echoBackend({
      signals: { read_pdf: { problem_count: 6 }, render_docx: { omml_count: 0 }, verify_docx: { verified: true } },
    }),
    args: Object.assign({}, args, { confirm: ANSWER }),
    amzLibrary: p.library,
    startAt: 'read_pdf',
  })
  const c6 = r6.trace.map((s) => s.amz)
  ok('公式没转成 Word 原生公式 → 回头修一次再交',
    r6.ok === true && c6.indexOf('fix_formulas') > 0 && c6[c6.length - 1] === 'show_result',
    c6.join(' → '))

  console.log('─'.repeat(64))
  console.log('通过 ' + pass + ' / 失败 ' + fail)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error('崩了：' + (e && e.stack ? e.stack : e)); process.exit(1) })
