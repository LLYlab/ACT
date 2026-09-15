# ACT 校验器规格

> 阶段 0 的实现依据。把 `ACT-设计规格.md` §13 的十七项检查从表格变成可实现的算法。
> 本文同时修掉 `ACT-设计规格.md` 里一处**不可计算**的检查（见 §3 #1）。

---

## 1. 接口

```
输入：SWF 声明文件（YAML 或 JSON），
      可选：AMZ 库根目录、工具注册表快照、UI 页面组注册表
      模式：author（本地）| export（导出）| import（导入）

输出：
  ok: boolean
  errors:   Report[]        // 阻断
  warnings: Report[]        // 提示
  surface:  CapabilityRow[] // 能力表面 = AMZ × tools × guards
  entry:    AmzId           // 唯一入口
  graph:    { nodes, edges }// 便于 UI 展示
```

```ts
interface Report {
  code: string          // ACT-E1xx / ACT-W2xx
  path: string          // JSON Pointer，如 /swf/amz/2/tools
  message: string
  hint?: string         // 修法建议
}
```

---

## 2. 管线（四阶段）

```
[1] 加载      YAML → JSON value；解析 $ref（author/export 模式）
[2] 结构校验  JSON Schema（act.schema.json，ajv 2020-12）  → ACT-E001
[3] 语义校验  17 项（本文 §3）                             → ACT-E1xx / ACT-W2xx
[4] 产出      能力表面 + 图 +（export 模式）surfaceHash
```

**阶段 2 已可用**：`act.schema.json` 经 ajv 实测通过（见 `verify/`）。
阶段 3 是本规格的重点。

> 阶段 2 失败即中止——结构不合法时继续做语义分析只会产生噪音。

---

## 3. 检查项与算法

### #1 工具面安全（**本规格重写：原定义不可计算**）

> **原定义**："某 AMZ 有未被任何边/产物类型引用的工具" → **不可计算**。
> 静态分析无法知道 AMZ 内部会用哪个工具（那是模型运行时的决定）。

**改为两个可计算的代理检查**，而且它们直接对应真正的安全风险（§11 的 CSP 前提）：

ACT 维护一张**工具类别表**（由工具声明提供，或内置已知工具的分类）：

| 类别 | 例 |
|---|---|
| `artifact` | `docx_write`、`xlsx_write` |
| `exec` | `pwsh`、`bash`、`run_code` |
| `fs-write` | `write`、`edit` |
| `net` | `web_fetch`、`web_search` |
| `read` | `read`、`glob`、`grep` |

```
ACT-W201 (警告)  某 AMZ 含 exec 类工具
                 → "会话 sandbox 不是 per-AMZ 的，该 AMZ 继承的是整个会话的 sandbox 模式"

ACT-W206 (警告)  某 AMZ 同时含 exec 类与 artifact 类工具
                 → "CSP 保证被削弱：TWF 虽不提权，但一句被改过的 prompt
                    就能让这个盒子用 exec 工具做设计者没打算的事"
```

**理由**：CSP_AMZ 的安全性完全押在"工具面足够窄"上。
一个同时能 `docx_write` 和 `pwsh` 的盒子，即使权限没变，也已经是"越权使用"的温床。

### #2 分支边组必须有 `else`（**ACT-E101 / E102**）

```
按 edge.from 分组：
  组内 size > 1 且 无任何成员带 else   → ACT-E101（错误）
  组内带 else 的成员数 > 1             → ACT-E102（错误，兜底歧义）
  组内 size == 1 且带 else             → 允许（等价于无条件兜底）
```

### #3 `when` 文法合法且标明 `level`（**ACT-E103** ＋ schema 覆盖）

```
expr.parse(edge.when) 抛 ParseError            → ACT-E103（文法非法）
edge.level 缺失或不在 {1,2,3,4}                → 由 schema 覆盖（ACT-E001）
```

