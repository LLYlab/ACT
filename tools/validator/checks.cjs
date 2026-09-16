'use strict'
// LLMR 语义校验：LLMR-校验器规格.md §3 的 17 项检查
const crypto = require('node:crypto')
const expr = require('../llmr/expression.cjs')

// ── 工具类别表（LLMR-校验器规格.md §3 #1）────────────────────────────────
const TOOL_CLASSES = {
  exec: ['pwsh', 'bash', 'run_code', 'cmd', 'dlt_run', 'dlt_build'],
  'fs-write': ['write', 'edit', 'dlt_doc_write'],
  artifact: ['docx_write', 'xlsx_write', 'pptx_write', 'pdf_write'],
  net: ['web_search', 'web_fetch'],
  read: ['read', 'read_image', 'glob', 'grep', 'dlt_doc_read', 'dlt_env'],
}
const CLASS_OF = {}
for (const [cls, names] of Object.entries(TOOL_CLASSES)) for (const n of names) CLASS_OF[n] = cls
const classifyTool = (n) => CLASS_OF[n] || 'unknown'

const DETERMINISTIC = ['artifact', 'run', 'args']
const SIGNAL = ['signal']
const ALL_NS = [...DETERMINISTIC, ...SIGNAL]

// 声明的 signal 类型 → 字面量类型
const LIT_OF = { number: 'int', string: 'text', bool: 'bool', array: 'refs' }

// ── 输入归一 + $ref 解析（共享自阶段 1 加载器）──────────────────────────
// runChecks 是导出的库函数，会被「阶段 1 加载器」「编辑器」直接调用，
// 不保证经过 CLI 的 schema 前置门。它应当**总是返回报告**，而不是抛 TypeError。
// 归一与 $ref 解析只保留一份实现（loader），避免两处各写一份而悄悄漂移。
const { asArray, asObject, resolveAmz } = require('../llmr/loader.cjs')

// ── 能力表面 + 哈希（§5）────────────────────────────────────────────────
function buildSurface (amzs) {
  return amzs
    .map((a) => ({
      amz: a.id,
      tools: [...asArray(a.amz.tools)].sort(),
      guards: asArray(a.amz.guards).map((g) => asObject(g).when).sort(),
    }))
    .sort((x, y) => (x.amz < y.amz ? -1 : x.amz > y.amz ? 1 : 0))
}

function canonicalize (v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']'
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}'
  }
  return JSON.stringify(v)
}

function surfaceHash (surface) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(surface)).digest('hex')
}

