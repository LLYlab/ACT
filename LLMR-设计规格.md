# LLMR 设计规格

> **LLMR = Agent Character Tool**
> 定位：**一个 Agent 程序**——用 DSH 的对话作为 AMZ、调 DSH 的工具、用 DSH 的插件。
> **不造运行时、不造编辑器、不造权限引擎、不造记忆库、不造训练平台**——那些不在 LLMR 的范围里。
> 本文是**唯一权威规格**（lively）。结构约束以 `llmr.schema.json` 为准；语法与校验细则见 `LLMR-声明格式规格-02.md`。
> 被本文取代的历史文档见 `README.md`。

---

## 1. 定位与不做什么

### 核心主张

> **用「人工设计的固定工作流 + 硬编码调用的隔离容器」取代「通用 agent 的自主工具使用」。**

大多数 agent 框架在**加自主性**；LLMR 在**减**。这是它与世界分歧的根本点，也是全部卖点的来源。

| 收益 | 机制 |
|---|---|
| 可预测、不跑偏 | 流程硬编码，模型没有自由发挥的余地 |
| 省 token | 不用把工具表塞进上下文，不用反复推理"该调什么" |
| 注意力集中、提升性能 | 每个容器上下文窄、工具面窄、无关内容进不来 |
| 可审计 | 能力是设计期静态绑定的一张表 |
| 人机界面匹配 | 界面绑定工作种类，不是"一个通用的臃肿 AI" |

「避免干扰」适用于**两个对象**：模型（推理质量）与用户（操作效率）。

### 明确不做

1. **不做通用 agent**——不追求"什么都能干"。
2. **不自动生成 SWF**——AI 的唯一产物是 TWF。**SWF 永远是人的产物。**
3. **不改变 DSH 原生主导航**——不 shadow `sidebar` / `sidebar.workspaces`。
4. **不发明新运行时**——SWF 是数据，执行尽量落在 DSH 现有 seam 上。

### 边界：只做一件事

边界很干脆：

> **LLMR 只做「把 SWF 跑起来」这一件事，其余全用 DSH 现成的。**

| LLMR 要造的 | 状态 |
|---|---|
| SWF / AMZ 声明格式 | ✅ |
| 校验器（含能力表面与审查凭据） | ✅ |
| 加载器（`$ref` 解析、导出内联） | ✅ |
| **执行器**：条件边求值 + 把每个 AMZ 落成 DSH 对话 | ⏳ |

编辑界面、权限引擎、记忆库、嵌套、训练平台、性能框架、专家路由……
**不在 LLMR 的范围里，LLMR 也不逐项权衡它们。**

在这些方向上 LLMR **借用 DSH 已有的东西**：会话 → DSH 对话本身；
工具 → DSH 工具与插件；模型 → DSH 的模型路由；UI → DSH 槽位；
大块内容 → DSH 的 `spillStore` / `attachments`。

#### 一条关于嵌套的自省

嵌套系统 LLMR 不做，但它会击穿 LLMR 的审查机制：子 SWF 里的工具绑不进父的能力表面，
而 `_review.surfaceHash` 只覆盖父 → **改子 SWF 不改哈希 → 审查被绕过**。

→ 任何要做嵌套的系统：**能力表面必须递归展开、哈希必须覆盖整棵子树。**

### 门槛（必须对外明说）

LLMR 面向**中型/大型、任务性质明确、流程可复用**的工作。

**但作者门槛很高**：不能写 SWF 的用户只剩三条路——拷大佬的 / 提 issue 求作者 / 用 TWF 兜底，而**作者是瓶颈**。

> **LLMR 是给"有能力定义自己工作流的人"的工具**，不是"装上就什么都能干"的通用 AI。

---

## 2. 术语表

| 术语 | 全称 | 定义 |
|---|---|---|
| **LLMR** | Agent Character Tool | 本插件 |
| **AMZ** | AgentMemoryZone | 硬编码、隔离、工具与权限**静态绑定**的执行容器 |
| **SWF** | StableWorkFlow | **人工设计**的固定工作流（不可变） |
| **TWF** | Temporary WorkFlow | DIR 运行时构造的**临时**工作流（兜底） |
| **CSP_AMZ** | Change-SystemPrompt AMZ | TWF 构造的、**只改提示词、不提权**的 AMZ |
| **AGT** | Agent | 面向用户的角色，**绑定一个交互页面**，进入 SWF 后 stable |
| **DIR** | Director | SWF **之外**的特殊 AMZ：负责检查与造 TWF |
| **WFW** | WorkFlowWorker | 执行容器全对话的视图 |
| **WPC** | WorkPowerControl | 权限与工具调用锁的视图 |
| **TCP** | Tool Change Prompt | `step` 注入的**工具变更载荷** |
| **SCP** | System-prompt Change Prompt | `step` 注入的**系统提示变更载荷** |
| **标号** | — | 已转成模型可读的**信息段的序号** |

> `SCP` 是**载荷**，`CSP_AMZ` 是**容器类型**——同族不同层。

---

## 3. 架构分层

