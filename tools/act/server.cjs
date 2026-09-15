#!/usr/bin/env node
'use strict'
// ACT WebUI —— ACT 自己的前端，**不依赖 DSH**。
//
// ACT 的前端与后端都能独立运行：
//   后端 = validator / loader / executor / backends（纯 Node）
//   前端 = 本文件提供的页面 + JSON 接口
// DSH 插件只是「接入方式之一」，不是必需。
//
// 用法：node server.cjs [--port=8735] [--dir=…/verify] [--root=…/ACT]
//
// 安全：只绑 127.0.0.1；只允许访问 --root 之下的路径；
//       默认后端是 echo（不产生任何模型花费）。真模型走 http 后端，凭据在「设置 → 模型 API」里配。
//       配了 Key 才算同意真实调用；调哪个模型由 SWF 的每个 AMZ 自己声明。

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const loader = require('./loader.cjs')
const { listOf, viewOf, indexOf, matchOf } = require('./view.cjs')
const { executeSwf } = require('./executor.cjs')
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
      json(res, 200, viewOf(full, { libraryDir: path.join(dir, 'lib') }))
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
      const startAt = u.searchParams.get('startAt') || undefined
      const confirm = u.searchParams.get('confirm')
      if (confirm !== null && confirm !== undefined) entryArgs.confirm = confirm

      const r = await executeSwf(prepared.swf, {
        backend,
        args: entryArgs,
        amzLibrary: prepared.library,
        startAt,
      })

      json(res, 200, {
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
  console.log('ACT WebUI  http://127.0.0.1:' + PORT + '/')
  console.log('目录: ' + DIR)
  console.log('根:   ' + ROOT)
  console.log('真模型后端: ' + (store.getSettings().model.apiKey ? '已配置 Key' : '无 Key（只有 echo）'))
})
