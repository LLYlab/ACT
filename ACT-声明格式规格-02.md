# ACT 声明格式规格 02

> 取代 `ACT-声明格式规格-01.md`。
> 本版两处实质推进：**① 级 1 判断的文法统一（修掉 01 的一个真实缺陷）**；
> **② 01 §9 的四个开放问题给出默认解**。另附完整示例。

---

## 1. SWF 六字段的归属

| 字段 | 归属 |
|---|---|
| ① 调用方法 `invoke` | **SWF 级** |
| ② SystemPrompt | **按 AMZ 分发**（SWF 可设默认，AMZ 覆盖） |
| ③ tool available | **按 AMZ 分发** |
| ④ 调用顺序 `order` | **SWF 级** |
| ⑤ model 结构 | **按 AMZ 分发**（SWF 可设默认，AMZ 覆盖） |
| ⑥ UI `ui` | **SWF 级** |

SWF = **3 个自身字段 + 3 个对 AMZ 列表的投影**。

---

## 2. 权限：`permits` 取消（官方契约依据）

```
ToolRestriction = { allow?: readonly string[]; deny?: readonly string[] }
restrict(filter)  "Restrict global tools for the calling agent scope …
                   Restrictions intersect; scoped registrations remain visible."
guard(fn)         "monotonic guard … NO GUARD CAN FORCE-ALLOW a call another guard denied"
```

1. **权限粒度 = 工具名可见性。** DSH **没有 per-tool 权限原子**。
   → 「AMZ 与工具+权限绑定」里的权限**是工具表的函数**，不是并列的第二样东西。
2. **`guard` 单调**——ACT 给 AMZ 加的守卫只能收紧、不能放松。**即使写错也不可能提权。**
3. **AMZ 可见工具集** = `该 AMZ scope 内注册的工具` ∪ `(全局工具 ∩ restrict)`。

**编译规则**：

```yaml
tools: [docx_write]                 # → 该 agent scope 内 restrict({allow:['docx_write']})
guards:                             # → 该 scope 内的单调 guard()（只能 deny）
  - when: "args.path not startsWith workspace"
    reason: "越出工作区"
```

**校验器展示的「能力表面」= `tools` ∪ `guards`。**

> ⚠ **未闭合**：会话级 sandbox（`sandbox-policy`）**不是 per-AMZ 的**。
> 某 AMZ 拿到 `pwsh` 时继承的是**会话的** sandbox。
> → **"工具面最小化"是唯一可靠的 per-AMZ 收敛手段**（又一次印证 §4.6）。

---

## 3. AMZ 声明

```yaml
amz:
  id: write_word
  kind: exp                      # ttc | exp | pipe | step
  prompt: |
    …
  tools: [docx_write]            # 必须是「能完成任务的最小集」
  guards: []
  model: deepseek-v4-pro
  output:
    body: docx                   # free|text|docx|xlsx|pptx|json|…
    signal:
      fields: { need_docx: bool, outline_points: int }
      encoder: self              # self|rule|weak|pipe
```

### 3.1 四型差异

| kind | 额外字段 |
|---|---|
| `ttc` | — |
| `exp` | — |
| `pipe` | `pipe: { from: <amz-id>, to: <amz-id> }` |
| `step` | `step: { from: <amz-id>, tcp: [...], scp: \| }` |

### 3.2 CSP_AMZ（TWF 专用）

```yaml
  kind: exp
  extends: amz/write_word        # 必须 extends，不得新造工具面
  prompt: |                      # 只允许覆写这一个字段
    …
```

**编译期强制**：`extends` 存在时，声明中出现 `tools` / `guards` / `model` → **校验错误**。
这就是「不提权」在格式层的落地。

---

## 4. SWF 声明

```yaml
swf:
  id: write_doc
  version: 1
  title: 写文档
  invoke:
    tags: [办公, 写作]
    when: 需要产出一份文档成品时
    args:
      - { name: goal,  type: text, required: true }
      - { name: refs,  type: refs, required: false }
  defaults:
    model: deepseek-v4-flash
  amz:
    - $ref: amz/plan_outline
    - $ref: amz/write_word
  order:
    - from: plan_outline
      to: write_word
      when: "signal.need_docx == true"
      level: 2
      else: write_plain
  terminal: [write_word, write_plain]
  ui:
    page: [AGT, WFW, DIR, WPC]
    fallback: native
```

---

## 5. 判断边文法（**本版重写**）

### 5.1 01 版的缺陷

01 里我给级 1 写了个自然语言 `rule: "上一步产物类型为 text"`，
但同一条规格又要求"禁止模型参与求值"——**自相矛盾**。自然语言没法机械求值。

### 5.2 修正：级 1 用同一文法，只是换了变量命名空间

| 级 | 手段 | 变量命名空间 | 求值者 |
|---|---|---|---|
| **1** | 确定性规则 | **`artifact.` / `run.` / `args.`** | 宿主（对产物与执行状态的确定性观察） |
| 2 | 尾部信号块 | **`signal.`** | 宿主读 AMZ 自报的结构 |
| 3 | 弱模型转码 | `signal.` | 转码器产出 `signal` 后再由宿主读 |
| 4 | pipe AMZ | `signal.` | 同上 |