```
用户
 │
 ▼
[分级]  模型自评 · prompt 极干净 · 不给工具
   小 ──▶ 常规直跑（LLMR 零介入）
   中 ──▶ 判任务性质 ──▶ 进入对应 SWF
   大 ──▶ 先与用户多轮对话判性质 ──▶ 进入对应 SWF
 │
 ▼  ═════ 判定之前 = LLMR 唯一的「流动期」 ═════
 │
进入 SWF ──▶ 一切固定（AGT / UI / AMZ / 工具 / 权限 / 流程）
 │            AGT 与这个人机交互页面绑定，此后 stable
 ▼
AGT ──▶ DIR（SWF 之外的特殊 AMZ）
          ├─ 够 ──▶ 执行该 SWF
          └─ 不够/没有 ──▶ 造 TWF ⚠ 兜底（默认须请教用户）
                              └─ 好用 ──▶ 晋升为 SWF
 ▼
SWF / TWF = 硬编码有向图；边 =「上一步→下一步」；条件 = 硬编码判断（非 AI tool use）
 ▼
AMZ × N    硬编码调用 · 高度固定 · 高度隔离
```

---

## 4. 入口与分级

| 规模 | 路径 |
|---|---|
| **小** | 不启动 LLMR 任何机制，常规直跑。LLMR **零开销、零存在感**。 |
| **中** | 判任务性质 → 进入对应 SWF |
| **大** | 先与用户**多轮对话**判性质 → 进入对应 SWF |

- 分级由**模型自评**完成，prompt 要求「快速决定、非常干净、**不提供工具**」。
- **选 SWF 不是分级的职责**——分级只判性质，**选 SWF 是 DIR 的职责**。
- 判错的升降级逃生门：**未定**（§18）。

---

## 5. AMZ 规格

### 5.1 本质

> **一个用自然语言当参数的硬编码工具。**

```
AMZ:  f(资料标号, 诉求) ──▶ 成品
      内部：固定 SystemPrompt + 固定工具表 + 固定权限 + 固定模型
      外部：什么都看不见（高度隔离）
```

**在 DSH 上，一个 AMZ 就是一个 DSH 对话。**

由 LLMR 按声明把它配置出来（固定的 preset / 工具表 / 模型 / prompt），
用 `subagent`（fresh，对应 ttc·exp）或 `subagent_fork`（带前缀，对应 step）拉起。

> **这是全部简化的来源**：DSH 已经把容器、隔离、工具注册、模型路由、会话分支都做好了。
> LLMR 不造这些，**只按声明去编排它们**。

### 5.2 与 AP（agent preset）的区别

| | AP | AMZ |
|---|---|---|
| 性质 | 通用、可组合 | 固定、封闭、单一能力 |
| 工具面 | 宽 | 极窄（"几乎只有 word 编辑器"） |
| 类比 | **岗位** | **工装夹具** |

### 5.3 六字段

`id` · `prompt` · `tools` · `guards` · `model` · `output`
（`guards` 见 §11；`output` 见 §9）

### 5.4 四型

| 型 | 说明 |
|---|---|
| **ttc** | 无状态工具执行器。一进一出，轮间不继承记忆，高注意力，专做"半成品→成品"。 |
| **exp** | 固定领域专家。 |
| **pipe** | **转译器**（不是隔离器）。把 A 的输出重写成 B 能接住的形式。**是一次真实 LLM 调用，要记账。** |
| **step** | 从某个 AMZ 的完成态复制，注入 TCP + SCP。 |

> **⚠ `step` 不省钱**：注入 TCP/SCP 会让请求从第 0 位分叉，继承来的历史**吃不到任何前缀缓存**。
> 它的价值是**信息保真**（省掉一次有损总结）。**必须写进 DIR 的规划知识。**

### 5.5 调用方式

**硬编码调用**——模型手上**没有**"随便调一个盒子"的通用口子。

### 5.6 CSP_AMZ（TWF 专用）

```yaml
kind: exp
extends: amz/write_word     # 必须 extends
prompt: |                   # 只允许覆写这一个字段
  …
```

> **能力边界由人工在设计期钉死；TWF 只动"怎么说"，不动"能做什么"。**

提权不可能，不是因为 TWF 被限制，而是 **CSP 的修改面不在能力那一侧**——工具表和权限**不在 prompt 里**。

**编译期强制**：`extends` 存在时声明 `tools` / `guards` / `model` → **校验错误**（schema 已实现，实测通过）。

**前提**：

> **每个盒子的工具面必须足够窄。工具面越宽，CSP 的保证越弱。**

反例：某盒子带 `fs` + `pwsh`。CSP 没给它新权限，但一句被改过的 prompt 就能让它删文件——
**这不是提权，是"越权使用"**。

→ **"几乎只有 word 编辑器"不是设计描述，是安全前提。**

---

## 6. SWF 规格

### 6.1 六字段与归属

| 字段 | 归属 |
|---|---|
| ① 调用方法 `invoke` | **SWF 级** |
| ② SystemPrompt | **按 AMZ 分发**（SWF 可设默认） |
| ③ tool available | **按 AMZ 分发** |
| ④ 调用顺序 `order` | **SWF 级** |
| ⑤ model 结构 | **按 AMZ 分发**（SWF 可设默认） |
| ⑥ UI `ui` | **SWF 级** |

> SWF = **3 个自身字段 + 3 个对 AMZ 列表的投影**。

### 6.2 三条不变式

1. **SWF 不可变**——DIR **不修改** SWF，只能在"复用"与"另造 TWF"之间选。
2. **边是硬编码的**——"上一步→下一步"关系，**不是**模型自主的工具调用。
3. **有分支的边组必须有 `else`**——它是失败策略的落点。

### 6.3 分支的层级

「某几个**规划 AMZ** 的输出可以激活 word 制造 AMZ」——这是**上一步→下一步关系**，条件硬编码。