原编号 #3 只写了"标明 `level`"，但 `level` 是 schema 的 required 字段——
**这一项其实一直没有本体**。而真正会失败的是 `when` 解析，
它当时还没有代码（文法解析器是后来才写的），于是 `E103` 长期游离在检查表之外。

本版把 #3 定为"**可解析 + 有级别**"，`E103` 归位，schema 部分仍由 `E001` 覆盖。

### #4 `level >= 2` 但只用确定性变量（**ACT-W202**）

```
ns = namespacesOf(parse(when))          // {signal, artifact, run, args} 的子集
若 level >= 2 且 ns ⊆ {artifact, run, args}  → ACT-W202
   hint: "该判断只用到确定性信息，可降为 level: 1（零成本）"
```

### #5 引用存在性（**ACT-E105**）

| 引用 | 检查 |
|---|---|
| `$ref: amz/x` | 在 AMZ 库中可解析 |
| `tools: [x]` | 在工具注册表快照中存在 |
| `ui.page` | 在 UI 页面组注册表中 |
| `ui.panels[k]` 的 `k` | 是合法视图名（AGT/WFW/DIR/WPC） |

> 工具注册表快照来自 `tools.schemas()`（全局视图）。

### #6 `signal` 字段一致性（**ACT-E106**）

```
对每条 level ∈ {2,3,4} 的边：
  for f in referencedSignalFields(when):
     上游 = 该 edge.from 指向的 AMZ
     若 上游.output.signal.fields 不含 f            → E106（未声明）
     若 typeof(f) 与字面量类型不符（如 signal.n > 5 但 n 是 bool） → E106（类型不符）
```

### #7 可达性（**ACT-W203 / E107**）

```
入口 = 所有 edge.from 中「从未作为 edge.to 或 edge.else 出现」的节点
  入口数 != 1  → ACT-E107（入口不唯一）
BFS 从入口出发，未访问到的 AMZ  → ACT-W203（不可达）
```

### #8 终态一致性（**ACT-E108 / W204**）

```
无出边（不是任何 edge.from，也不是任何 else 目标）且不在 terminal → ACT-E108
在 terminal 中但有出边                                          → ACT-W204
```

### #9 导入复核（**ACT-E109，仅 import 模式**）

**防篡改设计**（本规格新增）：

```yaml
_review:
  at: 2026-09-15T17:00:00Z
  by: "L2959"
  surfaceHash: "sha256:…"     # 能力表面的哈希
```

```
import 模式下：
  顶层无 _review                       → ACT-E109（未经复核）
  _review.surfaceHash != 当前表面哈希   → ACT-E109（导出后被改动过）
```

> 这把"人工过目"从**口头承诺**变成**可校验的凭据**：
> 审查后若有人改了 `tools`，哈希对不上，导入被拒。
> 审查对象是**能力表面**（§11），不是 prompt——改 prompt 不影响哈希，符合设计意图。

### #10 `step` 的缓存提示（**ACT-W205**）

```
若 SWF 中存在任何 kind == "step" 的 AMZ → 汇总一条 W205：
  "step 注入 TCP/SCP 会让请求从第 0 位分叉，继承来的历史吃不到前缀缓存。
   它的价值是信息保真，不是省钱。"
```

不做启发式猜测（原"用在想省钱的位置"无法判定），改为**只要用就提示事实**。

### #11 CSP_AMZ 越权（**由 schema 覆盖**）

`extends` 存在时禁 `tools`/`guards`/`model` → schema 已强制，**ajv 实测拒绝通过**。

### #12 AMZ id 冲突（**ACT-E110**）

收集所有 AMZ id（含 `$ref` 解析后的目标 id），重复 → 错误。

### #13 有分支出边但无 `output.signal`（**ACT-E111**）

```
若某 AMZ 是任何 level ∈ {2,3,4} 边的 from，且 output.signal 缺失 → E111
```

### #14 导出仍含 `$ref`（**ACT-E112，仅 export 模式**）

导出产物中任何未内联的 `$ref` → 错误。