> **关键**：级 2/3/4 只是**产生 `signal` 的手段不同**，对求值器而言它们完全一样。
> **求值器只有两种变量来源，没有第三种。**

### 5.3 可用的确定性字段（级 1）

| 变量 | 值域 | 来源 |
|---|---|---|
| `artifact.type` | = 上游 AMZ 的 `output.body`（`free\|text\|docx\|xlsx\|pptx\|json\|…`） | 宿主观察 |
| `artifact.count` | int | 产物个数 |
| `artifact.refs` | int[] | 产物携带的标号 |
| `run.status` | `ok\|fail\|skipped` | 上一步完成状态 |
| `args.<name>` | 同 `invoke.args` 的声明类型 | SWF 入口参数 |

**值域是闭的** → 可校验。

### 5.4 文法

```
expr    := term (('and' | 'or') term)*
term    := ['not'] atom
atom    := ident op literal
ident   := ('signal' | 'artifact' | 'run') '.' ident | 'args' '.' ident
op      := '==' | '!=' | 'in' | '>' | '<' | 'startsWith'
literal := number | string | bool | array
```

**求值规则**：宿主侧、确定性、无副作用；**禁止函数调用、禁止模型参与**；
求值失败（缺字段/类型不匹配）→ **走 `else`**，不中止。

### 5.5 由此得到两条**可机械判定**的校验规则

> **#15（错误）**：`level: 1` 的表达式**只能**用 `artifact.` / `run.` / `args.`；
> `level ∈ {2,3,4}` 的表达式**只能**用 `signal.`。混用或不匹配 → 错误。
>
> **#4（警告，从人工升级为机械判定）**：`level >= 2` 但表达式**只**用到
> `artifact.` / `run.` / `args.` → 提示"应降为级 1"。

这修掉了一个隐患：原来"能降级 1 的不许用级 2"是**人工判断**，现在**可被校验器机械执行**。

### 5.6 一条给 SWF 作者的可操作规则

**想让路由判断变便宜，就给 AMZ 声明具体的 `output.body`。**

因为 `artifact.type` 的值就是 `output.body`。若某 AMZ 声明 `body: free`，
它的产物类型就没有信息量，级 1 判断用不上，只能退到级 2。

> → **"声明具体 body 类型"是把判断成本从级 2 压到级 1 的手段。**

---

## 6. 转码器（全局注册 + 局部声明）

```yaml
# 全局注册（ACT 配置，不属于 SWF 文件）
transcoder:
  rule: deterministic
  weak: { model: deepseek-v4-flash, prompt: "把以下内容抽成 JSON：…" }
  pipe: { $ref: amz/format_json }
  default: self
```

SWF 里只写 `encoder: weak`，**不写 weak 是什么**。要覆盖时才内联定义。

---

## 7. 打包与分发

| 引用形式 | 用途 |
|---|---|
| `$ref: amz/xxx` | 本地 AMZ 库 |
| 直接写 AMZ 对象 | 就地定义 |

**导出必须把所有 `$ref` 解析并内联 → 自包含单文件**，并附：

```yaml
  _capabilitySurface:            # 导出时由校验器生成，供人审
    - amz: write_word
      tools: [docx_write]
      guards: []
```

审查对象就是这张表，**不是 prompt**（§10 / §13.3）。

---

## 8. 校验规则（17 项）

| # | 检查 | 级别 |
|---|---|---|
| 1 | 工具表是最小集（有未被任何边/产物类型引用的工具） | 警告 |
| 2 | 有分支的边组必须有 `else` | **错误** |
| 3 | 每条判断边标明 `level` | **错误** |
| 4 | `level >= 2` 但只用确定性变量 → 应降级 1 | 警告（**机械判定**） |
| 5 | 引用的 AMZ / 工具 / 页面组存在 | **错误** |
| 6 | `signal.fields` 与所有引用它的 `when` 字段一致 | **错误** |
| 7 | 不可达节点 / 边 | 警告 |
| 8 | 无出边且不在 `terminal` 中 | **错误** |
| 9 | 导入路径：能力表已人工过目（有确认标记） | **错误** |
| 10 | `step` 被用在"想省钱"的位置 | 警告 |
| 11 | `extends`（CSP_AMZ）声明了 `tools`/`guards`/`model` | **错误** |
| 12 | `$ref` 与 `inline` 的 `id` 冲突 | **错误** |
| 13 | 有分支出边但该 AMZ 未声明 `output.signal` | **错误** |
| 14 | 导出的 SWF 仍含未解析 `$ref` | **错误** |
| 15 | `level` 与变量命名空间不匹配 | **错误** |

---

## 9. 完整示例（自包含，可用作校验器首个测试用例）