**层级区分**：SWF **内部**有规划 AMZ（其输出可决定走哪条边）；**DIR 在 SWF 之外**（只判断"该不该用这个 SWF"）。**DIR 从不进入执行。**

### 6.4 截取方式（5 种）

| # | 方式 | DSH 现成机制 |
|---|---|---|
| ① | 只取输出 | 一次性 subagent 返回最终文本 |
| ② | 整个 | `sessions.fork(source)` 不带 boundary |
| ③ | 取到某断点 | `sessions.fork(source, **boundary**)` ✅ 原生 |
| ④ | 取某对话段 | ❌ **做不到**（fork 只能取前缀；`compactRegion` 是压成摘要） |
| ⑤ | 转译 / 总结 | `pipe`，或 `compaction` |

---

## 7. TWF 规格

- **兜底**：SWF 无法使用时才走。
- DIR 的提示词**明确要求"实在不行，不要构建 TWF"**。
- 默认**必须请教用户**；另有开关决定是否允许 DIR **自行设计**。
- **结构受限**：只能产 CSP_AMZ（§5.6），**不可能提权**。
- 用户觉得好用 → **晋升为 SWF**。

> **诚实定位**：TWF 路径实质就是"普通 agent 模式"。
> **"高度固定 / 高度隔离"在 TWF 路径上不存在。** 安全模型不得假装覆盖它。

**晋升 = SWF 库唯一的人工审查点** → 晋升时必须**展示 DIR 生成的 prompt / 接线差异**供人过目。

---

## 8. DIR 规格

- SWF **之外**的一个**特殊 AMZ**。
- 调用通常**只是用来检查**：现有 SWF 是否适合当前任务。
- 不适合 / 没有 → 构造 TWF。
- **SWF 库的检查者、TWF 的构造者，从不进入执行。**

**未定**：DIR 的隔离边界（它要看整个 SWF 库目录 + 任务本身，比其他盒子看得多）。

---

## 9. 判断边与输出契约

### 9.1 先缩小问题

路由判断**不需要"结构化整个输出"**，只需要一个**很小的信号**。

→ 真正的设计对象是 **「信号」，不是「输出」**。正文保持自由形式，质量不受损。

### 9.2 判断手段的四级阶梯

| 级 | 手段 | 变量命名空间 | 成本 |
|---|---|---|---|
| **1** | **确定性规则** | **`artifact.` / `run.` / `args.`** | 0 |
| **2** | **尾部信号块**（AMZ 自报） | `signal.` | 0 |
| **3** | **弱模型转码** | `signal.` | 1 次便宜调用 |
| **4** | **格式化 pipe AMZ**（短思考链） | `signal.` | 1 次贵调用 |

> **级 2/3/4 只是产生 `signal` 的手段不同**，对求值器而言完全一样。
> **求值器只有两种变量来源，没有第三种。**

**硬规则**：每条判断边必须标明 `level`；**能降到级 1 的不许用级 2**。

### 9.3 级 1 可用的确定性字段

| 变量 | 值域 |
|---|---|
| `artifact.type` | = 上游 AMZ 的 `output.body` |
| `artifact.count` | int |
| `artifact.refs` | int[] |
| `run.status` | `ok\|fail\|skipped` |
| `args.<name>` | 同 `invoke.args` 声明类型 |

**值域是闭的** → 可校验。

### 9.4 文法

```
expr  := term (('and'|'or') term)*
term  := ['not'] atom
atom  := ident [op literal]        # 省略运算符 = 裸布尔字段（等价 == true）
ident := ('signal'|'artifact'|'run') '.' ident | 'args' '.' ident
op    := '==' | '!=' | 'in' | '>' | '<' | 'startsWith'
```

宿主侧、确定性、无副作用；**禁止函数调用、禁止模型参与求值**；
求值失败（缺字段/类型不匹配）→ **走 `else`**，不中止。

**解析上限**（防栈溢出，详见 `LLMR-校验器规格.md` §4.1.1）：输入 8192 字符 / 嵌套深度 128 / 条件项 256。
超出即 `ParseError`——**畸形输入必须变成可诊断的错误，而不是崩溃**。

### 9.5 级 2 的正确形态

> **正文自由形式 + 尾部一个固定格式的信号块。**

降智的真正风险点**不是**"要求结构化"，而是**"要求正文结构化"**（整段 JSON 会挤压表达）。
附加好处：判断的稳定性**不再依赖正文措辞**。

### 9.6 级 4 的价值

它是**隔离的**，可用极窄 prompt + 固定短思考链，**输出稳定性最好**。留给真正需要语义理解的判断。

### 9.7 给 SWF 作者的可操作规则

**想让路由判断变便宜，就给 AMZ 声明具体的 `output.body`。**
因为 `artifact.type` 的值就是它。声明 `body: free` 的 AMZ 用不上级 1。

### 9.8 转码器：全局实现 + 局部声明

SWF 只写 `encoder: weak`，**不写 weak 是什么**；要覆盖时才内联定义。

> 形状同 `compaction-basic`：**实现全局、按 scope 装载**。照抄，不发明新的一致性模型。

### 9.9 两条可机械判定的校验规则

- **#15（错误）**：`level:1` 只许用 `artifact./run./args.`；`level∈{2,3,4}` 只许用 `signal.`。
- **#4（警告）**：`level>=2` 但只用了确定性变量 → 提示应降为级 1。

