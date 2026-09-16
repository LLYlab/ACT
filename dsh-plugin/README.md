# LLMR · DSH 插件（可选入口）

**LLMR 不依赖 DSH。** 后端（`tools/llmr/`）与前端（`server.cjs` + `webui.html`）都能独立运行。
这里存的是 **DSH 侧的入口插件**——一个可选的接入方式。

> 为什么落盘：**动态 Cordis 插件只活在当前 DSH 进程里，重启即消失。**
> 源码存在这里，进程重启后可以重新装载。

---

## 它做什么

| 半区 | 内容 |
|---|---|
| **Host** | 只有一个处理器 `llmr/info` → 返回 LLMR WebUI 的地址。**不读磁盘、不依赖 `fs` 服务、不重算任何 LLMR 语义。** |
| **Client** | ① 左侧栏一个 LLMR 图标（`sidebar.panellist`，**加性槽**，`replaceRisk: none`）② 中央面板是一个「打开 LLMR」跳转页 |

点图标 → 跳转页 → 点「打开 LLMR」→ 新标签打开 `http://127.0.0.1:8735/`。

> **为什么是两步而不是一步**：`sidebar.panellist` 的图标是**面板切换器**，
> 点击行为由 owner 控制、插件没有钩子；而 `window` 不在客户端已确认的 builtins 里
> （只有 `ctx` / `React` / `host` / `styles` / `console`）。
> 所以用 `<a target="_blank">` 跳转，**不赌任何未确认的全局**。

---

## 装载（每个 DSH 进程一次）

1. 先起 LLMR 后端：双击 `..\start.cmd`，或 `node tools/llmr/server.cjs --port=8735`
2. `cordis_define`（kind: new，idPrefix: `llmr`）
   - `code.host` ← `llmr.host.js` 全文
   - `code.client` ← `llmr.client.js` 全文
3. `cordis_run`（Client 半区首次需要批准）
4. 之后改代码用 `cordis_define`（kind: existing）+ `cordis_run`（mode: update）

---

## 历史（别重犯）

| Package | 做法 | 结果 |
|---|---|---|
| `pkg-1` | Host 用 `fs` 服务读声明，Client 原生面板渲染 SWF/图/能力表面 | 能跑，但**能力表面不解析 `$ref`**、**显示字面值而非有效值**——审查视图恰好在最关键处是瞎的 |
| `pkg-2` | 修上面两点，但在 Host 里**镜像了一份 `applyDefaults` / `buildSurface`** | 方向错了：LLMR 的后端本来就是独立程序，插件不该重算 LLMR 语义 |
| **`pkg-3`** | **只当入口** | Host 只剩 `llmr/info`；语义只有一份，在 `tools/llmr/` 里 |

> 教训：**同一个语义两份实现，必然漂移。**
> 视图层的唯一实现在 `tools/llmr/view.cjs`——WebUI、CI、任何前端都走它。

---

## 已知未做

- **一步打开**：需要查 DSH 有没有「打开外部 URL」的客户端服务（如 `dsh-client-ui-open-in-app` 一类）。查到了就能把两步变一步。
- **自动起服务**：现在要手动（或 `start.cmd`）。要做成插件自动拉起，需要 `subprocess` 服务——那会把 DSH 与 LLMR 重新耦合，与「LLMR 独立运行」相悖，**故意不做**。
