#!/usr/bin/env node
'use strict'
// LLM R WebUI —— LLM R 自己的前端，**不依赖 DSH**。
//
// LLM R 的前端与后端都能独立运行：
//   后端 = validator / loader / executor / backends（纯 Node）
//   前端 = 本文件提供的页面 + JSON 接口
// DSH 插件只是「接入方式之一」，不是必需。
//
// 用法：node server.cjs [--port=8735] [--dir=…/verify] [--root=…/LLMR]
//
// 安全：只绑 127.0.0.1；只允许访问 --root 之下的路径；
//       默认后端是 echo（不产生任何模型花费）。真模型走 http 后端，凭据在「设置 → 模型 API」里配。
//       配了 Key 才算同意真实调用；调哪个模型由 SWF 的每个 AMZ 自己声明。

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const loader = require('./loader.cjs')
const { listOf, viewOf, indexOf, matchOf } = require('./view.cjs')
const { executeSwf, selectScreen } = require('./executor.cjs')
const { echoBackend, httpBackend } = require('./backends.cjs')
const { makeStore } = require('./store.cjs')

function parseArgs (argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const HERE = path.join(__dirname, '..', '..')
const ROOT = path.resolve(args.root || HERE)
const DIR = path.resolve(args.dir || path.join(ROOT, 'verify'))
const PORT = Number(args.port) || 8735
const PAGE = path.join(__dirname, 'webui.html')
const store = makeStore(ROOT)

/** 当前生效的 SWF 目录：查询参数优先，其次设置里的 dir，最后默认 */
function currentDir (u) {
  const q = safePath(u.searchParams.get('dir'))
  if (q) return q
  const s = safePath(store.getSettings().dir)
  return s || DIR
}

function readBody (req) {
  return new Promise((resolve) => {
    // ⚠ 必须先收字节、最后一次性解码。
    // 直接 `s += chunk` 会在每个 chunk 上各自 toString()——
    // 一个多字节字符若跨 chunk 边界就会被截断成乱码。
    const chunks = []
    let n = 0
    req.on('data', (c) => { chunks.push(c); n += c.length; if (n > 2e6) req.destroy() })
    req.on('end', () => {
      try {
        let s = Buffer.concat(chunks).toString('utf8')
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1) // BOM
        resolve(JSON.parse(s || '{}'))
      } catch (_) { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function json (res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function safePath (p) {
  // ⚠ 必须先挡掉空值：path.resolve('') 会返回 **cwd**（而不是报错），
  // 于是「越界检查」反而放行了一个凭空来的有效路径，把 `|| DIR` 兜底也顶掉了。
  if (typeof p !== 'string' || p === '') return null
  const full = path.resolve(p)
  return full.startsWith(ROOT) ? full : null
}

/**
 * 解析到 base 之下。所有 SWF 自带的界面资产、以及它的文件工作区，
 * 都**只能**落在这张 SWF 自己的目录里——边界是设计期那张表，不是运行期的心情。
 */
function safeUnder (base, rel) {
  if (typeof rel !== 'string') return null
  const b = path.resolve(base)
  const full = path.resolve(b, rel)
  if (full !== b && !full.startsWith(b + path.sep)) return null
  return full
}

/** 把引导层与主题令牌注入 SWF 自己的 HTML。注入点：<head> 之后；没有 head 就放最前 */
const BOOT_TAGS = [
  '<link rel="stylesheet" href="/__llmr/ui.css">',
  '<script src="/__llmr/uiboot.js"></script>',
  '',
].join('\n')
function injectBoot (html) {
  const m = /<head[^>]*>/i.exec(html)
  if (m) {
    const at = m.index + m[0].length
    return html.slice(0, at) + '\n' + BOOT_TAGS + html.slice(at)
  }
  return BOOT_TAGS + html
}

/**
 * 按**声明里的 swf.id** 找到这张 SWF 的工作区目录。
 * 快路径：同名目录直接命中（id 与目录同名时最省事）。
 * 否则扫 *.swf.json 比对 id —— 文件名带连字符、id 只能下划线，两者不必同名。
 */
function resolveSwfDir (dir, id) {
  const direct = path.join(dir, id)
  try {
    if (fs.statSync(direct).isDirectory()) return direct
  } catch (_) { /* 没有同名目录，往下扫 */ }
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return null }
  for (const e of entries) {
    if (!e.isFile() || !/\.swf\.json$/i.test(e.name)) continue
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8'))
      if (doc && doc.swf && doc.swf.id === id) {
        return path.join(dir, e.name.replace(/\.swf\.json$/i, ''))
      }
    } catch (_) { /* 坏文件跳过，不该让一张坏 SWF 挡住别人 */ }
  }
  return null
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
}

function trim (v, n) {
  if (v === undefined || v === null) return v
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > n ? s.slice(0, n) + '…' : s
}

const server = http.createServer(async (req, res) => {
  let u
  try { u = new URL(req.url, 'http://127.0.0.1') } catch (_) { res.writeHead(400); res.end(); return }

  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      if (!fs.existsSync(PAGE)) { res.writeHead(500); res.end('webui.html 缺失'); return }
      const html = fs.readFileSync(PAGE, 'utf8')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
      return
    }

    // ── 宿主自带的引导层与令牌（给 SWF 的界面用）──
    if (u.pathname === '/__llmr/uiboot.js' || u.pathname === '/__llmr/ui.css') {
      const f = path.join(__dirname, u.pathname === '/__llmr/uiboot.js' ? 'uiboot.js' : 'ui.css')
      if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return }
      res.writeHead(200, {
        'content-type': u.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(fs.readFileSync(f))
      return
    }

    // ── SWF 自带的界面：/ui/<swf-id>/<路径> ──
    // 由宿主托管（不是 file://），所以能注入引导；范围锁在这张 SWF 的目录里。
    if (u.pathname.startsWith('/ui/')) {
      const rest = decodeURIComponent(u.pathname.slice(4))
      const cut = rest.indexOf('/')
      if (cut <= 0) { res.writeHead(404); res.end('缺少 swf id'); return }
      const swfId = rest.slice(0, cut)
      if (!/^[a-z][a-z0-9_]*$/.test(swfId)) { res.writeHead(400); res.end('swf id 非法'); return }
      const base = resolveSwfDir(currentDir(u), swfId)
      if (!base) { res.writeHead(404); res.end('没有这张 SWF 的工作区目录：' + swfId); return }
      const full = safeUnder(base, rest.slice(cut + 1) || 'index.html')
      if (!full) { res.writeHead(403); res.end('越界'); return }
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); res.end('没有这个文件'); return }
      const ext = path.extname(full).toLowerCase()
      if (ext === '.html' || ext === '.htm') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        res.end(injectBoot(fs.readFileSync(full, 'utf8')))
        return
      }
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(fs.readFileSync(full))
      return
    }

    // ── SWF 的文件工作区：范围 = 它自己的目录 ──
    if (u.pathname === '/api/fs') {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 POST' }); return }
      const body = (await readBody(req)) || {}
      const swfId = String(body.swf || '')
      if (!/^[a-z][a-z0-9_]*$/.test(swfId)) { json(res, 400, { ok: false, error: 'swf id 非法' }); return }
      const base = resolveSwfDir(currentDir(u), swfId)
      if (!base) { json(res, 404, { ok: false, error: '没有这张 SWF 的工作区目录：' + swfId }); return }
      const full = safeUnder(base, String(body.path || ''))
      if (!full) { json(res, 403, { ok: false, error: '路径越界——只能读写这张 SWF 自己的工作区' }); return }
      try {
        if (body.op === 'read') {
          json(res, 200, { ok: true, text: fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null })
        } else if (body.op === 'write') {
          fs.mkdirSync(path.dirname(full), { recursive: true })
          fs.writeFileSync(full, String(body.text === undefined ? '' : body.text), 'utf8')
          json(res, 200, { ok: true, bytes: Buffer.byteLength(String(body.text || ''), 'utf8') })
        } else if (body.op === 'list') {
          if (!fs.existsSync(full)) { json(res, 200, { ok: true, entries: [] }); return }
          const entries = fs.readdirSync(full, { withFileTypes: true })
            .map((e) => ({ name: e.name, dir: e.isDirectory() }))
            .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : (a.dir ? -1 : 1)))
          json(res, 200, { ok: true, entries })
        } else {
          json(res, 400, { ok: false, error: '未知 op：' + body.op })
        }
      } catch (e) {
        json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
      }
      return
    }

    // ── 掷骰 ──
    // 宿主掷、宿主记。**掷骰必须进轨迹**，否则跑团不可复现。
    if (u.pathname === '/api/dice') {
      if (req.method !== 'POST') { json(res, 405, { ok: false, error: '只接受 POST' }); return }
      const body = (await readBody(req)) || {}
      const n = Math.max(1, Math.min(100, Number(body.n) || 1))
      const faces = Math.max(2, Math.min(1000, Number(body.faces) || 20))
      const rolls = []
      for (let i = 0; i < n; i++) rolls.push(1 + Math.floor(Math.random() * faces))
      json(res, 200, { ok: true, faces, rolls, total: rolls.reduce((a, b) => a + b, 0) })
      return
    }

    if (u.pathname === '/api/list') {
      json(res, 200, listOf(currentDir(u)))
      return
    }

    // ── 索引与匹配（新建 AGT / 将来的 DIR 用）──
    if (u.pathname === '/api/index') {
      json(res, 200, { ok: true, items: indexOf(currentDir(u)) })
      return
    }
    if (u.pathname === '/api/match') {
      json(res, 200, Object.assign({ ok: true }, matchOf(currentDir(u), u.searchParams.get('q') || '')))
      return
    }

    // ── AGT 实例 ──
    if (u.pathname === '/api/agts') {
      if (req.method === 'GET') { json(res, 200, { ok: true, agts: store.listAgts() }); return }
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (!body || !body.name || !body.swf) { json(res, 400, { ok: false, error: 'name 与 swf 必填' }); return }
        json(res, 200, { ok: true, agt: store.addAgt(body) })
        return
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req)
        const id = u.searchParams.get('id') || (body && body.id) || ''
        const next = store.updateAgt(id, body || {})
        json(res, next ? 200 : 404, next ? { ok: true, agt: next } : { ok: false, error: '没有这个 AGT' })
        return
      }
      if (req.method === 'DELETE') {
        json(res, 200, { ok: store.removeAgt(u.searchParams.get('id') || '') })
        return
      }
    }

    // ── 设置（**永不回传完整 API Key**）──
    if (u.pathname === '/api/settings') {
      if (req.method === 'GET') { json(res, 200, { ok: true, settings: store.publicSettings() }); return }
      if (req.method === 'POST') {
        json(res, 200, { ok: true, settings: store.saveSettings(await readBody(req)) })
        return
      }
    }

    if (u.pathname === '/api/view') {
      const full = safePath(u.searchParams.get('path'))
      if (!full) { json(res, 403, { ok: false, error: '路径越界' }); return }
      const dir = currentDir(u)
      const v = viewOf(full, { libraryDir: path.join(dir, 'lib') })
      // 还没跑过 → 空环境求值必然全不命中 → 落到"没写 when"的那张兜底页（就是入口页）
      try { v.screen = selectScreen(v.swf, { args: {}, signal: {}, run: {}, event: {} }) } catch (_) { v.screen = null }
      json(res, 200, v)
      return
    }

    if (u.pathname === '/api/run') {
      const full = safePath(u.searchParams.get('path'))
      if (!full) { json(res, 403, { ok: false, error: '路径越界' }); return }
      const dir = currentDir(u)
      const prepared = loader.prepare(full, { libraryDir: path.join(dir, 'lib') })
      if (prepared.problems) {
        json(res, 200, { ok: false, status: 'error', reason: '加载失败', problems: prepared.problems, trace: [] })
        return
      }

      // ⚠ 顺序要紧：signals / args 必须在构造 backend 之前解析出来——
      // echoBackend 要用 signals，而 `let` 的 TDZ 会让提前引用直接抛错。
      let signals = {}
      const sg = u.searchParams.get('signals')
      if (sg) { try { signals = JSON.parse(sg) } catch (_) { /* 忽略坏 JSON */ } }
      // outputs：只在 echo 后端下生效，用来喂一段像样的正文看 UI 效果
      let outputs = {}
      const op = u.searchParams.get('outputs')
      if (op) { try { outputs = JSON.parse(op) } catch (_) { /* 忽略坏 JSON */ } }
      let entryArgs = {}
      const aj = u.searchParams.get('args')
      if (aj) { try { entryArgs = JSON.parse(aj) } catch (_) { /* 忽略坏 JSON */ } }

      const st = store.getSettings()
      const backendName = String(u.searchParams.get('backend') || st.backend || 'echo')
      let backend
      if (backendName === 'echo') {
        backend = echoBackend({ signals, outputs })
      } else if (backendName === 'http') {
        // 凭据来自设置（或环境变量兜底）。**配了 key 才算同意真实调用。**
        const apiKey = (st.model && st.model.apiKey) || process.env.DEEPSEEK_API_KEY
        if (!apiKey) {
          json(res, 403, { ok: false, error: '未配置模型 API Key —— 去「设置 → 模型 API」填，或设环境变量 DEEPSEEK_API_KEY' })
          return
        }
        backend = httpBackend({ apiKey, baseUrl: (st.model && st.model.baseUrl) || undefined })
      } else {
        json(res, 400, { ok: false, error: '未知后端：' + backendName })
        return
      }

      // 暂停恢复：startAt 指定从哪个节点接着走；confirm 是用户对上一个问题的答复
      // 外部动作：环控区监听器（event.）靠它触发
      let events = {}
      const evq = u.searchParams.get('events')
      if (evq) { try { events = JSON.parse(evq) } catch (_) { /* 忽略坏 JSON */ } }

      const startAt = u.searchParams.get('startAt') || undefined
      const confirm = u.searchParams.get('confirm')
      if (confirm !== null && confirm !== undefined) entryArgs.confirm = confirm

      const r = await executeSwf(prepared.swf, {
        backend,
        args: entryArgs,
        amzLibrary: prepared.library,
        startAt,
        events,
      })

      // 当前该显示哪张页：用**最后一步的环境**算，和边选 to/else 同一套规则
      let screen = null
      try {
        const env = (r.last && r.last.env) || { args: entryArgs, signal: {}, run: { status: r.status }, event: {} }
        screen = selectScreen(prepared.swf, env)
      } catch (_) { screen = null }

      json(res, 200, {
        screen,
        ok: r.ok,
        status: r.status,
        reason: r.reason || null,
        paused: r.status === 'paused',
        pause: r.pause || null,
        startAt: startAt || null,
        steps: r.trace.length,
        finalOutput: trim(r.finalOutput, 20000),
        trace: r.trace.map((s) => ({
          seq: s.seq,
          amz: s.amz,
          status: s.status,
          to: s.to === undefined ? null : s.to,
          via: s.via || null,
          expr: s.expr || null,
          signal: s.signal || {},
          env: { artifact: s.env.artifact, run: s.env.run },
          output: trim(s.output, 400),
        })),
      })
      return
    }

    json(res, 404, { ok: false, error: '未知路径：' + u.pathname })
  } catch (e) {
    json(res, 500, { ok: false, error: String(e && e.message ? e.message : e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('LLM R WebUI  http://127.0.0.1:' + PORT + '/')
  console.log('目录: ' + DIR)
  console.log('根:   ' + ROOT)
  console.log('真模型后端: ' + (store.getSettings().model.apiKey ? '已配置 Key' : '无 Key（只有 echo）'))
})
