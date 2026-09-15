'use strict'
// ACT 视图层：把声明整成「前端要的东西」。
//
// ACT 的前端与后端都能独立运行。这是**任何前端都该走的唯一入口**：
//   · ACT 自己的 WebUI（server.cjs）
//   · DSH 插件
//   · CI / 脚本
//
// 产出 = 有效 SWF（defaults 已应用、$ref 已解析、extends 已物化）+ 能力表面 + 校验结果。
// 这样前端不需要复制任何 ACT 语义。

const fs = require('node:fs')
const path = require('node:path')
const loader = require('./loader.cjs')
const { runChecks } = require('../validator/checks.cjs')
const { readJson } = require('./store.cjs')

/** 轻量索引：每张 SWF 的 id / 标题 / 标签 / 适用描述（不读全文语义） */
function indexOf (dir) {
  const out = []
  for (const s of listOf(dir).swfs) {
    try {
      const doc = readJson(s.path, null)
      if (!doc) continue
      const swf = (doc && doc.swf) ? doc.swf : doc
      const inv = (swf && swf.invoke) || {}
      out.push({
        path: s.path,
        name: s.name,
        id: String((swf && swf.id) || ''),
        title: String((swf && swf.title) || ''),
        tags: Array.isArray(inv.tags) ? inv.tags.map(String) : [],
        when: String(inv.when || ''),
      })
    } catch (_) { /* 坏文件跳过 */ }
  }
  return out
}

/**
 * 按用户那句话去匹配一张 SWF。
 *
 * ⚠ 这是**关键词匹配**，不是理解。ACT 设计里这一步归 DIR（见 §8），
 * 现在用一个朴素打分先撑住交互；DIR 做出来之后由它接手。
 * 打分：标签整体出现权重高；再按 2-gram 重合度加分。
 */
function matchOf (dir, q) {
  const query = String(q || '').trim()
  const ql = query.toLowerCase()
  const scored = indexOf(dir).map(function (it) {
    const hay = (it.tags.join(' ') + ' ' + it.when + ' ' + it.title + ' ' + it.id).toLowerCase()

    // 标签直接出现在问句里 → 强命中
    let tagHits = 0
    for (const t of it.tags) {
      const tl = String(t).toLowerCase()
      if (tl && ql.indexOf(tl) >= 0) tagHits++
    }

    // 2-gram 重合**比值**（而不是绝对个数）——绝对个数会随句子变长而虚高
    let hit = 0
    let total = 0
    for (let i = 0; i + 1 < ql.length; i++) {
      const g = ql.slice(i, i + 2)
      if (g.trim().length < 2) continue
      total++
      if (hay.indexOf(g) >= 0) hit++
    }
    const ratio = total ? hit / total : 0

    return { it, tagHits, ratio, score: tagHits * 10 + ratio }
  }).sort(function (a, b) { return b.score - a.score })

  // ⚠ 阈值：宁可说「不确定」，也不要给一个假匹配。
  // 之前只要返回 best 就一定配上一张，连「完全不相干的请求」都能配上（score 0）。
  const THRESHOLD = 0.35
  const top = scored.length ? scored[0] : null
  const confident = !!top && (top.tagHits > 0 || top.ratio >= THRESHOLD)

  return {
    query,
    matching: 'keyword', // 明说是关键词匹配，不是理解
    best: confident ? top.it : null,
    bestScore: top ? Number(top.score.toFixed(3)) : 0,
    bestRatio: top ? Number(top.ratio.toFixed(3)) : 0,
    threshold: THRESHOLD,
    candidates: scored.map(function (s) {
      return {
        path: s.it.path,
        name: s.it.name,
        title: s.it.title,
        tags: s.it.tags,
        when: s.it.when,
        ratio: Number(s.ratio.toFixed(3)),
        score: Number(s.score.toFixed(3)),
      }
    }),
  }
}

/** 列出某个目录下的 SWF 与 AMZ 库 */
function listOf (dir) {
  const out = { dir, swfs: [], amz: [], problems: [] }
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith('.swf.json')) out.swfs.push({ name: n, path: path.join(dir, n) })
    }
  } catch (e) {
    out.problems.push('目录：' + (e && e.message ? e.message : String(e)))
  }
  try {
    for (const n of fs.readdirSync(path.join(dir, 'lib'))) {
      if (n.endsWith('.json')) out.amz.push({ name: n })
    }
  } catch (_) { /* 没有 lib 目录不算问题 */ }
  return out
}

/** 一份声明的完整视图 */
function viewOf (file, opts = {}) {
  const prepared = loader.prepare(file, { libraryDir: opts.libraryDir, forExport: true })
  if (prepared.problems) {
    return {
      ok: false,
      path: file,
      swf: prepared.swf,
      surface: [],
      errors: prepared.problems,
      warnings: [],
      surfaceHash: null,
    }
  }
  const r = runChecks(prepared.swf, {
    mode: 'author',
    amzLibrary: prepared.library,
    toolRegistry: opts.toolRegistry,
    uiPages: opts.uiPages,
  })
  return {
    ok: r.errors.length === 0,
    path: file,
    swf: prepared.swf,
    surface: r.surface,
    errors: r.errors,
    warnings: r.warnings,
    surfaceHash: r.surfaceHash,
    entry: r.entry,
  }
}

module.exports = { listOf, viewOf, indexOf, matchOf }