### #15 `level` 与命名空间不匹配（**ACT-E104**）

```
level == 1        → ns ⊆ {artifact, run, args}
level ∈ {2,3,4}   → ns ⊆ {signal}
```

> #4 与 #15 是**同一分析的两面**：#15 拦"级 1 用了 signal"，#4 提示"级 2+ 该降到级 1"。
> 两者合起来把「能降级 1 的不许用级 2」从**人工判断**变成**机械执行**。

---

### #16 引用项必须自带 `model`（**ACT-W207**）

```
AMZ 项含 $ref，且解析后的 AMZ 无 model   → ACT-W207（警告）
```

**这不是代码 bug，是语义坑——由阶段 1 加载器暴露。**
`$ref` 引入的 AMZ 是**共享资产**，被多个 SWF 复用，所以 SWF 的 `defaults`
**刻意不作用于引用项**（否则同一个库 AMZ 会随引用它的 SWF 改变模型）。
于是它若自身没声明 `model`，就会**静默回退到部署默认模型**——
而设计者多半以为 SWF 的 `defaults` 管住了它。

> 规则：**被 `$ref` 引用的 AMZ 必须自带 `model`。**

---

### #17 环检测（**ACT-E113**）

```
从入口可达的子图里存在环   → ACT-E113（错误，列出环的节点路径）
```

**为什么要有这一条。** 执行器有 `max-steps` 兜底，但那是**运行期**才发现，
代价是烧掉一整条轨迹、并且错误信息只是「超过最大步数（图里可能有环）」。
环是**纯静态**就能算出来的事——有环就说明这不再是「固定工作流」，是一个死循环。

**查谁。** 有唯一入口时只查**从入口可达**的部分（不可达节点上的环永远跑不到，
且已被 `ACT-W203` 标出）；**没有唯一入口时全图都查**。

> 后面这条不是多余的：环只要**包含入口**，就必然让入口不再唯一
> （入口同时成了别人的目标），`ACT-E107` 会先响。
> 那时若就此收手，用户看到的是「入口不唯一」这个**症状**，而不是「图里有环」这个**病因**。

**怎么查。** 三色标记（白/灰/黑）+ **显式栈**的迭代 DFS。

> ⚠ **不许用递归。** 图的规模由文档决定，一份超长直链文档能把递归 DFS 直接压爆调用栈。
> 这个项目已经因为「畸形输入压爆调用栈」吃过一次亏（见 §4.1.1 的解析上限），
> 所以第一个"要遍历整张图"的检查必须从一开始就是迭代的。
> 回归测试在 `schemfuzz.cjs` 里：5 万节点的直链与首尾成环，都必须无异常返回。

**去重。** 同一个环会被不同起点重复发现；把环**旋转到最小 id 打头**后比对，只报一次。
最多列 5 个环，其余只报个数——避免一份畸形文档刷出几万条同样的话。

---

## 4. `when` 表达式解析器

### 4.1 文法（**新增括号**，比 `ACT-设计规格.md` §9.4 更完整）

```
expr    := orExpr
orExpr  := andExpr ('or' andExpr)*
andExpr := notExpr ('and' notExpr)*
notExpr := 'not' notExpr | primary
primary := '(' expr ')' | atom
atom    := IDENT [op literal]
literal := NUMBER | STRING | BOOL | array
array   := '[' (literal (',' literal)*)? ']'
```

> **`atom` 的运算符可省略**（本轮测试新增）：
> `signal.need_docx` 等价于 `signal.need_docx == true`。
> 这是最常见的判断形状；原来强制写 `== true` 是不必要的繁琐。
> 省略时该字段**必须是 `bool` 类型**，否则求值失败（静态检查会报 `ACT-E106`）。

### 4.1.1 解析上限（防栈溢出）

| 上限 | 值 | 超出时 |
|---|---|---|
| 输入长度 | 8192 字符 | `ParseError` |
| 嵌套深度（`(` / `not`） | 128 | `ParseError` |
| 条件项数（atom） | 256 | `ParseError` |

