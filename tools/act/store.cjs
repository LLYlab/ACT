'use strict'
// ACT 持久化：AGT 实例 与 设置
//
// AGT = 用户面对的那个「角色」：一个有名字的实例，绑定一张 SWF。
//   用户模式只看到 AGT；SWF / 图 / 能力表面属于开发者模式。
//
// 两个文件都写在 ACT 根目录下：agts.json / settings.json。

const fs = require('node:fs')
const path = require('node:path')

function readJson (file, fallback) {
  try {
    let s = fs.readFileSync(file, 'utf8')
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1) // BOM：Windows 工具默认会写
    return JSON.parse(s)
  } catch (_) {
    return fallback
  }
}

function writeJson (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file) // 原子替换，避免写坏
}

const DEFAULT_SETTINGS = {
  mode: 'user',
  dir: '',
  backend: 'echo', // echo | http
  model: {
    // 这里配的是**接口与凭据**；具体调哪个模型由 SWF 决定（每个 AMZ 自己声明 model）
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    models: [],
  },
}

function makeStore (root) {
  const AGTS = path.join(root, 'agts.json')
  const SETTINGS = path.join(root, 'settings.json')

  return {
    agtsPath: AGTS,
    settingsPath: SETTINGS,

    listAgts () {
      const v = readJson(AGTS, { agts: [] })
      return Array.isArray(v && v.agts) ? v.agts.filter((a) => a && typeof a.id === 'string') : []
    },

    saveAgts (agts) {
      writeJson(AGTS, { agts })
    },

    /** 新建一个 AGT；名字与绑定的 SWF 是最小必需 */
    addAgt (input) {
      const agts = this.listAgts()
      const agt = {
        id: 'agt-' + Date.now().toString(36) + Math.floor(Math.random() * 1000).toString(36),
        name: String(input.name || '未命名').slice(0, 80),
        swf: String(input.swf || ''),
        purpose: String(input.purpose || '').slice(0, 2000),
        createdAt: Date.now(),
      }
      agts.push(agt)
      this.saveAgts(agts)
      return agt
    },

    updateAgt (id, patch) {
      const agts = this.listAgts()
      const i = agts.findIndex((a) => a.id === id)
      if (i < 0) return null
      const next = Object.assign({}, agts[i], patch, { id: agts[i].id })
      agts[i] = next
      this.saveAgts(agts)
      return next
    },

    removeAgt (id) {
      const before = this.listAgts()
      const after = before.filter((a) => a.id !== id)
      this.saveAgts(after)
      return after.length !== before.length
    },

    getSettings () {
      const s = Object.assign({}, DEFAULT_SETTINGS, readJson(SETTINGS, {}))
      s.model = Object.assign({}, DEFAULT_SETTINGS.model, s.model || {})
      return s
    },

    /**
     * 回给浏览器的设置：**永远不含完整 API Key**。
     * 只回 hasKey 与尾部预览——明文 key 出到前端就失去了它唯一的保护。
     */
    publicSettings () {
      const s = this.getSettings()
      const m = Object.assign({}, s.model)
      const k = String(m.apiKey || '')
      delete m.apiKey
      m.hasKey = k.length > 0
      m.keyPreview = k ? k.slice(0, 3) + '…' + k.slice(-4) : ''
      return Object.assign({}, s, { model: m })
    },

    saveSettings (patch) {
      const cur = this.getSettings()
      const next = Object.assign({}, cur, patch || {})
      if (patch && patch.model) {
        const pm = Object.assign({}, patch.model)
        // apiKey 语义：undefined / '' → 保持原值；null → 显式清除；其它 → 覆盖
        const clearKey = pm.apiKey === null
        const keepKey = pm.apiKey === undefined || pm.apiKey === ''
        if (clearKey || keepKey) delete pm.apiKey

        // ⚠ 顺序要紧：先合并，再清除。
        // 先 delete 再合并的话，Object.assign 会把 cur.model 里的旧 key 又搬回来——
        // 「清除」会静默失效（实测踩过）。
        next.model = Object.assign({}, cur.model, pm)
        if (clearKey) delete next.model.apiKey
      }
      writeJson(SETTINGS, next)
      return this.publicSettings()
    },
  }
}

module.exports = { makeStore, readJson, writeJson, DEFAULT_SETTINGS }