```yaml
swf:
  id: write_doc
  version: 1
  title: 写文档

  invoke:
    tags: [办公, 写作]
    when: 需要产出一份文档成品时
    args:
      - { name: goal,  type: text, required: true }
      - { name: refs,  type: refs, required: false }

  defaults:
    model: deepseek-v4-flash

  amz:
    - id: plan_outline
      kind: exp
      prompt: |
        你是文档规划专家。依据诉求与给定资料，产出提纲与要点清单。
        不要产出正文。
      tools: []
      model: deepseek-v4-pro
      output:
        body: free
        signal:
          fields:
            need_docx: bool
            outline_points: int
          encoder: self

    - id: write_word
      kind: exp
      prompt: |
        你是 Word 文档撰写专家。只使用给定的资料段落，产出 .docx 成品。
        不要引入资料之外的事实。
      tools: [docx_write]
      output:
        body: docx

    - id: write_plain
      kind: exp
      prompt: |
        你是文档撰写专家。只使用给定的资料段落，产出纯文本草稿。
      tools: []
      output:
        body: text

  order:
    - from: plan_outline
      to: write_word
      when: "signal.need_docx == true"
      level: 2
      else: write_plain

  terminal: [write_word, write_plain]

  ui:
    page: [AGT, WFW, DIR, WPC]
    fallback: native
```

> **这个示例依赖一个尚不存在的工具**：`docx_write`。
> 这正是 §14 C-8 说的「**能力盒子里得真装东西**」——写 word 的 AMZ 前提是先有 docx 工具。

---

## 10. 01 §9 四个开放问题的默认解（**请确认或否决**）

| # | 问题 | 默认解 | 理由 |
|---|---|---|---|
| 1 | `refs` 标号形态 | **项目级序号，`int[]`，宿主组装器在 spawn 时解析并内联**；序号项目内单调递增、不复用 | 跨会话复用是 SWF 沉淀价值的前提；AMZ 无读工具，只能由宿主内联 |
| 2 | `step.from` 指什么 | **指向某个 AMZ 的完成态**（`from: <amz-id>`）。任意会话位置作为高级形式暂不支持 | SWF 是硬编码图、AMZ 是节点；任意位置是逃生门，非主路径 |
| 3 | `ui.page` 合法值 | **固定为 `[AGT, WFW, DIR, WPC]` 一组，SWF 不可自定义**；可选 `ui.panels` 声明各视图内挂哪些面板 | AGT 进入 SWF 后 stable → 页面骨架不应因 SWF 而异 |
| 4 | 级 1 `rule` 求值 | **用同一文法、换命名空间**（见 §5），`rule` 关键字取消 | 01 的自然语言 `rule` 与"禁止模型求值"自相矛盾 |

### 仍然未定（不阻塞阶段 0）

- 分级误判的升降级逃生门
- DIR 的隔离边界（它要看整个 SWF 库 + 任务本身）
- TWF 的寿命 / 相似任务会不会重造
- UI 逃生门（任务中途性质变了）
- 信息段库的分段粒度
- 预算闸门（防单 AMZ 失控 vs 防 SWF 有 30 个 AMZ）

### 上一轮挂着的默认

- **默认 5（命名）**：保留 `CSP_AMZ` / `SCP` / `TCP` 原称。`extends` 机制已消化语义歧义。
- **默认 7（TWF 打扰）**：默认请教用户；开关打开时**记录完整 TWF 供事后审**（不阻断但留痕）。

---

## 11. 进度与下一步

- [x] 产出机器可读 JSON Schema → `act.schema.json`（ajv draft 2020-12 实测通过）
- [x] 建立验证夹具 → `verify/`（正例通过、CSP 越权负例被拒）
- [ ] 用户确认 §10 的四个默认 + 两个挂账默认
- [ ] 实现校验器（阶段 0），以 `verify/write_doc.swf.json` 为首个测试用例

### 11.1 实测结果

```
VALID    verify/write_doc.swf.json                  exit 0
INVALID  verify/negative-csp-escalation.swf.json    exit 1
         └ failingKeyword: "then"   ← 即「CSP_AMZ 不得声明 tools」的约束
```

夹具说明：

| 文件 | 断言 |
|---|---|
| `verify/write_doc.swf.json` | §9 示例，必须通过 |
| `verify/negative-csp-escalation.swf.json` | CSP_AMZ 声明了 `tools: [docx_write, pwsh]`，**必须被拒** |
| `verify/check.cjs` | 用 ajv `ajv/dist/2020` 跑结构校验（**不是**阶段 0 的正式校验器） |

### 11.2 本轮由**实测**修掉的三处 schema 缺陷

1. **`tools` 被无条件 require** → 会让**每一个 CSP_AMZ 都失败**，与"TWF 只能产 CSP_AMZ"自相矛盾。
   改为：有 `extends` 时 require `prompt` 且禁 `tools/guards/model`；无 `extends` 时 require `tools` + `output`。
2. **`amz:` 数组项只声明了 `$ref` / `inline:` 两种包装** → 与 §9 示例里的**裸 AMZ 对象**不符。
   改为 `oneOf: [amzRef, amz]`，并取消 `inline:` 包装（§7 已同步）。
3. 负例夹具根部的 `_comment` 触发 `additionalProperties: false` → 已移除。

> **第 1 条特别值得记**：它在规格文字上完全自洽，**不跑一遍根本发现不了**。
> 这正好印证阶段 0 先做校验器是划算的——**规格的缺陷只能靠执行暴露**。

