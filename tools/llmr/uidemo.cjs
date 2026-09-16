#!/usr/bin/env node
'use strict'
// UI 效果预览：把 webui.html 里**真正的 CSS 和渲染函数**拿去，喂一份样例数据，
// 生成静态 HTML 到 _shot/，再用无头 Edge 渲染成图。
//
// 为什么不在浏览器里点：点出来的东西没法冻住，也就没法反复比对版式。
// 这里不重写任何样式、不复制任何 markup——只在 IIFE 末尾把 boot() 换成一段样例调用，
// 所以看到的就是用户会看到的那一套。
//
// 用法：
//   node tools/llmr/uidemo.cjs          # 生成 _shot/ui-pause.html 与 _shot/ui-result.html
//   （再用 dlt_run edge-headless 渲染成 PNG）

const fs = require('fs')
const path = require('path')

const SRC = path.resolve(__dirname, 'webui.html')
const OUT = path.resolve(__dirname, '..', '..', '_shot')

const A = {
  id: 'demo', name: '作业成品',
  swf: 'C:\\Users\\L2959\\Desktop\\项目\\LLMR\\swfs\\homework.swf.json',
}
// 读**真实声明**，不手写样例——手写的那份缺 amz/order，图画不出来，
// 而且会和真 SWF 越飘越远。
const SWF_FILE = path.resolve(__dirname, '..', '..', 'swfs', 'homework.swf.json')
const loader = require('./loader.cjs')
const { runChecks, surfaceHash } = require('../validator/checks.cjs')

// 视图数据**真算一遍**（加载器 + 校验器），不手写。
// 手写的样例迟早和实现飘开——而且飘了没人知道。
const PREPARED = loader.prepare(SWF_FILE)
const CHECKED = runChecks(PREPARED.swf, {})
const VIEW = { swf: PREPARED.swf }
const DEV_VIEW = {
  swf: PREPARED.swf,
  path: SWF_FILE,
  errors: CHECKED.errors || [],
  warnings: CHECKED.warnings || [],
  surface: CHECKED.surface || [],
  surfaceHash: surfaceHash(CHECKED.surface || []),
}

const CARD = [
  '课程　MATH2201.01 · Homework 2',
  '题目　§7.1 八题 + §7.2 八题（共 16 题，100 分）',
  '要求　英文题面译中、中英对照、Word 原生公式、交 docx',
  '作业单　_shot\\hw4.pdf',
  '',
  '我理解得对吗？路径不对的话，把正确的给我。',
].join('\n')

// 真实跑一遍会得到**两段**轨迹：确认前 3 步 + 恢复后 8 步。这里按拼接后的样子出图。
const TRACE = [
  { amz: 'judge_task', to: 'extract_info', via: 'when' },
  { amz: 'extract_info', to: 'confirm_homework', via: 'when' },
  { amz: 'confirm_homework', to: 'read_pdf', via: 'pause' },
]

const RESULT = [
  'MATH2201.01 · Homework 2',
  '',
  '## §7.1 Trigonometric Integrals',
  '',
  '**1.**  Evaluate  ∫ sin³x cos²x dx',
  '中文：求不定积分 ∫ sin³x cos²x dx。',
  '解：令 u = cos x，则 ∫ sin³x cos²x dx = −∫(1−u²)u² du = u⁵/5 − u³/3 + C = cos⁵x/5 − cos³x/3 + C。',
  '',
  '**2.**  Evaluate  ∫₀^{π/2} sin²x dx',
  '中文：求定积分 ∫₀^{π/2} sin²x dx。',
  '解：由 sin²x = (1 − cos 2x)/2，得 ∫₀^{π/2} sin²x dx = π/4。',
  '',
  '（§7.1 其余 6 题、§7.2 全部 8 题同此格式）',
  '',
  '## 交付物',
  'C:\\Users\\L2959\\Desktop\\MATH2201.01_HW2.docx',
].join('\n')

