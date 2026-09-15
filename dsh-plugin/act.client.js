// ACT · DSH 插件 · Client 半区
//
// 这是 `cordis_define` 的 `code.client` 函数体（不是完整模块）。
// 只能用 React.createElement；只依赖已查证的 builtins：ctx / React / host / styles / console。
//
// 只做两件事：
//   ① 在左侧栏放一个 ACT 图标（加性槽 sidebar.panellist，replaceRisk: none）
//   ② 中央面板是一个「打开 ACT」跳转页
//
// 注：sidebar.panellist 的图标是**面板切换器**——点击由 owner 控制，插件没有钩子；
// 而 `window` 不是本半区已确认的 builtin。所以用 <a target="_blank">，
// 不赌任何未确认的全局。代价是「点图标 → 点链接」两步。
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) { console.log('ACT: 缺少 slots 服务'); return }

    styles.insert([
      '.act-wrap{height:100%;display:flex;align-items:center;justify-content:center;padding:32px}',
      '.act-card{max-width:420px;text-align:center}',
      '.act-mark{width:44px;height:44px;line-height:44px;margin:0 auto 14px;border-radius:12px;',
      'background:rgba(127,127,127,.18);font-weight:700;font-size:19px}',
      '.act-title{font-size:16px;font-weight:700;margin:0 0 8px}',
      '.act-desc{opacity:.68;font-size:13px;line-height:1.65;margin:0 0 18px}',
      '.act-open{display:inline-block;padding:8px 18px;border-radius:8px;font-weight:600;font-size:13px;',
      'text-decoration:none;background:rgba(127,127,127,.22);color:inherit}',
      '.act-open:hover{background:rgba(127,127,127,.32)}',
      '.act-foot{opacity:.45;font-size:12px;font-family:ui-monospace,Consolas,monospace;margin:18px 0 0}',
      '.act-ico{display:inline-flex;align-items:center;justify-content:center;font-weight:700}',
      '.act-cmd{font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.7}',
    ].join(''))

    function Launcher() {
      const s = React.useState(null); const info = s[0]; const setInfo = s[1]
      React.useEffect(function () {
        host.call('act/info', {}).then(function (r) { setInfo(r || {}) }).catch(function () { setInfo({}) })
      }, [])
      const url = (info && info.url) || ''
      return React.createElement('div', { className: 'act-wrap' },
        React.createElement('div', { className: 'act-card' },
          React.createElement('div', { className: 'act-mark' }, 'A'),
          React.createElement('p', { className: 'act-title' }, 'ACT 在自己的窗口里运行'),
          React.createElement('p', { className: 'act-desc' },
            'ACT 的前端和后端都能独立运行，不依赖 DSH。它的界面在自己的地址上——',
            '这样同一套界面同时服务「单独跑」和「在 DSH 里用」。'),
          url
            ? React.createElement('a', { className: 'act-open', href: url, target: '_blank', rel: 'noreferrer' },
              '打开 ACT')
            : React.createElement('div', { className: 'act-desc' }, '正在读取地址…'),
          url ? React.createElement('p', { className: 'act-foot' }, url) : null,
          React.createElement('p', { className: 'act-foot' }, '未启动？  node tools/act/server.cjs --port=8735')))
    }

    slots.inject('sidebar.panellist', function () {
      return slots.register(
        { name: 'sidebar.panellist', id: 'act', order: 100, label: 'ACT' },
        function (props) {
          const size = (props && props.size) || 20
          return React.createElement('span', {
            className: 'act-ico',
            title: 'ACT',
            style: {
              width: size + 'px',
              height: size + 'px',
              fontSize: Math.round(size * 0.55) + 'px',
              borderRadius: '6px',
              background: 'rgba(127,127,127,.22)',
              outline: (props && props.active) ? '2px solid rgba(127,127,127,.5)' : 'none',
            },
          }, 'A')
        })
    })

    slots.inject('main', function () {
      return slots.register({ name: 'main', key: 'act' }, function () {
        return React.createElement(Launcher, null)
      })
    })

    console.log('ACT launcher ready')
  },
}