**动机**：校验器要吃**别人手写的**声明（"拷贝大佬的"路径）。
没有这组上限时，深度嵌套的 `((((…`、`not not not…`、以及超长 `and` 链
会以 `RangeError: Maximum call stack size exceeded` **崩掉工具**，
而不是给出一份可诊断的错误报告——fuzz 实测 **7 例**（其中 1 例发生在**求值期**）。

这组上限同时界定了 AST 深度，因此 `evalNode` / `walk` 的递归也一并安全。

> 这是"畸形输入必须变成**可诊断的错误**，而不是**崩溃**"这条原则的落地。
> 对一件要消费陌生文件的工具，这是安全属性，不是体验优化。

**词法**：

| 记号 | 形式 |
|---|---|
| IDENT | `[a-zA-Z_][a-zA-Z0-9_]*('.'[a-zA-Z_][a-zA-Z0-9_]*)?` |
| Op | `==` `!=` `in` `>` `<` `startsWith` |
| Keyword | `and` `or` `not` |
| STRING | `'…'` 或 `"…"` |
| BOOL | `true` `false` |
| NUMBER | `-?\d+(\.\d+)?` |

**顶级必须包在 `()` 里吗？** 不。`primary` 允许直接是 `atom`，所以 `signal.a == true` 合法。

### 4.2 求值语义

| 运算 | 规则 | 类型不符 |
|---|---|---|
| **（省略）** | 裸布尔字段，等价于 `== true` | 非 bool → 求值失败 |
| `==` `!=` | 严格相等，**不做隐式转换** | 求值失败 |
| `in` | 右侧必须是数组 | 求值失败 |
| `startsWith` | 两侧必须都是字符串 | 求值失败 |
| `>` `<` | 两侧必须都是数字 | 求值失败 |
| `and` `or` | **短路** | — |
| 未声明字段 | — | 求值失败 |

> **求值失败 ≠ 校验错误。** 运行时求值失败 → **走 `else`**。
> 静态检查（#6）应当**提前**抓到字段不一致，让运行时失败成为"不该发生"的兜底。

### 4.3 分析的三个产物

```
namespacesOf(expr)      → Set<'signal'|'artifact'|'run'|'args'>   // 供 #4 / #15
signalFieldsOf(expr)    → Set<string>                              // 供 #6
literalTypeOf(field)    → 'bool'|'int'|'text'|'refs'               // 供 #6 类型比对
```

---

## 5. 能力表面与哈希

### 5.1 生成

```ts
surface = swf.amz.map(a => ({
  amz: a.id,
  tools: a.tools,          // 排序后
  guards: a.guards.map(g => g.when),   // 排序后
}))
```

### 5.2 哈希

```
surfaceHash = sha256(canonicalJson(surface))
```

`canonicalJson` = 键排序、无空白、数组保序（但 `tools`/`guards` 先排序）。

**性质**：

- 改 `tools` / `guards` → 哈希变 → import 被拒 ✅
- 改 `prompt` → 哈希不变 → 不阻断 ✅（符合设计意图：审查对象是能力，不是措辞）
- 改 `order`（调用顺序）→ **哈希变**（顺序也在表面里？）

> **待定**：`order` 是否纳入哈希？纳入则改流程也要重新复核（更严），不纳入则改流程可不经复核（更松）。
> 见 §8。

### 5.3 导出产物

```yaml
swf: { … }                    # 所有 $ref 已内联
_capabilitySurface: [ … ]
_review: { at, by, surfaceHash }   # 可选；有则 import 时校验
```

---

## 6. 错误码目录

### 错误（阻断）