// ── 主入口 ───────────────────────────────────────────────────────────────
function runChecks (input, opts = {}) {
  const swf = asObject(input)
  const mode = opts.mode || 'author'
  const library = asObject(opts.amzLibrary)
  const toolRegistry = opts.toolRegistry || null
  const uiPages = opts.uiPages || null

  const errors = []
  const warnings = []
  const E = (code, path, message, hint) => errors.push({ code, path, message, hint })
  const W = (code, path, message, hint) => warnings.push({ code, path, message, hint })

  // ── 解析 AMZ 列表（$ref 解析共享自加载器）──
  const { amzs, problems: refProblems } = resolveAmz(swf.amz, library)
  for (const p of refProblems) E(p.code, p.path, p.message, p.hint)

  const byId = new Map()
  for (const a of amzs) {
    if (byId.has(a.id)) E('LLMR-E110', `${a.path}/id`, `AMZ id 重复：${a.id}`)
    else byId.set(a.id, a)
  }

  const terminal = asArray(swf.terminal)
  for (const t of terminal) if (!byId.has(t)) E('LLMR-E105', '/swf/terminal', `terminal 里的 AMZ 不存在：${t}`)

  // ── 解析边 ──
  const edges = asArray(swf.order).map((e, i) => ({ ...asObject(e), path: `/swf/order/${i}` }))
  for (const e of edges) {
    if (!byId.has(e.from)) E('LLMR-E105', `${e.path}/from`, `边引用的 AMZ 不存在：${e.from}`)
    if (!byId.has(e.to)) E('LLMR-E105', `${e.path}/to`, `边引用的 AMZ 不存在：${e.to}`)
    if (e.else !== undefined && !byId.has(e.else)) E('LLMR-E105', `${e.path}/else`, `else 引用的 AMZ 不存在：${e.else}`)
    try {
      e._ast = expr.parse(e.when)
    } catch (err) {
      E('LLMR-E103', `${e.path}/when`, `when 文法非法：${err.message}`)
    }
  }

  // ── #2 分支边组必须有 else ──
  const groups = new Map()
  for (const e of edges) {
    if (!groups.has(e.from)) groups.set(e.from, [])
    groups.get(e.from).push(e)
  }
  for (const [from, g] of groups) {
    const elseCount = g.filter((e) => e.else !== undefined).length
    if (g.length > 1 && elseCount === 0) {
      E('LLMR-E101', '/swf/order', `节点 ${from} 有多条出边但没有 else 兜底`, '求值失败时无处可去；补一条 else')
    }
    if (elseCount > 1) {
      E('LLMR-E102', '/swf/order', `节点 ${from} 有 ${elseCount} 条 else，兜底歧义`)
    }
  }

  // ── #4 / #15 level 与命名空间 ──
  // 注：原规格里 #4 与 #15 会同时命中同一条边（level>=2 但只用确定性变量），
  // 产生「既是错误又是建议」的矛盾。此处按修复动作归一：纯确定性 → 只报 W202（修法=改 level），
  // 只有「混用 signal 与其它命名空间」才报 E104。
  for (const e of edges) {
    if (!e._ast) continue
    const ns = expr.namespacesOf(e._ast)
    for (const bad of expr.badIdentsOf(e._ast, ALL_NS)) {
      E('LLMR-E104', `${e.path}/when`, `变量名非法：${bad}`, `合法命名空间：${ALL_NS.join(' / ')}`)
    }
    const lvl = e.level
    if (lvl === 1) {
      const off = [...ns].filter((n) => !DETERMINISTIC.includes(n))
      if (off.length) E('LLMR-E104', `${e.path}/level`, `level:1 不允许使用 ${off.join(', ')}`, '级 1 只能用 artifact. / run. / args.')
    } else if ([2, 3, 4].includes(lvl)) {
      const onlyDet = ns.size > 0 && [...ns].every((n) => DETERMINISTIC.includes(n))
      if (onlyDet) {
        W('LLMR-W202', `${e.path}/level`, `level:${lvl} 只用到确定性变量，应降为 level:1`, '级 1 零成本，无需模型参与')
      } else {
        const off = [...ns].filter((n) => !SIGNAL.includes(n))
        if (off.length) E('LLMR-E104', `${e.path}/level`, `level:${lvl} 不允许使用 ${off.join(', ')}`, '级 2-4 只能用 signal.')
      }
    }
  }

  // ── #6 signal 字段一致 + 类型 ──
  for (const e of edges) {
    if (!e._ast) continue
    const up = byId.get(e.from)
    if (!up) continue
    const declared = (up.amz.output && up.amz.output.signal && up.amz.output.signal.fields) || null
    for (const f of expr.signalFieldsOf(e._ast)) {
      if (!declared || !(f in declared)) {
        E('LLMR-E106', `${e.path}/when`, `signal.${f} 未由 ${e.from} 的 output.signal.fields 声明`, '在上游 AMZ 里声明该字段')
        continue
      }
      const want = declared[f]
      for (const a of expr.atomsOf(e._ast)) {
        if (a.ident !== `signal.${f}`) continue
        if (a.op === null) {
          if (want !== 'bool') E('LLMR-E106', `${e.path}/when`, `signal.${f} 声明为 ${want}，不能单独作为条件（只有 bool 可以）`, `写成 signal.${f} == <值>`)
          continue
        }
        const got = LIT_OF[a.literal.type]
        if (a.op === '>' || a.op === '<') {
          if (want !== 'int') E('LLMR-E106', `${e.path}/when`, `signal.${f} 声明为 ${want}，不能用 > / < 比较`)
        } else if (want !== got) {
          E('LLMR-E106', `${e.path}/when`, `signal.${f} 声明为 ${want}，字面量是 ${got}`)
        }
      }
    }
  }

  // ── #13 有分支出边必须有 output.signal ──
  for (const e of edges) {
    if (![2, 3, 4].includes(e.level)) continue
    const up = byId.get(e.from)
    if (up && !(up.amz.output && up.amz.output.signal)) {
      E('LLMR-E111', `${up.path}/output`, `${e.from} 有 level:${e.level} 的出边，但没有 output.signal`)
    }
  }

  // ── #7 入口唯一 + #8 终态 ──
  const froms = new Set(edges.map((e) => e.from))
  const targets = new Set()
  for (const e of edges) { targets.add(e.to); if (e.else !== undefined) targets.add(e.else) }
  const candidates = [...froms].filter((n) => !targets.has(n))
  if (candidates.length !== 1) {
    E('LLMR-E107', '/swf/order', `入口不唯一：${candidates.length} 个${candidates.length ? '（' + candidates.join(', ') + '）' : ''}`, '应有且仅有一个从未作为目标出现的节点')
  }
  const entry = candidates[0]

  const adj = new Map()
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e.to)
    if (e.else !== undefined) adj.get(e.from).push(e.else)
  }
  const reach = new Set()
  if (entry) {
    const q = [entry]
    while (q.length) {
      const n = q.shift()
      if (reach.has(n)) continue
      reach.add(n)
      for (const m of adj.get(n) || []) q.push(m)
    }
  }
  for (const a of amzs) {
    if (entry && !reach.has(a.id)) W('LLMR-W203', a.path, `不可达：${a.id}`, '从入口出发无法到达')
    const hasOut = (adj.get(a.id) || []).length > 0
    const isTerm = terminal.includes(a.id)
    if (!hasOut && !isTerm) E('LLMR-E108', a.path, `${a.id} 无出边且不在 terminal 中`)
    if (hasOut && isTerm) W('LLMR-W204', a.path, `${a.id} 在 terminal 中但有出边`)
  }

  // ── #17 环检测 ──
  // 执行器本来就有 max-steps 兜底，但那是**运行期**才发现，代价是烧掉一整条轨迹。
  // 环是纯静态就能算出来的事：图里有环 = 这不再是「固定工作流」，是一个死循环。
  // 只查**从入口可达**的节点——不可达部分的环跑不到（且已被 W203 标出）。
  //
  // ⚠ 用显式栈，不用递归。
  // 节点数由文档决定，恶意/超大文档能把递归 DFS 直接压爆（这个项目已经因为
  // 「畸形输入压爆调用栈」吃过一次亏，见 LLMR-校验器规格 §4.1.1 的解析上限）。
  //
  // 起点集合：**不管入口唯不唯一都要查**。
  // 环只要含入口，就必然让入口不再唯一（入口同时是别人的目标），E107 会先响——
  // 那时如果就此收手，用户看到的是「入口不唯一」这个**症状**，而不是「图里有环」这个**病因**。
  // 有唯一入口时只看可达部分（不可达的环跑不到，W203 已经标了）；没有入口时全图都看。
  const scanFrom = entry ? [...reach] : amzs.map((a) => a.id)
  if (scanFrom.length) {
    const WHITE = 0; const GRAY = 1; const BLACK = 2
    const color = new Map()
    const seen = new Set()
    const cycles = []

    // 同一个环会被不同起点/不同方向重复发现；归一化（最小 id 打头）后再去重
    const normCycle = (cyc) => {
      let at = 0
      for (let i = 1; i < cyc.length; i++) if (cyc[i] < cyc[at]) at = i
      return cyc.slice(at).concat(cyc.slice(0, at)).join('>')
    }

    for (const start of scanFrom) {
      if ((color.get(start) || WHITE) !== WHITE) continue
      const stack = [start]
      const path = []
      const cursor = new Map()
      while (stack.length) {
        const n = stack[stack.length - 1]
        if (!cursor.has(n)) { cursor.set(n, 0); color.set(n, GRAY); path.push(n) }
        const outs = adj.get(n) || []
        const i = cursor.get(n)
        if (i >= outs.length) {
          color.set(n, BLACK); path.pop(); stack.pop(); continue
        }
        cursor.set(n, i + 1)
        const m = outs[i]
        const c = color.get(m) || WHITE
        if (c === GRAY) {
          const cyc = path.slice(path.indexOf(m))
          const key = normCycle(cyc)
          if (!seen.has(key)) { seen.add(key); cycles.push(cyc) }
        } else if (c === WHITE) {
          stack.push(m)
        }
      }
    }

    for (const cyc of cycles.slice(0, 5)) {
      E('LLMR-E113', '/swf/order', `存在环：${cyc.join(' → ')} → ${cyc[0]}`,
        'SWF 必须是有尽头的流程；环到运行期只会以「超过最大步数」的形式暴露')
    }
    if (cycles.length > 5) {
      E('LLMR-E113', '/swf/order', `还有 ${cycles.length - 5} 个环未列出`, '先修上面几个，再重新校验')
    }
  }

  // ── #1 工具面安全 ──
  for (const a of amzs) {
    const tools = asArray(a.amz.tools)
    const classes = new Set(tools.map(classifyTool))
    const execs = tools.filter((t) => classifyTool(t) === 'exec')
    if (classes.has('exec')) {
      W('LLMR-W201', `${a.path}/tools`, `${a.id} 含 exec 类工具（${execs.join(', ')}）`, '会话 sandbox 不是 per-AMZ 的，该 AMZ 继承的是整个会话的 sandbox 模式')
    }
    if (classes.has('exec') && classes.has('artifact')) {
      W('LLMR-W206', `${a.path}/tools`, `${a.id} 同时含 exec 与 artifact 类工具`, 'CSP 保证被削弱：TWF 不提权，但一句被改过的 prompt 就能让它用 exec 做设计者没打算的事')
    }
    if (toolRegistry) {
      for (const t of tools) if (!toolRegistry.has(t)) E('LLMR-E105', `${a.path}/tools`, `工具不存在：${t}`, '当前 DSH 的工具表里没有这个名字')
    }
  }

  // ── #10 step 提示 ──
  const steps = amzs.filter((a) => asObject(a.amz).kind === 'step')
  if (steps.length) {
    W('LLMR-W205', '/swf/amz', `存在 ${steps.length} 个 step 型 AMZ`, 'step 注入 TCP/SCP 会让请求从第 0 位分叉，继承来的历史吃不到前缀缓存。它的价值是信息保真，不是省钱。')
  }

  // ── #16 引用项必须自带 model ──
  // 理由：$ref 引入的 AMZ 是**共享资产**，被多个 SWF 复用。
  // SWF 的 `defaults` 刻意不作用于引用项（否则同一个库 AMZ 会随引用它的 SWF 改变模型），
  // 于是它若自身没声明 model，就会**静默回退到部署默认模型**——
  // 而设计者多半以为 SWF 的 defaults 管住了它。
  for (const a of amzs) {
    if (a.fromRef && asObject(a.amz).model === undefined) {
      W('LLMR-W207', `${a.path}/$ref`, `$ref 引入的 ${a.id} 未声明 model`, 'SWF 的 defaults 不作用于引用项，它会回退到部署默认模型。请在库中的该 AMZ 上声明 model，或就地内联')
    }
  }

  // ── #5 UI 页面组 ──
  const ui = asObject(swf.ui)
  if (uiPages && Array.isArray(ui.page)) {
    for (const p of ui.page) if (!uiPages.has(p)) E('LLMR-E105', '/swf/ui/page', `页面组不存在：${p}`)
  }

  // ── 能力表面 ──
  const surface = buildSurface(amzs)
  const hash = surfaceHash(surface)

  // ── #9 导入复核 ──
  if (mode === 'import') {
    const rev = swf._review
    if (!rev || !rev.surfaceHash) {
      E('LLMR-E109', '/swf/_review', '导入的 SWF 未经人工复核（缺 _review.surfaceHash）', '审查能力表面后写入 _review')
    } else if (rev.surfaceHash !== hash) {
      E('LLMR-E109', '/swf/_review/surfaceHash', '能力表面哈希不符：导出后被改动过', `当前 ${hash}，凭据 ${rev.surfaceHash}`)
    }
  }

  // ── #14 导出不得残留 $ref ──
  if (mode === 'export') {
    asArray(swf.amz).forEach((e, i) => {
      if (e && typeof e === 'object' && '$ref' in e) E('LLMR-E112', `/swf/amz/${i}`, '导出产物仍含未解析的 $ref')
    })
  }

  return { errors, warnings, surface, surfaceHash: hash, entry, graph: { nodes: [...byId.keys()], edges: edges.map((e) => ({ from: e.from, to: e.to, else: e.else })) } }
}