> 这把原来"能降级 1 的不许用级 2"从**人工判断**升级为**机械执行**。

---

## 10. 记忆与标号

### 10.1 结构

```
原始资料 ──[预处理/转换]──▶ 信息段库（编号）
                                 │ 标号
                                 ▼
AMZ:  固定 SystemPrompt + 按标号内联的段 + 诉求 ──▶ 成品
```

**标号 = 已经被转化为模型可读的信息段的序号。**

### 10.2 卖点是避免干扰，代价是鲁棒性

长上下文**稀释注意力**；无关内容不只是占位，是**主动伤害**输出质量。

> 盒子里**看不见它"没拿到"的东西**。选错标号或漏标号，盒子**不会说"资料不足"，它会自信地产出错误成品**。

→ **「选标号」这一步的质量 = 整个系统的性能上限。**
→ 必须有一道**"资料是否充分"的检查**，放在调用方（AGT/DIR）一侧（盒子内部做不到）。

### 10.3 五个参数

| 参数 | 决定什么 |
|---|---|
| 谁把原始资料转成模型可读段 | PDF/Word/Excel/图片/网页各有各的转换 |
| **分段粒度** | **太大 → 隔离失效**；**太小 → 标号爆炸** |
| 编号作用域 | **必须是项目级（跨会话）** |
| 存放位置 | 跨会话、跨项目可用性 |
| 可信等级 | §10.5 |

### 10.4 DSH 现成件

| 用途 | 现成件 |
|---|---|
| **信息段引用机制** | `ctx.spillStore.saveText() → SpillRef` |
| 资料摄取 | `attachments`、`fileReferences`、`session-reference` |

> ⚠ **作用域不匹配**：`dsh-spill-local` 是 **session-scoped**，而 LLMR 的资料库必须**项目级**。要改。

### 10.5 新增攻击面：信息段库 → prompt 内联

资料段是被当**可信输入**直接塞进 prompt 的。带对抗性内容时盒子会被带偏；盒子隔离、工具窄 → **损害有限**（设计的红利），但"写 word 的盒子"可能产出恶意文档。

**默认策略**：**入库时查一次**，标记可信等级；内联不重查。外部来源默认不可信，复用 DET 的 `secPromptDefense`。

---

## 11. 权限模型（WPC）

### 11.1 `permits` 不作为独立字段（官方契约依据）

```
ToolRestriction = { allow?: string[]; deny?: string[] }
restrict(filter)  "Restrict global tools for the calling agent scope …
                   Restrictions intersect; scoped registrations remain visible."
guard(fn)         "monotonic guard … NO GUARD CAN FORCE-ALLOW a call another guard denied"
```

1. **权限粒度 = 工具名可见性。** DSH **没有 per-tool 权限原子**。
   → 「AMZ 与工具+权限绑定」里的权限**是工具表的函数**。
2. **`guard` 单调**——LLMR 给 AMZ 加的守卫只能收紧、不能放松。**即使写错也不可能提权。**
3. **AMZ 可见工具集** = `该 AMZ scope 内注册的工具` ∪ `(全局工具 ∩ restrict)`。

**编译规则**：`tools` → `restrict({allow})`；`guards` → 该 scope 内的单调 `guard()`。

> **WPC 不是运行时动态控制面，而是设计期的绑定表。**
> `tools.restrict` / `tools/pre-execute` 的角色从"策略"降级为"**执行保证**"。

> ⚠ **未闭合**：会话级 sandbox **不是 per-AMZ 的**。某 AMZ 拿到 `pwsh` 时继承**会话的** sandbox。
> → **"工具面最小化"是唯一可靠的 per-AMZ 收敛手段。**

### 11.2 可审查性 = 结构性优势

> **能力是设计期静态绑定的一张表（AMZ × 工具 × guards）。一张表就能看清一个陌生 SWF 的全部能力。**

通用 agent 审不了——它运行时才决定调什么。

---

## 12. UI 落点

### 12.1 绑定关系

> **任务判定 → 进入 SWF → AGT 与这个人机交互页面绑定，此后 stable，不再变。**

- **判定之前 = 唯一的"流动"阶段**
- **进入 SWF 之后 = 一切固定**
- 唯一例外出口 = DIR 走 TWF 兜底

**AGT 是 SWF 的门面：SWF 定了，AGT 就定了。**

> **已撤回的错误提案**：曾设想"UI 随 SWF 内的步骤/AMZ 切换"——那违背贯穿全部设计的 **固定 + 隔离** 原则。

### 12.2 两种模式，**默认用户模式**

界面分两层：

| 模式 | 内容 | 谁用 |
|---|---|---|
| **用户（默认）** | **侧栏 = AGT 列表**；主区 = 选中 AGT 的用途与「开始」；另有 **设置** 与 **＋ 新建 AGT** | 使用者 |
| 开发者 | SWF 列表 · 校验结果 · 调用顺序图 · AMZ 有效值 · 能力表面 · 审查凭据 | 写 SWF 的人 |

> **SWF / 调用顺序图 / 能力表面属于开发者模式，不是主界面。**
> 这与 §1 的分工一致：**作者门槛高、用户门槛低**——用户只面对自己的 AGT。

**AGT 实例**（存在 `agts.json`）：

```json
{ "id": "agt-…", "name": "写文档", "swf": "<某张 SWF 的路径>", "purpose": "…", "createdAt": 0 }
```

