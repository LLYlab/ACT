# ACT 声明格式规格 01

> 阶段 0（校验器）的前置件：**SWF / AMZ 的正式声明语法**。
> 依据：`ACT-设计规格-v1.md` §4 §5 §8 §10。
> 本文中的"官方契约"均来自 DSH 运行时实际查询。

---

## 0. 两个工件

| 工件 | 文件 | 谁写 |
|---|---|---|
| **AMZ 声明** | `*.amz.yml` | 人（作者 / 用户 / 第三方） |
| **SWF 声明** | `*.swf.yml` | 人 |

两者都是**声明式数据**，不是程序（§13.2 的三个理由）。SWF 通过引用或内联 AMZ 组装。

---

## 1. 先澄清一件事：SWF 六字段并不都在 SWF 级

写 schema 时暴露出一个结构事实——SWF 的六字段里**有三个是按 AMZ 分发的**：

| 字段 | 归属 |
|---|---|
| ① 调用方法 `invoke` | **SWF 级** |
| ② SystemPrompt | **按 AMZ 分发**（SWF 可设默认，AMZ 覆盖） |
| ③ tool available | **按 AMZ 分发** |
| ④ 调用顺序 `order` | **SWF 级** |
| ⑤ model 结构 | **按 AMZ 分发**（SWF 可设默认，AMZ 覆盖） |
| ⑥ UI `ui` | **SWF 级** |

所以 SWF = **3 个自身字段 + 3 个对 AMZ 列表的投影**。这不改变你的设计，只是把它写准。

---

## 2. 权限：`permits` 不作为独立字段（重要修正）

`ACT-设计规格-v1.md` §4.3 里我暂列了 `permits` 字段。查证官方契约后，**建议取消它**。

### 官方契约（`tools` 服务，实查）

```
restrict(filter: ToolRestriction): () => void
  "Restrict global tools for the calling agent scope.
   Empty filters, unknown names, scope-local names, and reserved transport names fail.
   Restrictions intersect; scoped registrations remain visible."

guard(guard: ToolGuard): () => void
  "Register a monotonic guard after the extensible tools/pre-execute waterfall.
   A plain-context guard applies globally; one registered through agent.ctx
   applies only to that agent. Any matching guard may deny by returning a reason,
   while NO GUARD CAN FORCE-ALLOW a call another guard denied."

ToolRestriction = { allow?: readonly string[]; deny?: readonly string[] }
```

### 三条结论

1. **权限粒度就是"工具名可见性"。** `ToolRestriction` 只有 `allow` / `deny` 两个名字列表，
   **DSH 没有 per-tool 的权限原子**（没有"fs 只能写 workspace"这种粒度）。
   → 所以"AMZ 与工具+权限绑定"里的**权限，是工具表的函数**，不是并列的第二样东西。

2. **`guard` 是单调的**——"no guard can force-allow a call another guard denied"。
   这对 WPC 是个极好的性质：**ACT 给某个 AMZ 加的守卫只能收紧、不能放松别人的拒绝**。
   即使某个 AMZ 的守卫写错了，也**不可能提权**。

3. **`restrict` 只看得到全局工具**——"Restrictions intersect; **scoped registrations remain visible**"。
   所以 AMZ 的可见工具集 = `该 AMZ scope 内注册的工具` ∪ `(全局工具 ∩ restrict)`。

### 于是 AMZ 的工具/权限编译规则

```yaml
tools: [docx_write]          # 声明式白名单
```
编译为：在该 AMZ 的 agent scope 内 `tools.restrict({ allow: ['docx_write'] })`。

```yaml
guards:                      # 可选：比"工具名"更细的拒绝规则
  - when: "args.path not startsWith workspace"
    reason: "越出工作区"
```
编译为：该 scope 内的 `tools.guard(fn)`（只能 deny）。

> **`permits` 字段取消，改为**：
> **`tools`（白名单，编译到 `restrict`）+ `guards`（可选细粒度，编译到单调 `guard`）**。

**校验器展示的"能力表面"（§12.2 ③）= `tools` ∪ `guards`。**
这正是 §10 说的"一张表就能看清一个陌生 SWF 的全部能力"——现在它有了精确的落地形状。

> ⚠ **仍未闭合**：会话级 sandbox（`sandbox-policy` 的 `mode` / `workspaceRoot`）**不是 per-AMZ 的**。
> 若某个 AMZ 拿到 `pwsh`，它继承的是**会话的** sandbox 模式，而不是 AMZ 自己的。
> 所以 **"工具面最小化" 是唯一可靠的 per-AMZ 收敛手段**——
> 又一个理由支持 §4.6 的结论：*"几乎只有 word 编辑器"不是描述，是安全前提*。

---

## 3. AMZ 声明语法

