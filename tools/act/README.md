# ACT 内核（`tools/act/`）

ACT 是一个 **Agent 程序**：用 DSH 的对话作为 AMZ、调 DSH 的工具、用 DSH 的插件。
这里放它的**宿主无关内核**——只 `require` `node:*` 加内部模块，**没有一处 DSH API 依赖**。

> **ACT 的前端和后端都能独立运行。**
> 后端 = 这里的程序；前端 = `server.cjs` + `webui.html`（ACT 自己的 WebUI）。
> DSH 插件只是**接入方式之一**，不是必需。

| 文件 | 职责 |
|---|---|
| `loader.cjs` | **共享库**：归一、`$ref` 解析、defaults、`extends` 物化、导出内联、摘要、BOM 处理 |
| `cli.cjs` | 加载器 CLI：摘要 / 导出自包含单文件 |
| `expression.cjs` | `when` 表达式的词法 / 语法 / 分析 / **求值** |
| `executor.cjs` | **执行器**：按图走、选出边、记轨迹 |
| `backends.cjs` | 执行后端：`echo` / `http` / `dsh` |
| `view.cjs` | **视图层**：`listOf` / `viewOf` —— 所有前端共用的唯一入口 |
| `store.cjs` | 持久化：**AGT 实例**（`agts.json`）与设置（`settings.json`） |
| `server.cjs` | **ACT 自己的 WebUI 后端**（零依赖 HTTP，不依赖 DSH） |
| `webui.html` | **ACT 自己的 WebUI 前端**（原生 JS，无框架；两种模式） |
| `run.cjs` | 执行器 CLI |
| `selftest.cjs` | 加载器 39 项 |
| `exprtest.cjs` | 求值器与分析 51 项 |
| `fuzztest.cjs` | 解析器健壮性（2 万份畸形输入） |
| `executor.selftest.cjs` | 执行器与后端 **96 项**（含暂停/恢复） |
| `homework.smoke.cjs` | 作业 SWF 端到端 **19 项**——跑真声明，不跑玩具图 |
| `uidemo.cjs` | 生成静态预览页（真 CSS + 真渲染函数 + 样例数据），供无头 Edge 出图 |

> `expression.cjs` 放在这里而不是 `validator/`：它是**内核件**，
> 校验器（静态分析）与执行器（运行时求值）都用同一份实现。

---

## 加载

```bash
node cli.cjs <decl.json|yml> [--lib=dir]           # 摘要
node cli.cjs <decl> --lib=dir --export=out.json    # 导出自包含单文件
```

导出做两件事：`$ref` **内联**、`extends` **物化**。产物脱离库也能过校验器。

---

## 执行

```bash
node run.cjs <swf> [--lib=dir] [--backend=echo|http|dsh]
                  [--args-file=args.json] [--signal=amzId.field=value]... [--fail=amzId]...
                  [--max-steps=n] [--trace=out.json] [--json]
```

```
$ node run.cjs ../../verify/write_doc.swf.json --args-file=args.json
ACT 运行
后端: echo
入口: plan_outline

   1. plan_outline       ok    → write_word  [when signal.need_docx == true]
   2. write_word         ok    ■ 终止

结果: completed
最终产出: [docx] write_word
```

> **`--args-file` 而不是 `--args`**：PowerShell 会吃掉 JSON 里的内层引号。复杂参数走文件。

### 执行语义（依据 `ACT-设计规格.md`）

| 情形 | 行为 |
|---|---|
| 出边 `when` 为真 | 走该边 |
| 出边 `when` 为假 | 试下一条 |
| **出边求值失败**（缺字段/类型不符） | **立即走 `else`**（§9.4） |
| 无匹配且有 `else` | 走 `else` |
| 无匹配且无 `else` | 停在非终态 → `stopped` |
| **AMZ 执行失败** | **不是异常**——折成 `run.status='fail'`，交给判断边分支 |
| 到达 `terminal` | `completed` |
| 超过 `max-steps` | `error`（防环） |
| **AMZ 报出非空 `signal.ask`** | **在此暂停**：返回 `status:'paused'` 与 `pause:{at,question,next,seq}` |
| 带 `startAt:<节点>` 再调一次 | 从该节点接着走（出边在那次暂停时**已经选好了**） |