一个 AGT = **一个有名字的角色 + 它背后的 SWF**。新建 AGT 就是「给一张 SWF 起个名字、说清用途」。

**新建 AGT 不是表单，是入口。** 主区显示一句问候 + 一个输入框：

> 你需要什么帮助，朋友？
> `[ 描述你要做的事… ]`

提交后按 `invoke.tags` / `when` / `title` 做**关键词匹配**，给出一张确认卡
（匹配到的流程 + 起名 + 可换一张），确认即创建。

> ⚠ **这一步本该由 DIR 做**（§8）。关键词匹配只是撑住交互的占位。
> **阈值刻意保守**：匹配不到就明说「不确定」并让用户手选——
> 因为**假匹配比承认不知道更糟**。

**设置里配「模型 API」，但调哪个模型由 SWF 决定。** 设置持有的是**接口与凭据**
（`baseUrl` / `apiKey` / 可用模型清单）；而**每张 SWF 的每个 AMZ 各自声明 `model`**。

> 这条分工不能反——反了就是"由设置决定模型"，那 §19 原则 1（固定优先）里的
> 「model 结构按 AMZ 分发」就没了：同一张 SWF 换个设置就跑出不同行为。

> **API Key 不回传浏览器**：`/api/settings` 只回 `hasKey` 与尾部预览。
> 明文 key 一旦出到前端，它唯一的保护就没了。共享机器上建议改用环境变量
> `DEEPSEEK_API_KEY`，设置里留空。

### 12.3 槽位落点（运行时事实）

| 作用域 | 槽位 | 用途 |
|---|---|---|
| root | **`sidebar.panellist`**（list, 风险 none）+ **`main`**（keyed, 仅占 `conversation`） | **四个入口 + 中央面板** ← 主落点 |
| root | `shell.overlay` | 浮动层（DET 工具栏已在此） |
| session | `conversation.view`、`conversation.session.header.utilities`、`conversation.composer` | 会话内扩展 |
| session | `sidebar.right.pane.tab`（keyed，**无人占用**） | 右栏标签（WPC 的自然位置） |

**必须避开**：

- ❌ **不要 shadow `sidebar` / `sidebar.workspaces`**——后者就是**会话列表本体**，换掉它等于砍掉 DSH 主导航。
- ❌ **`conversation.chat.node` 的 `user` 键已被 DET 占用**。
- ❌ 宿主已占了 `shell.overlay` 与 `sidebar.footer.action` 上的若干槽位。

### 12.4 多会话并发（已解除）

每个会话有自己的 AGT，各自绑自己的页面，**root 级跟随当前聚焦的会话**。不冲突，不需按步骤切。

### 12.5 兜底

- **没有合适的页面 → 回退 DSH 原生 UI**（LLMR 完全不介入）。与"小型任务零介入"同构。
- **逃生门**（任务中途性质变了）：**未定**（§18）。

---

## 13. 校验器规格（阶段 0）

> **实现依据见 `LLMR-校验器规格.md`**——完整算法、`when` 解析器文法、错误码目录、测试用例。
> 本节只列结论。

### 13.1 三个使用者

| 谁 | 用途 |
|---|---|
| 作者 | **发布前门槛** |
| 用户（自己写） | **本地助手** |
| 导入者（拷大佬的） | **安全审查** |

### 13.2 输入 / 输出

```
输入：一份 SWF 声明
输出：① 错误清单（阻断）② 警告清单（提示）③ 能力表面板（AMZ × 工具 × guards）
```

### 13.3 十七项检查

| # | 码 | 检查 | 级别 |
|---|---|---|---|
| 1 | `LLMR-W201` `LLMR-W206` | 工具面安全：含 `exec` 类 / 同时含 `exec`+`artifact`（**原定义不可计算，已重写**） | 警告 |
| 2 | `LLMR-E101` `LLMR-E102` | 有分支的边组必须有 `else`；一个组出现多个 `else` 亦错 | **错误** |
| 3 | `LLMR-E103` ＋schema | `when` 文法合法 **且** 标明 `level` | **错误** |
| 4 | `LLMR-W202` | `level>=2` 但只用确定性变量 → 应降级 1 | 警告（机械判定） |
| 5 | `LLMR-E105` | 引用的 AMZ / 工具 / 页面组存在 | **错误** |
| 6 | `LLMR-E106` | `signal.fields` 与所有引用它的 `when` 字段一致（含类型） | **错误** |
| 7 | `LLMR-E107` `LLMR-W203` | 入口不唯一（0 个或多个）；不可达节点 | **错误** / 警告 |
| 8 | `LLMR-E108` `LLMR-W204` | 无出边且不在 `terminal` 中；反向：在 `terminal` 中却有出边 | **错误** / 警告 |
| 9 | `LLMR-E109` | 导入路径：能力表已人工过目（校验 `_review.surfaceHash`） | **错误** |
| 10 | `LLMR-W205` | 存在 `step` 型 AMZ（缓存影响提示；**原定义不可判定，已重写**） | 警告 |
| 11 | schema | `extends`（CSP_AMZ）声明了 `tools`/`guards`/`model` | **错误** |
| 12 | `LLMR-E110` | AMZ `id` 冲突 | **错误** |
| 13 | `LLMR-E111` | 有分支出边但未声明 `output.signal` | **错误** |
| 14 | `LLMR-E112` | 导出的 SWF 仍含未解析 `$ref` | **错误** |
| 15 | `LLMR-E104` | `level` 与变量命名空间不匹配 | **错误** |
| 16 | `LLMR-W207` | `$ref` 引入的 AMZ 未声明 `model`（会静默回退部署默认） | 警告 |
| 17 | `LLMR-E113` | 图里存在环（从入口可达的子图；入口不唯一时查全图） | **错误** |