```yaml
amz:
  id: write_word                 # 必填，SWF 内唯一
  kind: exp                      # 必填：ttc | exp | pipe | step
  prompt: |                      # 必填（except step 可省略，见下）
    你是 Word 文档撰写专家。只使用给定的资料段落，产出 .docx 成品。
    不要引入资料之外的事实。

  tools: [docx_write]            # 必填，必须是「能完成任务的最小集」
  guards: []                     # 可选，细粒度拒绝规则（编译到单调 guard）
  model: deepseek-v4-pro         # 必填

  output:                        # 必填
    body: docx                   # free | text | docx | xlsx | pptx | json | ...
    signal:                      # 可选：仅当该 AMZ 有分支出边时需要
      fields:
        need_word: bool
        refs: int[]
      encoder: self              # self | rule | weak | pipe（缺省继承全局）
```

### 3.1 四型的差异字段

| kind | 额外字段 | 说明 |
|---|---|---|
| `ttc` | — | 无状态，轮间不继承记忆 |
| `exp` | — | 固定领域专家 |
| `pipe` | `pipe: { from: <amz-id>, to: <amz-id> }` | 转译器。**记录它是一次真实 LLM 调用** |
| `step` | `step: { from: <amz-id\|session-ref>, tcp: [...], scp: \| }` | 复制端点 + 注入工具/系统提示变更 |

> **`step` 的校验告警**：若 `step` 被用在"想省钱"的位置 → 警告（§12.3 #10）。
> 因为注入 TCP/SCP 会让请求从第 0 位分叉，**继承的历史吃不到任何前缀缓存**。

### 3.2 CSP_AMZ

TWF 构造的 AMZ **只能是 CSP_AMZ**：`prompt` 可变，`tools` / `guards` / `model` **不可变**。

在本格式里，CSP_AMZ 表达为在**已有 AMZ 的骨架上覆写 `prompt`**：

```yaml
  kind: exp
  extends: amz/write_word        # 必须有 extends，不得新造工具面
  prompt: |                      # 只允许覆写这一个字段
    （修正后的提示词）
```

**编译期强制**：`extends` 存在时，若声明中出现 `tools` / `guards` / `model` → **校验错误**
（这正是"不提权"在格式层的落地）。

---

## 4. SWF 声明语法

```yaml
swf:
  id: write_doc
  version: 1
  title: 写文档                       # 人读用

  invoke:                            # ① 调用方法（SWF 级）
    tags: [办公, 写作]                # 给 DIR 的廉价一筛，避免读全部 when
    when: 需要产出一份文档类成品时
    args:
      - { name: goal, type: text, required: true }
      - { name: refs, type: refs, required: false }

  defaults:                          # ②⑤ 的 SWF 级默认，AMZ 可覆盖
    model: deepseek-v4-flash
    tools: []

  amz:                               # ③ 容器列表（内联或引用）
    - $ref: amz/plan_outline
    - $ref: amz/write_word
    - inline:
        id: write_plain
        kind: exp
        prompt: ...
        tools: []
        model: deepseek-v4-flash
        output: { body: text }

  order:                             # ④ 调用顺序（硬编码 DAG）
    - from: plan_outline
      to: write_word
      when: "signal.need_word == true"
      else: write_plain

  ui:                                # ⑥ 交互页面
    page: [AGT, WFW, DIR, WPC]
    fallback: native
```

### 4.1 `order` 的三条硬约束

1. **有分支的边组必须整体带 `else`**（失败策略落点）
2. `when` 必须**标明所属级别**（`level: 1|2|3|4`），级 1 需要写 `rule:`
3. 首节点唯一（`from` 从未出现过的节点 = 入口）；不允许不可达节点

```yaml
  order:
    - from: plan_outline
      to: write_word
      when: "signal.need_word == true"
      level: 2                       # 级 2 = 尾部信号块
      else: write_plain
    - from: plan_outline
      to: write_plain
      when: "signal.section_count > 0"
      level: 1
      rule: "上一步产物类型为 text"   # 级 1 必须写明确定性规则
```

---

## 5. 判断边表达式文法

```
expr    := term (('and' | 'or') term)*
term    := ['not'] atom
atom    := 'signal.' ident op literal
op      := '==' | '!=' | 'in' | '>' | '<'
literal := number | string | bool | array
array   := '[' (literal (',' literal)*)? ']'
```

**求值规则**：

- 宿主侧求值、**确定性、无副作用**
- **禁止函数调用、禁止模型参与求值**
- 求值失败（缺字段 / 类型不匹配）→ **走 `else`**，不中止

---

## 6. 转码器（全局注册 + 局部声明）

