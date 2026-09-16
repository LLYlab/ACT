# LLMR 设计评审 · 第一轮

> 本文是聊天窗口里渲染丢失的那条回复的完整重建版。
> 对象：LLMR（Agent Character Tool）第二轮设计——AMZ / SWF / 四型 AMZ / 5 种截取。
> 所有"官方已有什么"的结论都来自 DSH 运行时实际契约查询，不是推测。

---

## 一、复述与对齐

| 你的编号 | 对应我问的问题 | 你的答案 |
|---|---|---|
| 1 | AMZ 是什么 | 分四型：**ttc / exp / pipe / step** |
| 2 | AMZ 之间传什么 | 目的不同 → 截取方式不同，共 5 种 |
| 3 | SWF 的 "Stable" 含义 | "你应该看懂了" ← **实际上没答，见第三节问题 1** |
| 4 | 分级谁做 | 模型自评；prompt 要求快速决定、极干净、**不给工具** |
| 5 | 适应环境的 UI | 按 SWF 不同，整体 UI 不同 |
| 6 | 中/大型差别 | 大型需要**反复规划、不断试错** |
| 7 | 预算闸门 | 暂时没有；或"单个 AMZ 调用达某值就强制截断" |
| 8 | 谁能改 SWF | 可以改，但中途能改的**只有 DIR** |
| 9 | SWF 用什么跑 | 让我自己想 |

### 四型 AMZ（我的理解）

| 型 | 我的理解 |
|---|---|
| **ttc** | 无状态工具执行器。一进一出，轮与轮之间不继承记忆，高注意力，专做"半成品 → 成品"的简单操作。 |
| **exp** | 固定领域专家。 |
| **pipe** | 让 A 的输出能进 B 的脑子。 |
| **step** | 从某个已有模型端点复制，再注入 TCP（工具变更）+ SCP（系统提示变更）。 |

### 5 种截取

① 只取输出　② 整个　③ 取到某断点　④ 取某对话段　⑤ 转译/总结后

### SWF（我的理解）

由若干 AMZ 构成的执行图——每个 AMZ 带 **目的 + 工具表 + 截取方式**；DIR 建图，DIR 改图。

---

## 二、Q9：SWF 该用什么跑（你让我自己想的）

**结论：不要另造调度器。SWF 应该是一份声明式数据，执行交给按角色配置的现成运行时。**

三条我查证过的事实：

### 事实 A：DSH 已经定义了一套几乎 1:1 对应的官方契约 —— `agentTeams`

```
spawnTeammate(caller, {name, description, prompt, context: 'fresh'|'fork', provider})
createTask   (caller, {subject, description, blockedBy?, writeScopes?})
updateTask   (caller, {taskId, expectedRevision, action: 'claim'|'set_dependencies'|'complete'|...})
sendMessage  (caller, {target, content})          // durable peer message
waitForChange(caller, timeoutMs, signal)
interrupt    (caller, targetName)
remoteView   (agent) -> { members, tasks }        // 已经是 Remote API
```

对照你的设计：

| 你的概念 | 官方对应 |
|---|---|
| AMZ | `TeamMember`（teammate） |
| **ttc / exp** | `context: 'fresh'` |
| **step** | `context: 'fork'` |
| **SWF 的"调用步骤"** | task 的 `blockedBy` 依赖图 + `ready` 派生 |
| AGT / DIR | `role: 'lead'` |
| **WPC** | `writeScopes` + provider 作用域工具限制 |
| **pipe** | `sendMessage` |
| WFW 面板 | `remoteView()`，已经暴露给浏览器 |

> **⚠ 这条查证的边界必须说清楚**：本机 `node_modules` 里**没有任何 team 包**，我也**没有任何 team 工具可调**
> （`Tool.listTools` 里没有 `spawn_teammate` / `create_task`）。`agentTeams` 只出现在
> `dsh-tool-cordis` 的 Inspect 里 —— 也就是说它是**类型/契约层已定义、运行时未装载**。
> 要确认只需把 `@deepseek-ai/dsh-experimental-agent-team` 装进 web profile 重启即可。

**所以结论不是"别做了"，而是**：LLMR 的 SWF/AMZ 要么直接复用这个 seam，要么必须明确讲清差异——
否则是在重造一个官方正在建的轮子。

### 事实 B：截取方式 ①②③ 有原生机制，④ 没有