const RESULT_TRACE = [
  'read_pdf', 'translate', 'solve_cn', 'solve_en', 'draw_figures',
  'render_docx', 'verify_docx', 'show_result',
].map((amz, i, arr) => ({ amz, to: arr[i + 1] || null, via: i === arr.length - 1 ? null : 'when' }))

const GOAL = 'MATH2201.01 Homework 2，§7.1 八题、§7.2 八题，合计 100 分，要中英对照和 Word 原生公式，交 docx'

function bootstrap (call, opts) {
  const o = opts || {}
  const lines = [
    "  // ── 样例（uidemo.cjs 注入，只存在于生成出来的静态页里）──",
    // 门面图用 http 后端跑一遍：这样「仅 echo 干跑用」的样例输出框不会出现在图里，
    // 截出来的就是**配好 Key 之后**用户看到的那一屏。
    '  S.mode = ' + JSON.stringify(o.dev ? 'dev' : 'user') +
      '; S.settings = { backend: ' + JSON.stringify(o.backend || 'echo') + ' }',
    '  S.agts = []; S.agts.push(' + JSON.stringify(A) + ')',
  ]
  if (o.dev) {
    // 开发者视图：侧栏是 SWF 列表，主区是校验 + 调用图 + AMZ 表 + 能力表面
    // ⚠ 路径要**字面量**注进去。写成裸的 SWF_FILE 是 Node 侧的常量，
    //   浏览器里没有这个名字，整段 bootstrap 会 ReferenceError → 白屏。
    const p = JSON.stringify(SWF_FILE)
    lines.push('  S.list = { swfs: [{ name: "homework.swf.json", path: ' + p + ' }], amz: [] }')
    lines.push('  S.swfPath = ' + p + '; S.view = ' + JSON.stringify(DEV_VIEW))
  } else {
    lines.push('  S.agt = ' + JSON.stringify(A) + '; S.view = ' + JSON.stringify(VIEW))
  }
  lines.push('  paint()')
  // 首屏那张要**摊开**的表单：README 的门面图得让人看清"你要给它什么"
  if (o.fold) {
    lines.push('  foldCard(' + JSON.stringify({ goal: GOAL, pdf: path.join(OUT, 'hw4.pdf') }) + ')')
  }
  if (call) lines.push(call)
  lines.push('  finishGraphAnimation()')
  return lines.join('\n')
}

const cases = {
  // 首屏：AGT 打开、表单还摊着的样子（README 的门面图）
  'ui-home.html': bootstrap('', { backend: 'http' }),
  // 开发者视图：校验 + 调用图 + AMZ 表 + 能力表面（DEV_VIEW 是真跑校验器算出来的）
  'ui-dev.html': bootstrap('', { dev: true }),
  'ui-pause.html': bootstrap(
    '  paintPause(' + JSON.stringify({
      finalOutput: CARD,
      pause: { at: 'confirm_homework', question: '（echo 后端：这一句本来是你真正要问用户的话）', next: 'read_pdf' },
      trace: TRACE, steps: 3,
    }) + ')', { fold: true }),
  'ui-result.html': bootstrap(
    '  paintResult(' + JSON.stringify({
      ok: true, status: 'completed', steps: 8, finalOutput: RESULT, trace: TRACE.concat(RESULT_TRACE),
    }) + ')', { fold: true }),
}

const src = fs.readFileSync(SRC, 'utf8')
if (!src.includes('  boot()\n})()')) {
  console.error('找不到 IIFE 末尾的 boot() —— webui.html 结构变了，uidemo.cjs 要跟着改。')
  process.exit(1)
}

fs.mkdirSync(OUT, { recursive: true })
for (const [file, code] of Object.entries(cases)) {
  const out = src.replace('  boot()\n})()', code + '\n})()')
  const p = path.join(OUT, file)
  fs.writeFileSync(p, out, 'utf8')
  console.log('写出 ' + p)
}