```yaml
# 全局注册（ACT 配置，不是 SWF 文件的一部分）
transcoder:
  rule: deterministic
  weak: { model: deepseek-v4-flash, prompt: "把以下内容抽成 JSON：…" }
  pipe: { $ref: amz/format_json }
  default: self
```

SWF 里只写 `encoder: weak`，**不写 weak 是什么**。要覆盖时才内联定义。

> 形状同 `compaction-basic`：**实现全局、按 scope 装载**。照抄，不发明新的一致性模型。

---

## 7. 打包与分发（"拷贝大佬的"要求自包含）

| 引用形式 | 用途 |
|---|---|
| `$ref: amz/xxx` | 指向本地 AMZ 库 |
| `inline: {...}` | 就地定义 |

**分发规则**：导出一个 SWF 时，**必须把所有 `$ref` 解析并内联**，产出**自包含单文件**。
理由：拷来一个 SWF 却缺依赖的 AMZ，等于拿到跑不起来的壳。

**导出产物同时携带**：

```yaml
  _capabilitySurface:                # 导出时由校验器生成，供人审
    - amz: write_word
      tools: [docx_write]
      guards: []
```

审查对象就是这张表（§10 / §13.3），**不是 prompt**。

---

## 8. 校验规则映射（10 项 → schema 约束）

| # | 检查 | 级别 | 在 schema 上的落点 |
|---|---|---|---|
| 1 | 工具表是最小集 | 警告 | 人工判断；校验器提示"该 AMZ 有 N 个工具，其中 M 个未被任何边/产物类型引用" |
| 2 | 有分支的边组有 `else` | **错误** | `order` 内同一 `from` 的多条边必须至少一条带 `else` |
| 3 | 判断边标明级别 | **错误** | `when` 必须伴随 `level` |
| 4 | 能降级 1 却用级 2+ | 警告 | `level >= 2` 且表达式只用了产物元信息（产物类型/计数）→ 提示可降级 |
| 5 | 引用的 AMZ/工具/页面组存在 | **错误** | `$ref` 可解析；`tools` 名在注册表中存在；`ui.page` 名在 UI 宿主中注册 |
| 6 | `signal.fields` 与 `when` 字段一致 | **错误** | 所有 `when` 引用的 `signal.X` 必须由某上游 AMZ 声明 |
| 7 | 不可达节点/边 | 警告 | 从唯一入口做可达性分析 |
| 8 | 无出边且非终态 | **错误** | 终态必须显式标注 `terminal: true` |
| 9 | 导入时人工过目能力表 | 错误（导入路径） | 存在 `_capabilitySurface` 且带人工确认标记 |
| 10 | `step` 被用在"想省钱"的位置 | 警告 | `kind: step` 且 `invoke.tags` 含成本敏感标记，或 note 里声称省 token |

**新增（格式逼出来的）**：

| # | 检查 | 级别 |
|---|---|---|
| 11 | `extends`（CSP_AMZ）声明了 `tools`/`guards`/`model` | **错误** |
| 12 | `$ref` 与 `inline` 的 `id` 冲突 | **错误** |
| 13 | `output.signal` 缺失但该 AMZ 有分支出边 | **错误** |
| 14 | 导出的 SWF 仍含未解析 `$ref` | **错误** |

---

## 9. 这份 schema 逼出来的新问题

1. **`args.type: refs`（资料标号）的形态未定。** §9 说标号是"信息段的序号"，
   但序号的作用域（项目级 / 任务级）、最大范围、以及**谁解析成内容**都还没定。
   校验器需要知道 `refs` 的合法性边界。

2. **`step` 的 `from` 指什么？** 我暂写成 `<amz-id | session-ref>`。
   但"复制之前模型端点"——端点是**AMZ 的完成态**，还是**任意会话位置**（`sessions.fork(source, boundary)` 支持任意 seq）？两者实现不同。

3. **`ui.page` 的合法值从哪来？** 需要 ACT 维护一个"页面组注册表"。
   目前只有 `[AGT, WFW, DIR, WPC]` 一组，是不是就这一组？还是 SWF 可以自定义页面组？

4. **级 1 的 `rule` 怎么被真正求值？** 我写了 `rule: "上一步产物类型为 text"`（自然语言），
   但§8.3 要求"禁止模型参与求值"。所以级 1 的规则必须是**可执行的结构化形式**，
   还是说它只是给人/审查者读的注释，实际求值由 ACT 内置判定器做？
   → **这条影响判断边求值器的实现，需要你定。**

---

## 10. 待办

- [ ] 用户确认 §2（取消 `permits`）与 §1（字段归属）
- [ ] 回答 §9 的四个问题（可分批）
- [ ] schema 冻结 → 产出机器可读版（JSON Schema）→ 实现校验器（阶段 0）
- [ ] 附带：一个完整可跑的示例 SWF（含 `docx_write` 工具的占位定义）