> **码空间**：`LLMR-E001` 是**结构校验**（JSON Schema）的统一码，携带 ajv 的 `instancePath`；
> 上表里标 `schema` 的两项由它覆盖，不另设码。
> 另有 `LLMR-E999`（校验器自身异常）与 `LLMR-W000`（降级提示：跳过结构/语义检查）——
> 它们反映的是**工具自身状态**，不是 SWF 内容的问题。
> 完整码目录与算法见 `LLMR-校验器规格.md` §3 与 §6。

> #### 为什么要有第 17 项
>
> 执行器本来就有 `max-steps` 兜底。但那是**运行期**才发现，代价是烧掉一整条轨迹，
> 而且错误信息只说「图里可能有环」。环是**纯静态**就确定的事——
> **能在设计期说清的，不该留到运行期。**
>
> 顺带解决了第 7/8 项的一个诊断问题：环若**包含入口**，入口就必然不再唯一，
> `LLMR-E107` 会先响。只查可达子图、且无入口时查全图，用户才看得到**病因**而不是**症状**。

### 13.4 结构性校验已可用

`llmr.schema.json`（draft 2020-12）已覆盖结构约束，**ajv 实测通过**：

```
VALID    verify/write_doc.swf.json                   exit 0
INVALID  verify/negative-csp-escalation.swf.json     exit 1
         └ failingKeyword: "then"   ← CSP_AMZ 不得声明 tools
```

**#4 / #15 需要解析 `when` 表达式，JSON Schema 表达不了**，必须由校验器实现。

---

## 14. 生态与分发

### 14.1 三条来源（全是人，**LLMR 自己不造 SWF**）

| 来源 | 谁 | 机制 |
|---|---|---|
| **找我造** | LLMR 作者 | 用户提 **issue** → 作者造 |
| **自己写** | LLMR **用户** | 用户用 AI 辅助 + 自己的编程知识写 |
| **拷贝大佬的** | 第三方 | 直接拷 |

### 14.2 三条都指向同一个结论

> **SWF 必须是声明式数据格式，不能是程序。**

- 人写 → 要好写好读
- 用户写 → 要能被 AI 辅助生成
- 拷别人的 → 要能自包含、能校验、能审

> DSH 已有这个形状：**agent preset 就是 YAML 声明**，可 `copy`/`read`/`remove`。SWF 照它做。

### 14.3 拷贝路径 = 安全关键路径

拷陌生 SWF = **引入别人声明的工具和权限**。与 DET 全局插件库**同一类风险**：

> DET 自己写着："全局插件代码以当前进程真实权限运行；`scanCodeWarnings` 只是提示性启发式，**不是安全边界**。"

**审查对象是 `AMZ × 工具 × guards` 那张表**，不是 prompt。

### 14.4 导出必须自包含

导出时把所有 `$ref` 解析并内联，并附 `_capabilitySurface`（由校验器生成）供人审。

### 14.5 复用 DET 的现成管道

| 用途 | 现成件 |
|---|---|
| 导入管道 | **`det_global_plugin_github_rebuild`**——读源码 → 注入病毒/漏洞检查上下文 → 供你审查 → 入库。**天然带审查步骤。** |
| 发现渠道 | `det_global_plugin_store_search` 四源 |
| 入库 | `det_global_plugin_github_save` |

---

## 15. 复用 / 差异化 / 全新

### A. 直接复用

| 用途 | 现成件 |
|---|---|
| 信息段引用 | `ctx.spillStore.saveText() → SpillRef` |
| 资料摄取 | `attachments`、`fileReferences`、`session-reference` |
| 一次性容器执行通道 | DET **`det_tct`** |
| AMZ 的 fresh / fork | `subagent` / `subagent_fork` |
| 截取 ③ / ⑤ | `sessions.fork(source, boundary)` / `compaction` |
| WPC 执行保证 | `tools.restrict` / `tools.guard` |
| SCP / TCP 注入 | `systemPrompt.section` / `systemPrompt.tools` |
| 声明式人工资产格式 | `agentPresets` |
| AGT 的 purpose | `goal` |
| WFW 面板对话目录 | `dsh-client-ui-subagent` |
| UI 槽位 | `sidebar.panellist` + `main`(keyed) + `sidebar.right.pane.tab` |
| 导入/发现/审查 | DET 的 rebuild / store_search / save |
| Prompt 攻击防御 | DET `secPromptDefense` |

### B. 必须差异化

| 官方件 | 差异 |
|---|---|
| `workflow` 工具 | 脚本 + spawn-only + 无 per-stage prompt/工具表；SWF 是人工固定 + 硬编码条件边 + per-AMZ 固定 prompt/工具 |
| `subagent` 工具 | 模型自主 tool use；AMZ 是**硬编码 step-to-step**——**方向相反** |
| `compaction-basic` | 被动、会话内；LLMR 是主动、跨容器 |
| `agentTeams` 契约 | 概念几乎 1:1，但**本机未装载** |

> **决策**：**不依赖 `agentTeams`**，改用 `ctx.subagents.registerProvider` 注册 LLMR 自己的 AMZ provider
> （这样能在 spawn 时施加固定的 prompt / 工具 / 模型绑定）。保留"若官方 agentTeams 稳定则迁移"的注记。

