// LLM R · DSH 插件 · Host 半区
//
// 这是 `cordis_define` 的 `code.host` 函数体（不是完整模块，没有 require/export）。
//
// 定位：DSH 侧只是一个**入口**。LLM R 的后端与前端都独立运行，
// 所以这里不重算任何 LLM R 语义、不读磁盘、不依赖 fs 服务。
//
// 历史：pkg-1/pkg-2 曾在这里镜像 loader 的 applyDefaults / buildSurface，
// 那是错的（同一个语义两份实现，必然漂移）。pkg-3 起全部删除。
return {
  apply(ctx) {
    ctx.effect(() => harness.handle('llmr/info', async () => ({
      url: 'http://127.0.0.1:8735/',
      root: 'C:/Users/L2959/Desktop/项目/LLMR',
      note: 'LLM R 独立运行；本插件只是入口。',
    })))

    console.log('LLM R launcher host ready')
  },
}