| 码 | 检查 |
|---|---|
| `ACT-E001` | 结构违规（来自 JSON Schema，携带 ajv 的 instancePath） |
| `ACT-E101` | 分支边组缺 `else` |
| `ACT-E102` | 分支边组有多个 `else` |
| `ACT-E103` | `when` 文法非法 |
| `ACT-E104` | `level` 与命名空间不匹配 |
| `ACT-E105` | 引用的 AMZ / 工具 / 页面组不存在 |
| `ACT-E106` | `signal` 字段未声明或类型不符 |
| `ACT-E107` | 入口不唯一（0 个或多个） |
| `ACT-E108` | 非终态节点无出边 |
| `ACT-E109` | 导入未复核 / 能力表面哈希不符 |
| `ACT-E110` | AMZ id 冲突 |
| `ACT-E111` | 有分支出边但缺 `output.signal` |
| `ACT-E112` | 导出产物仍含未解析 `$ref` |
| `ACT-E113` | 图里存在环（从入口可达的子图） |

### 警告（提示）

| 码 | 检查 |
|---|---|
| `ACT-W201` | AMZ 含 `exec` 类工具（sandbox 不是 per-AMZ 的） |
| `ACT-W202` | `level >= 2` 但只用确定性变量 → 可降级 1 |
| `ACT-W203` | 不可达节点 |
| `ACT-W204` | `terminal` 节点有出边 |
| `ACT-W205` | 存在 `step` 型 AMZ（缓存影响提示） |
| `ACT-W206` | 同时含 `exec` 与 `artifact` 类工具（CSP 保证削弱） |
| `ACT-W207` | `$ref` 引入的 AMZ 未声明 `model`（会静默回退部署默认） |

### 诊断 / 降级（**工具自身状态**，不是 SWF 内容的问题）

| 码 | 含义 |
|---|---|
| `ACT-E999` | 校验器自身抛异常（内部错误）——**这是工具的 bug，不是被校验文件的错** |
| `ACT-W000` | 降级提示：ajv/schema 不可用而跳过结构校验，或结构校验未通过而跳过语义检查 |

---

## 7. 首个测试用例

| 夹具 | 期望 |
|---|---|
| `verify/write_doc.swf.json` | 结构 VALID；语义 **0 错误**；产出 3 行能力表面 |
| `verify/negative-csp-escalation.swf.json` | 结构 INVALID（`ACT-E001`，failingKeyword `then`） |

**需要新增的夹具**（覆盖语义检查）：

| 新夹具 | 应触发 |
|---|---|
| 缺 `else` 的分支 | `ACT-E101` |
| `level:1` 但用 `signal.` | `ACT-E104` |
| `level:2` 但只用 `artifact.` | `ACT-W202` |
| 引用了不存在的 `tools` | `ACT-E105` |
| `when` 用了未声明的 `signal` 字段 | `ACT-E106` |
| 两个入口 | `ACT-E107` |
| 有分支出边但无 `output.signal` | `ACT-E111` |
| AMZ 同时含 `docx_write` + `pwsh` | `ACT-W201` + `ACT-W206` |

---

## 8. 本规格新增/修正的四件事

1. **#1 从不可计算改为可计算**——原定义（"有未被引用的工具"）静态分析做不到。
   改为工具类别配对检查（`exec` 存在 / `exec+artifact` 并存），直接对应 CSP 的安全前提。
2. **#10 从猜测改为陈述事实**——原定义"用在想省钱的位置"无法判定。
   改为"存在 `step` 就提示一次缓存影响"。
3. **文法新增括号与 `startsWith`**——原文法没有 `(...)`，复杂条件写不出来。
4. **#9 新增防篡改机制**——`_review.surfaceHash`，把"人工过目"从口头承诺变成可校验凭据。

### 待你定（新增一条）

**`order`（调用顺序）是否纳入 `surfaceHash`？**

- **纳入**：改流程也要重新复核 → 更严。理由：硬编码的边本身就是"能力"的一部分（它决定这个 SWF 会做什么）。
- **不纳入**：改流程不必复核 → 更松，但陌生人可以改流程而哈希不变。

**我倾向纳入**——因为 ACT 的核心主张就是"流程也是被设计出来的能力"。