### 暂停与恢复（`signal.ask` 约定，**不新增结构**）

流程里总有"这一步得人点头"的地方。用**已经存在**的 `output.signal` 通道表达：

- AMZ 在 `output.signal.fields` 里声明 `ask: "text"`；
- 执行到它时报出非空 `signal.ask` → 执行器在此停下；
- 用户的答复由调用方放进 `args.confirm`，随 `args` 一路可见；
- 恢复 = 带 `startAt: pause.next` 再调一次。

```js
const r1 = await executeSwf(swf, { backend, args })
// r1.status === 'paused'；r1.finalOutput 是那个 AMZ 的正文（**就是该给用户看的确认卡**）
const r2 = await executeSwf(swf, {
  backend, args: { ...args, confirm: 用户答复 }, startAt: r1.pause.next,
})
```

> 不加 `pause` 字段是因为 schema 冻结在 v1.0，而 `output.signal` 本来就是
> 「AMZ 自报的结构化信息」。代价是这条约定必须写在文档里，不能靠字段名猜。
> 详见 `ACT-设计规格.md` §16.3。


### 判断用的环境（喂给 `expression.evaluate`）

```js
{ signal: <AMZ 自报>,                    // 级 2/3/4
  artifact: { type: <output.body>, count, refs },   // 级 1
  run: { status: 'ok' | 'fail' },                   // 级 1
  args: <SWF 入口参数> }                             // 级 1
```

---

## 执行后端

「AMZ 怎么执行」是可插拔的——**ACT 可以自己执行，也可以交给 DSH**。

| 后端 | 做什么 | 状态 |
|---|---|---|
| `echo` | 确定性产出，不调模型 | ✅ 已测——让整条图可端到端跑 |
| `http` | **ACT 自己调模型**（OpenAI 兼容 `/chat/completions`） | ✅ 已测（注入假 fetch；真实网络未实测） |
| `dsh` | 交给 **DSH 对话**执行（spawn / fork） | 🔌 适配点，需在 DSH 进程内实现 |

`http` 后端做两件可单测的事：**请求构建**（`buildRequest`）与**信号抽取**（`extractSignal`）。
后者就是 §9.5 的级 2 机制：从回复尾部取 ```json 块或末尾平衡的 `{...}`，
按声明的字段与类型过滤（类型不符即丢弃；抽不到就返回空 → 判断走 `else`）。

> `http` 后端**会消耗真实额度**，所以 CLI 要求显式 `--yes` 才允许运行。
> 本次开发**没有发起过任何真实模型调用**。

`dsh` 后端的映射（设计规格 §5.1）：AMZ = 一个 DSH 对话；
`ttc`/`exp` → `subagent`（fresh），`step` → `subagent_fork`；
工具表固定 → 该子会话的 preset 或对其 agent scope 施加 `tools.restrict`。

---

## 轨迹

`--trace=out.json` 落盘的是**结构化执行轨迹**：

```
swf, backend, args, ok, status, reason,
steps: [{ seq, amz, status, input, output, signal, env, to, via, expr, meta }]
```

它是「模型训练平台」那件事里 ACT **唯一该做**的部分——
执行轨迹天然是 (输入, 输出, 用户裁决) 三元组，而且是**同分布**的
（同一个 AMZ 的 prompt 固定，所以它的每次调用都是同分布样本）。

---

## ACT WebUI（独立运行）

```bash
node server.cjs [--port=8735] [--dir=…/verify] [--root=…/ACT] [--allow-http]
```

打开 `http://127.0.0.1:8735/` —— **这条路径完全不经过 DSH**。