### C. 全新（LLMR 真正要造的，很少）

1. **硬编码条件边求值器** —— 求值实现已有（`expression.cjs`，51 项测试）
2. **执行器** —— 按图走、把每个 AMZ 落成 DSH 对话、记录轨迹
3. **SWF 库 + TWF → SWF 晋升流程**
4. **校验器** ✅ 已完成

早期列为"全新"的项，按「**AMZ = DSH 对话**」重新归类后**都不是 LLMR 要造的**：

| 早期列为"全新" | 现在 |
|---|---|
| 信息段库（项目级） | 用 DSH 的 `spillStore` / `attachments` / 文件引用 |
| DIR | SWF 外的一个特殊 AMZ（即一个特殊 DSH 对话） |
| 任务分级入口 | LLMR 自己的一段提示词 |
| 按 SWF 切换的 UI 宿主 | 用 DSH 槽位 |
| 专用工具盒 | 用 DSH 的工具与插件 |

> ⚠ **一个仍待解决的问题**：DSH 里没有 Word / Excel / PPT 工具。
> 若某个 SWF 需要"写 word 的 AMZ"，那份能力得先存在——
> 但**造它不一定是 LLMR 的责任**（可以是别的 DSH 插件）。

---

## 16. 插件形态与实施阶段

### 16.1 形态

**LLMR = 常驻插件**（与 DET / DBS / TOPO 同档），**Host 半区 + Client 半区**：

- **Host**：SWF 加载器、校验器、条件边求值器、信息段库、DIR、TWF、AMZ 的 subagent provider、`llmr_*` 工具
- **Client**：UI 宿主（`sidebar.panellist` + `main` keyed 面板）
- 装载：`profiles/web/cordis.patch.yml` + 独立包（同 DET）

> 依据：它**发布服务**（段库、SWF 注册表）→ 属于 **host 组合**。

### 16.2 实施阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| **0** | **校验器** —— 加载 + 结构校验 + **17 项**语义检查 + 能力表面与审查哈希 | ✅ 完成（`tools/validator/`） |
| **1** | **加载器** —— `$ref` 解析、defaults、`extends` 物化、导出内联、摘要 | ✅ 完成（`tools/llmr/loader.cjs`） |
| **2** | **执行器** —— 条件边求值、选出边、执行后端、轨迹 | ✅ 完成（`executor.cjs` + `backends.cjs`） |
| **2.5** | **暂停与恢复** —— 走到需要人拍板的地方停下来问，答完从那条边接着走 | ✅ 完成（见 §16.3） |
| 3 | **在 DSH 内落地** —— `dsh` 后端：一个 AMZ = 一个 DSH 对话（preset / `tools.restrict` / spawn·fork） | 依赖 2 |
| 4 | DIR + TWF + 晋升 | 依赖 3 |
| 5 | SWF 库与生态（导入导出、审查、issue 流程） | 依赖 3 |
| 6 | 分级入口（LLMR 自己的一段提示词） | 依赖 3 |

> 早期列过的「信息段库 / UI 宿主 / 专用工具盒」三个阶段**已移除**——
> 按 §1 边界与 §15C，它们改用 DSH 的现成件（`spillStore` / `attachments` / 槽位 / 工具与插件）。

### 16.3 暂停与恢复（不新增结构）

流程里总有「这一步得人点头」的地方（确认抽取到的作业信息、确认要不要覆盖文件）。
LLMR 用**已经存在**的 `output.signal` 通道表达它，**不动 schema**：

- AMZ 在 `output.signal.fields` 里声明 `ask: "text"`；
- 执行到它时若报出了**非空**的 `signal.ask`，执行器在此停下，返回
  `status: "paused"` 与 `pause: { at, question, next, seq }`；
- 出边**照常先选好**，`pause.next` 就是恢复后的入口；
- 恢复 = 带 `startAt: pause.next` 再调一次；用户的答复进 `args.confirm`，随 `args` 一路可见。

为什么这样而不加个 `pause` 字段：`output.signal` 本来就是「AMZ 自报的结构化信息」，
而 schema 已冻结在 v1.0。用现成通道，等于零结构成本；代价是这条约定得写在文档里，
不能只靠字段名去猜——所以它在这里。

UI 侧对应三件事：**把 AMZ 的正文当确认卡摆出来**（`paused` 时 `finalOutput` 就是它）、
把 `signal.ask` 当问题问、拿到答复后带 `startAt` + `confirm` 重发。

### 16.4 参考流程：作业成品（7 步效果 → 11 个节点）

`swfs/homework.swf.json` 是第一个完整走通的真 SWF。用户要的效果是 7 步，
落到声明里是 11 个 AMZ：

| 效果 | 节点 |
|---|---|
| 1 判断是作业任务 | `judge_task` |
| 2 从中提取信息 | `extract_info` |
| 3 与用户确认作业 | `confirm_homework`（声明 `ask` → **暂停**） |
| 4 自动读取作业 pdf | `read_pdf`（恢复后从这里进） |
| 5 开始转换 | `translate` → `solve_cn` → `solve_en` → `draw_figures` → `render_docx` |
| 6 搞好 | `verify_docx`（公式没转成 OMML 时先绕 `fix_formulas` 修一次） |
| 7 显示作业于页面上 | `show_result`（它的正文就是页面上显示的那份成品） |

