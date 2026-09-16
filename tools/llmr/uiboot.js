/* LLM R · SWF 自带界面的引导层
 *
 * 由服务器注入到 SWF 的 HTML 里。页面**只通过 postMessage 与宿主说话**——
 * iframe 是 sandbox="allow-scripts" 且不给 allow-same-origin，所以它拿到的是
 * 不透明源：摸不到宿主 DOM、拿不到 localStorage、递不了 cookie。
 * 这里能给的，只有声明过的那几样。
 *
 * 注入方式见 server.cjs 的 injectBoot()。
 */
(function () {
  'use strict'
  var SEQ = 0
  var WAIT = {}          // id -> { resolve, reject }
  var LISTENERS = {}     // 事件名 -> [fn]
  var STATE = null
  var TIMEOUT = 300000   // 模型调用可以很慢；宿主没回应就别卡死

  function send (type, payload, id) {
    parent.postMessage({ __llmr: 1, type: type, id: id, payload: payload }, '*')
  }

  function call (type, payload) {
    return new Promise(function (resolve, reject) {
      var id = ++SEQ
      WAIT[id] = { resolve: resolve, reject: reject }
      send(type, payload, id)
      setTimeout(function () {
        if (WAIT[id]) { delete WAIT[id]; reject(new Error('宿主没有回应：' + type)) }
      }, TIMEOUT)
    })
  }

  function emit (name, data) {
    var fs = LISTENERS[name] || []
    for (var i = 0; i < fs.length; i++) {
      try { fs[i](data) } catch (e) { if (window.console) console.error('[llmr] 监听器抛错', e) }
    }
  }

  window.addEventListener('message', function (ev) {
    var m = ev.data
    if (!m || m.__llmr !== 1) return
    if (m.type === 'state') { STATE = m.payload; emit('state', m.payload); return }
    if (m.type === 'event') { emit(m.payload.name, m.payload.data); return }
    if (m.id && WAIT[m.id]) {
      var w = WAIT[m.id]; delete WAIT[m.id]
      if (m.error) w.reject(new Error(m.error)); else w.resolve(m.payload)
    }
  })

  window.llmr = {
    version: '1.0',

    /** 最近一次的宿主状态：{ swf, args, screen, trace, lastOutput, poolRounds } */
    state: function () { return STATE },

    /** 告诉宿主"我准备好了"，拿回当前状态 */
    ready: function () { return call('ready', null) },

    /** 开始运行。args 并进入口参数；events 是**外部动作**，只有环控区监听器看得见 */
    run: function (args, events) { return call('run', { args: args || {}, events: events || {} }) },

    /** 主动要求换页。流程里没有的页（比如"亲自编辑"）靠它 */
    screen: function (id) { return call('screen', { id: id }) },

    /** 从暂停处继续（signal.ask 的答复进 args.confirm） */
    resume: function (startAt, answer) {
      return call('resume', { startAt: startAt, answer: answer === undefined ? '' : answer })
    },

    /** 监听：'state' | 'step' | 'pause' | 'done' | 'error' */
    on: function (name, fn) {
      (LISTENERS[name] = LISTENERS[name] || []).push(fn)
      return window.llmr
    },
    off: function (name, fn) {
      LISTENERS[name] = (LISTENERS[name] || []).filter(function (f) { return f !== fn })
      return window.llmr
    },

    /** 文件读写——范围限定在这张 SWF 自己的工作区（<swf-id>/ 目录） */
    fs: {
      read: function (p) { return call('fs', { op: 'read', path: p }) },
      write: function (p, text) { return call('fs', { op: 'write', path: p, text: text }) },
      list: function (p) { return call('fs', { op: 'list', path: p || '' }) },
    },

    /** 掷骰。**宿主掷、宿主记**——掷骰结果必须进轨迹，否则不可复现 */
    dice: function (n, faces) { return call('dice', { n: n || 1, faces: faces || 20 }) },

    /** 记一行日志（宿主控制台） */
    log: function (text) { send('log', { text: String(text) }, null) },
  }

  function boot () { send('boot', null, null) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