| 截取方式 | 现成机制 |
|---|---|
| ① 只取输出 | 一次性 subagent 返回最终文本（现有默认行为） |
| ② 整个 | `sessions.fork(source)` 不带 boundary |
| ③ 取到某断点 | `sessions.fork(source, **boundary**)` —— **原生支持** |
| ④ 取某对话段 | **做不到**。`dsh-subagent-fork-in-process` 的定义是 "seeded with a **prefix** of the parent's log"，**只能取前缀**。勉强能凑的是 `compaction.compactRegion(start, end, agent)`，但那是**压成摘要**，不是原样取段。 |
| ⑤ 转译/总结 | pipe（一次 LLM 调用），或 `compaction` |

### 事实 C：`step` 的缓存矛盾是真的

`step` 要注入 SCP + TCP。但 DSH 标准 preset 里白纸黑字写着：fork 省略模型选择，就是为了
"**the inherited history remains eligible for KV Cache reuse**"。

而**系统提示和工具表在请求里排在对话之前**。你改了 SCP/TCP，前缀从第 0 位就分叉，
**继承来的历史一个 token 的缓存都吃不到**。

→ **`step` 的价值是信息保真**（省掉一次有损总结），**不是省钱**。
这一点必须写进 DIR 的规划知识里，否则 DIR 会以为 step 便宜而滥用它。

### 我的建议

SWF = 一份**可持久化的 JSON 声明**（AMZ 列表 + 依赖边 + 每个 AMZ 的截取方式/工具表/模型）；
执行交给现有运行时。**不要把编排逻辑写死在代码里**——否则"反复规划、不断试错"（你的第 6 条）
每改一次图就得重新发布代码。

---

## 三、三个会翻车的地方

### 问题 1：第 3 条没答到点子上 —— "Stable" 到底稳在哪？

你第 6 条说大型要"反复规划、不断试错"，第 8 条说"可以改，只是只有 DIR 能改"。
这两条**已经否掉了**"一次规划、全程不变"这个读法。所以 Stable 只剩两种可能：

- **(a) 对象稳定**：SWF 是有身份、有版本、可持久化的一等对象，DIR 修订它并留下版本——
  不是模型脑子里一闪而过的计划。
- **(b) 模板稳定**：同类任务复用同一张已沉淀的 SWF，下次直接套，省掉规划成本。

**这两个都要的话，就要 SWF 库 + 版本管理 + 复用匹配规则，工作量差一个量级。**

### 问题 2：`pipe` 的真身是"翻译器"，不是"隔离器"

你给 pipe 的理由是"避免不同 prompt 的 AMZ 之间出现 system prompt 污染，或思考角度不符"。

但——**如果 AMZ 是独立子代理，它们本来就看不到彼此的 system prompt，污染在结构上不可能发生。**
隔离是"独立会话"免费送的，不需要 pipe。

所以 pipe 真正解决的只有后半句：**把 A 的输出重写成 B 能接住的形式（视角转换）**。

这个区分决定成本：若是隔离，pipe 什么都不用做；若是转译，pipe 是一次真实 LLM 调用。
**DIR 必须能分辨这两种，否则会为不存在的污染付钱。**

### 问题 3：第 7 条的闸门位置

"单个 AMZ 调用达某值就强制截断"保护的是**"一个 AMZ 失控烧钱"**，
完全不保护**"SWF 里有 30 个 AMZ"**。这是两种不同的保护，你要哪个？还是都要？

---

## 四、还需要你定四件事

1. **Q2 选 (a) 还是 (b) 还是都要？**（SWF 稳在对象，还是稳在模板）
2. **AMZ 是独立子代理会话，对吧？** 我从 ttc 的"没有遗传记忆"和 step 的"copy 之前模型端点"
   推断是的，但你没直说。**这一条决定后面所有实现。**
3. **要不要复用 `agentTeams`？** 复用 = 整个运行时白拿（成员生命周期、任务板、依赖图、
   消息、中断、Remote UI 数据源）；不复用 = 完全自由，但要自己写这些。
4. **4 型 AMZ × 5 种截取 = 20 种组合，你说"目的不同截取不同"，那实际是一张映射表。**
   这张表是你心里已经有了、还是 DIR 每次自己推？**如果要 DIR 每次推，(b) 模板沉淀就没意义了。**

---

## 附：一个小笔误

上一版聊天里我写过「**AWF**/WFW 面板」，是 **WFW** 打错了。