| 接口 | 作用 |
|---|---|
| `GET /` | 页面 |
| `GET /api/list?dir=` | SWF 与 AMZ 库列表 |
| `GET /api/view?path=` | 视图层：有效 SWF + 能力表面 + 校验结果 |
| `GET /api/run?path=&args=&signals=&outputs=&startAt=&confirm=` | 执行（默认 echo 后端） |
| `GET /api/index?dir=` | 轻量索引：每张 SWF 的 id / 标题 / 标签 / 适用描述 |
| `GET /api/match?q=` | **关键词匹配**（新建 AGT 用；将来归 DIR）。阈值保守，匹配不到返回 `best: null` |
| `GET`/`POST`/`PATCH`/`DELETE /api/agts` | AGT 实例 |
| `GET`/`POST /api/settings` | 设置（默认模式 / SWF 目录 / 后端 / **模型 API**）|

### 两种模式：**默认是用户模式**

| 模式 | 内容 |
|---|---|
| **用户（默认）** | 侧栏 = **AGT 列表**；主区 = 选中 AGT 的用途与「开始」；另有**设置**与**＋ 新建 AGT** |
| 开发者 | SWF 列表 · 校验结果 · 调用顺序图 · AMZ 有效值 · 能力表面 · 审查凭据 · **试跑** |

> **SWF / 图 / 能力表面属于开发者模式，不是主界面。**
> 作者门槛高、用户门槛低——用户只面对自己的 AGT。

**开发者模式可以直接试跑选中的 SWF**（不必先建一个 AGT）。
主区换成运行表单，**侧栏仍是 SWF 列表**——作者改完声明要能立刻跑一次、来回切。
试跑复用用户模式那一套运行表单与渲染，**不另写一份实现**。

**AGT 实例**（`agts.json`）：`{ id, name, swf, purpose, createdAt }`。
一个 AGT = 一个有名字的角色 + 它背后的 SWF；新建 AGT 就是给一张 SWF 起名并说清用途。

**边界**：只绑 `127.0.0.1`；只允许 `--root` 之下的路径；
默认**只有 echo 后端**（零模型花费），要跑真模型必须显式 `--allow-http`。

**`signals` / `outputs` 是调试参数，只在 echo 后端下生效**：
`signals` 覆写 AMZ 自报的字段（用来走不同的边），`outputs` 覆写 AMZ 的正文。
后者是为 UI 与流程调试留的——**不花额度**就能看真实版式的成品长什么样。
WebUI 在 echo 后端下会把一个「样例输出」框摆出来（换成真后端就消失）。

> 前端与后端共用 `view.cjs` 一份视图实现——**WebUI、DSH 插件、CI 拿到的是同一份数据**，
> 前端不需要复制任何 ACT 语义。

### 看版式：`uidemo.cjs`

UI 好不好看不该靠嘴说。`uidemo.cjs` 把 `webui.html` 里**真正的 CSS 与渲染函数**拿去，
只在 IIFE 末尾把 `boot()` 换成一段样例调用，生成 `_shot/ui-{pause,result}.html`：

```bash
node uidemo.cjs
# 再用无头 Edge 出图，然后看图，而不是猜
msedge --headless=new --window-size=1400,1250 \
       --screenshot=_shot/ui-result.png file:///…/_shot/ui-result.html
```

不重写样式、不复制 markup——**看到的就是用户会看到的那一套**。

---

## 测试

```
$ node selftest.cjs            # 加载器
加载器: 39 通过 / 0 失败
$ node exprtest.cjs            # 求值器与分析
求值器/分析: 51 通过 / 0 失败
$ node fuzztest.cjs            # 解析器健壮性
健壮性: 通过
$ node executor.selftest.cjs   # 执行器与后端
执行器与后端: 96 通过 / 0 失败
$ node homework.smoke.cjs      # 作业 SWF 端到端（真声明）
通过 19 / 失败 0
```

---

## 已知缺口

- **`截取方式` 未进 schema**：设计里 AMZ 之间传什么有 5 种（只取输出 / 整个 / 某断点 / 部分段 / 转译总结），
  但 schema 冻结为 v1.0 时**没有这个字段**。执行器目前固定用最简单的一种：
  传「上一步产出正文 + 入口参数 + 标号」。②–⑤ 是 v1.1 的候选。
- **校验器不检查环**：执行器用 `max-steps` 兜底，但静态检查加一条会更好。
- **`dsh` 后端未实现**：需要跑在 DSH 进程内。