/**
 * 检查清单 —— **唯一的机器可读权威**。
 *
 * 为什么要单独列一份：文档里到处写「16 项」「15 项」，而每加一条检查这些数字都要人肉去改，
 * 结果实测写着三种不同的数字（15 / 16 / 17 混在 9 份文档里）。
 * 码空间能被 `auditcodes.cjs` 对齐，是因为它**在代码里有一份真值**；
 * 「有几项检查」也该一样。
 *
 * 所以：项数从这里来，文档只能与它一致。加检查 = 在这里加一行 + 在规格表里加一行。
 */
const CHECKS = [
  { n: 1, codes: ['LLMR-W201', 'LLMR-W206'], title: '工具面安全' },
  { n: 2, codes: ['LLMR-E101', 'LLMR-E102'], title: '分支边组必须有 else' },
  { n: 3, codes: ['LLMR-E103'], title: 'when 文法合法且标明 level' },
  { n: 4, codes: ['LLMR-W202'], title: 'level>=2 但只用确定性变量' },
  { n: 5, codes: ['LLMR-E105'], title: '引用存在性' },
  { n: 6, codes: ['LLMR-E106'], title: 'signal 字段一致与类型' },
  { n: 7, codes: ['LLMR-E107', 'LLMR-W203'], title: '入口唯一与可达性' },
  { n: 8, codes: ['LLMR-E108', 'LLMR-W204'], title: '终态一致性' },
  { n: 9, codes: ['LLMR-E109'], title: '导入复核' },
  { n: 10, codes: ['LLMR-W205'], title: 'step 的缓存提示' },
  { n: 11, codes: [], title: 'CSP_AMZ 越权（由 schema 覆盖）' },
  { n: 12, codes: ['LLMR-E110'], title: 'AMZ id 冲突' },
  { n: 13, codes: ['LLMR-E111'], title: '有分支出边但无 output.signal' },
  { n: 14, codes: ['LLMR-E112'], title: '导出不得残留 $ref' },
  { n: 15, codes: ['LLMR-E104'], title: 'level 与命名空间不匹配' },
  { n: 16, codes: ['LLMR-W207'], title: '引用项必须自带 model' },
  { n: 17, codes: ['LLMR-E113'], title: '环检测' },
]

module.exports = { runChecks, buildSurface, surfaceHash, canonicalize, classifyTool, TOOL_CLASSES, CHECKS }