两条不走主线的出口：不是作业 → `not_homework`；是作业但抽不出信息 → 也是 `not_homework`（不硬凑）。
PDF 里读不出题目 → `needs_input` 要材料。**注意每次运行都必然经过第 3 步的暂停**——
这是设计，不是意外。

证据：`tools/llmr/homework.smoke.cjs`（19 项，跑这份**真声明**而不是玩具图）；
`tools/llmr/uidemo.cjs` 把真 CSS 与真渲染函数喂样例数据出静态页，用无头 Edge 看成图。

---

## 17. 默认决策表（11 项，**已确认 → schema 冻结为 v1.0**）

> ✅ **用户已确认全部 11 项。`llmr.schema.json` 就此冻结为 v1.0。**
>
> 冻结的含义：结构约束不再变。若要改动，须三步——改本表 → 递增 schema 版本
> → 重跑 `auditcodes.cjs` 与全部测试（`selftest` / `exprtest` / `fuzztest` / `schemfuzz`）。


| # | 问题 | 默认 | 备注 |
|---|---|---|---|
| 1 | 四阶梯排序 | 采纳，含硬规则「能降级 1 的不许用级 2」 | |
| 2 | 级 2 形态 | 正文自由 + 尾部信号块 | |
| 3 | `output` | 作为 AMZ 第六字段 | SWF 亦六字段，对称 |
| 4 | 转码器归属 | 全局实现 + 局部声明 | 照 compaction |
| 5 | `CSP_AMZ` / `SCP` / `TCP` 命名 | 保留原称 | `extends` 已消化歧义 |
| 6 | 资料段可信输入 | **入库时查一次**，标记可信等级 | 外部默认不可信 |
| 7 | TWF 打扰平衡 | 默认请教用户；开关打开时**记录完整 TWF 供事后审** | 不阻断但留痕 |
| 8 | `refs` 标号 | **项目级序号 `int[]`**，宿主组装器 spawn 时解析内联 | |
| 9 | `step.from` | 指向**某个 AMZ 的完成态** | 任意会话位置暂不支持 |
| 10 | `ui.page` | **固定 `[AGT,WFW,DIR,WPC]`**，SWF 不可自定义；可选 `ui.panels` | |
| 11 | 级 1 求值 | 同一文法换命名空间 | 修掉 01 的自相矛盾 |

---

## 18. 未决问题（不阻塞阶段 0）

1. **分级误判的升降级逃生门**（小↔中↔大）
2. **DIR 的隔离边界**：它要看整个 SWF 库 + 任务本身，输入是什么？
3. **TWF 的寿命**：留存到用户"发现好用"那一刻；留存多久？晋升前遇相似任务会不会重造？
4. **UI 逃生门**：任务中途性质变了，怎么临时获得别的能力？
5. **信息段库的分段粒度**（成本模型的直接参数）
6. **预算闸门**：要区分"防单个 AMZ 失控"与"防 SWF 有 30 个 AMZ"

---

## 19. 设计原则（贯穿全文）

1. **固定优先**——SWF 固定、AMZ 固定、工具/权限静态绑定、UI 固定。
   LLMR 里唯一的"流动"是判定之前，唯一的例外是 TWF。
2. **隔离优先**——容器之间互不可见；隔离由"独立会话"结构性提供，不需额外机制。
3. **硬编码优先于自主**——能用确定性规则就别用模型；能用固定边就别用 tool use。
4. **避免干扰，对模型与用户同样成立**。
5. **可审查性**——能力是设计期的一张静态表，所以陌生 SWF 能被审。
   **前提是这张表完整**：任何"藏起来的能力"（例如嵌套子工作流）都会击穿审查。
6. **所有可复用实现全局注册，SWF/AMZ 只声明选用**（转码器 / UI / 工具 三者同构）。
7. **能力盒子里得真装东西**——没有专用工具的 AMZ 只有省钱，没有能力增益。
8. **规格的缺陷只能靠执行暴露**——阶段 0 先做校验器是划算的。
9. **边界纪律**——§1 的 ❌ 项是**承诺**，不是"暂时没做"。
   每加一项都合理，加起来就不是轻量了。

---

## 附录 A：声明格式速查

```yaml
swf:
  id: write_doc
  version: 1
  invoke:  { tags: [...], when: "...", args: [{name, type, required}] }
  defaults:{ model: ..., tools: [...] }
  amz:
    - $ref: amz/plan_outline          # 或直接写 AMZ 对象
    - id: write_word
      kind: exp                        # ttc | exp | pipe | step
      prompt: |
        ...
      tools: [docx_write]              # 能完成任务的最小集
      guards: []                       # 可选细粒度拒绝
      model: deepseek-v4-pro
      output:
        body: docx                     # free|text|docx|xlsx|pptx|json
        signal: { fields: {...}, encoder: self }   # 有分支出边时必需
  order:
    - { from: plan_outline, to: write_word, when: "signal.need_docx == true", level: 2, else: write_plain }
  terminal: [write_word, write_plain]
  ui: { page: [AGT, WFW, DIR, WPC], fallback: native }
```

**CSP_AMZ**：`{ kind, extends: amz/xxx, prompt }` —— 不得出现 `tools` / `guards` / `model`。

## 附录 B：配套文件

| 文件 | 地位 |
|---|---|
| `llmr.schema.json` | **结构规范（normative）** |
| `LLMR-声明格式规格-02.md` | 语法与校验细则（companion） |
| `verify/` | 设计验证夹具（非正式校验器） |
