# ACT 架构共识 · 第 02 版

> 替代 `ACT-设计评审-01.md`（那一版里的"冻结尾 / 可调尾"提案已作废）。
> 本文只记录**已确认**的设计，未定的集中在最后一节。
> "官方已有什么"的结论均来自 DSH 运行时实际契约查询，不是推测。

---

## 一、架构总览

```
用户
 │
 ▼
[分级]  小 ──▶ 常规直跑（ACT 零介入）
        中 ──▶ 判任务性质（编程/办公/…）──▶ 适应性质的 UI
        大 ──▶ 先与用户多轮对话判性质 ──▶ 适应性质的 UI
 │
 ▼
 AGT ──▶ DIR（SWF 之外的**特殊 AMZ**）
           │  职责：检查现有 SWF 够不够用
           ├─ 够  ──▶ 执行该 SWF
           └─ 不够/没有 ──▶ 造 TWF（**兜底**，默认须请教用户）
                              │
                              └─ 用户觉得好用 ──▶ 晋升为 SWF
 │
 ▼
 SWF / TWF = **硬编码的有向图**，边是"上一步→下一步"关系，条件也是硬编码的
 │
 ▼
 AMZ × N   （硬编码调用、高度固定、高度隔离的盒子）
```

## 二、AMZ（AgentMemoryZone）

**本质：一个用自然语言当参数的硬编码工具。**

```
AMZ:  f(资料标号, 诉求) ──▶ 成品
      内部：固定 SystemPrompt + 固定工具表 + 固定模型
      外部：什么都看不见
```

### 与 AP（agent preset）的区别

| | AP | AMZ |
|---|---|---|
| 性质 | 通用、可组合 | 固定、封闭、单一能力 |
| 工具面 | 宽 | 极窄（如"几乎只有 word 编辑器"） |
| 类比 | **岗位** | **工装夹具** |

### 四型

| 型 | 说明 |
|---|---|
| **ttc** | 无状态工具执行器。一进一出，轮间不继承记忆，高注意力，专做"半成品→成品"。 |
| **exp** | 固定领域专家。 |
| **pipe** | **转译器**（不是隔离器——隔离由独立会话结构性提供）。把 A 的输出重写成 B 能接住的形式。是一次真实 LLM 调用，要记账。 |
| **step** | 从已有模型端点复制，注入 TCP（工具变更）+ SCP（系统提示变更）。 |

> ⚠ **step 不省钱**：注入 SCP/TCP 会让请求从第 0 位分叉，继承来的历史**吃不到任何前缀缓存**。
> 它的价值是**信息保真**（省掉一次有损总结），不是便宜。DIR 的规划知识里必须写明。

### 调用方式

**硬编码调用**——模型手上**没有**"随便调一个盒子"的通用口子。

## 三、SWF（StableWorkFlow）

**人工设计的、面向某个/某类任务的调用方案**，五个字段：

| 字段 | 说明 |
|---|---|
| 调用方法 | 怎么被调起：名字、适用条件、入口参数 |
| SystemPrompt | 每个 AMZ 各自的系统提示 |
| tool available | 每个 AMZ 的工具表白名单 |
| 调用顺序 | AMZ 之间的执行次序 / 依赖图 |
| model 结构 | 哪一步用哪个模型 |

**不可变**——DIR **不修改** SWF，只能在"复用"和"另造 TWF"之间选。

### 分支：硬编码判断，不是 AI tool use

某几个**规划 AMZ 的输出可以激活** word 制造 AMZ——这是**上一步→下一步关系**，
**不是**模型自主决定调用哪个工具。

> 这是 ACT 与主流 agent 框架的**根本分歧**：别的框架在加自主性，ACT 在减。
> 收益：可预测（不跑偏）、省 token（不用把工具表塞进上下文、不用反复推理"该调什么"）、
> 可审计（整张图是数据，一眼看懂）、注意力集中（模型只干它那一步）。

### 截取方式（5 种）

| # | 方式 | DSH 现成机制 |
|---|---|---|
| ① | 只取输出 | 一次性 subagent 返回最终文本 |
| ② | 整个 | `sessions.fork(source)` 不带 boundary |
| ③ | 取到某断点 | `sessions.fork(source, **boundary**)` ✅ 原生 |
| ④ | 取某对话段 | ❌ **做不到**（fork 只能取前缀；`compactRegion` 是压成摘要） |
| ⑤ | 转译 / 总结 | pipe，或 `compaction` |

## 四、TWF（Temporary WorkFlow）

- **兜底设计**：SWF 无法使用时才走。
- DIR 的提示词**明确要求"实在不行，不要构建 TWF"**。
- 通常 DIR 决定改用 TWF 时**一定会请教用户**；另有开关决定是否允许 DIR **自行设计**。
- 用户可以把它**晋升为 SWF**。

## 五、DIR（Director）

- SWF **之外**的一个**特殊 AMZ**。
- 调用通常**只是用来检查**：现有 SWF 是否适合当前任务。
- 不适合 / 没有 → 构造 TWF。

## 六、记忆与标号

**标号 = 已经被转化为模型可读的信息段的序号。**

```
原始资料 ──[预处理/转换]──▶ 信息段库（编号）
                                  │ 标号
                                  ▼
AMZ:  固定 SystemPrompt + 按标号内联的段 + 诉求 ──▶ 成品
```

**这个设计的真正卖点不是省钱，是"避免干扰、注意力集中、反而提升性能"。**
长上下文会稀释注意力，无关内容不只是占位而是**主动伤害**输出质量。

---

## 七、复用 / 差异化 / 全新（承诺清单）

### A. 直接复用（现成，无需自造）

| 用途 | DSH 现成件 |
|---|---|
| 信息段引用机制 | **`ctx.spillStore.saveText() → SpillRef`**（天然的"存文本还引用"） |
| 资料摄取 | `attachments`（二进制/图片转模型可读）、`fileReferences`、`session-reference` |
| 一次性子容器执行通道 | DET 的 **`det_tct`**（已具备：一次性 + 档位 + 权限白名单 + 用完即焚） |
| AMZ 的 fresh / fork | `subagent`（fresh）/ `subagent_fork`（fork） |
| 截取 ③ | `sessions.fork(source, boundary)` |
| 截取 ⑤ | `compaction` / `compaction.compactRegion` |
| WPC（工具锁） | `tools.restrict(filter)` / `tools.guard(guard)` |
| SCP（系统提示变更） | `systemPrompt.section` / `getSectionOrder` |
| TCP（工具表变更） | `systemPrompt.tools(provider)` |
| SWF 的声明式人工资产格式 | `agentPresets`（可 `copy`/`read`/`select`，选定写进会话日志） |
| AGT 的 purpose | **`goal`**（`create_goal`/`get_goal`/`update_goal` + `ui-goal`） |
| WFW 面板的对话目录 | `dsh-client-ui-subagent`（"Subagent conversation catalog"） |
| UI 加性槽位 | `sidebar.panellist`（list, 风险 none）+ `main`（keyed, 仅占 `conversation`）+ `sidebar.right.pane.tab` + `conversation.view` |

> **UI 落点已确定**：不要 shadow `sidebar` / `sidebar.workspaces`（都是 `shadows-shipped-ui`，
> 且 `sidebar.workspaces` 就是**会话列表本体**，换掉它等于砍掉 DSH 主导航）。
> 正确姿势：`sidebar.panellist` 放图标 → `main` 的 keyed 面板承载 AGT/WFW/DIR/WPC。
> **`conversation.chat.node` 的 `user` 键已被 DET 占用**，ACT 别抢。

### B. 必须差异化（有官方件，但语义不同）

| 官方件 | 与 ACT 的差异 |
|---|---|
| `workflow` 工具 | 它是**脚本 + spawn-only + 无 per-stage prompt/工具表**；SWF 是**人工固定 + 硬编码条件边 + per-AMZ 固定 prompt/工具** |
| `subagent` 工具 | 它是**模型自主 tool use**；AMZ 是**硬编码 step-to-step**——**方向相反** |
| `compaction-basic` | 它是**被动、会话内**；ACT 是**主动、跨容器** |
| `agentTeams` 契约 | 概念几乎 1:1（见下），但**本机未装载** |

> **`agentTeams` 是最大的潜在复用/冲突点。** 契约里 `spawnTeammate(context:'fresh'\|'fork')`
> 正好对应 ttc·exp / step；task 的 `blockedBy` 就是"调用顺序"；`writeScopes` 就是 WPC；
> `remoteView()` 已经能直接喂前端。
> **但本机 `node_modules` 里没有任何 team 包，我也没有任何 team 工具可调**
> —— 它是"类型/契约层已定义、运行时未装载"。装 `@deepseek-ai/dsh-experimental-agent-team` 即可验证。

### C. 全新（DSH 没有，必须自己造）

1. **硬编码条件边求值器**——读 AMZ 的结构化输出 → 求值 → 激活下一条边
2. **信息段库**——原始资料 → 模型可读段 → 编号，且必须是**项目级（跨会话）**
3. **SWF 库 + TWF → SWF 晋升流程**
4. **DIR**（SWF 检查器 / TWF 构造器）
5. **任务分级入口**（小/中/大）
6. **按 SWF 切换的整体 UI**
7. **专用工具盒**——⚠ **DSH 里没有 Word / Excel / PPT 工具**。要造"写 word 的 AMZ"，
   得先造 docx 工具（python-docx / docx npm / Office COM 三选一）。

> **推论（重要）**：AMZ 的价值取决于世上有没有对应的专用工具。
> 没有工具，盒子就只是个"限制得很死的通用模型"，隔离只剩省钱、没有能力增益。
> **AMZ 库本质是能力盒库，盒子里得真装东西**——这部分工作量在"运行时"之外，且不小。

---

## 八、未决问题

### 高优先

1. **硬编码判断如何读自然语言输出？**
   判断是硬编码的，但输入是 AMZ 的自然语言输出，这是阻抗失配。
   → 需要约定：**哪些 AMZ 的输出是"判断输入"，它们的输出格式就必须固定（schema）**。
   DSH 的 workflow `agent(prompt, {schema})` 正好支持 schema 返回。

2. **TWF 路径的安全边界。**
   TWF 可以现场定义新盒子（新的 SystemPrompt + 工具表）——这意味着
   **"高度固定 / 高度隔离"在 TWF 路径上不存在，TWF 实质就是"普通 agent 模式"**。
   建议：**TWF 里的新盒子只能复用已有工具，不能发明新工具**（至少工具面可控）。

3. **TWF 路径的打扰成本。** TWF 是"实在不行"才用 → 大量边缘任务会撞上 TWF →
   每次都请教用户 → 打扰。开关打开（自行设计）后则不打扰，但也**不可审计**。

### 中优先

4. **SWF 内部的"规划 AMZ" 与 SWF 之外的 DIR 是两回事，对吧？**
   （"某几个规划 AMZ 的输出可以激活 word AMZ" ——这些规划 AMZ 在 SWF 内部）

5. **DIR 的隔离边界**：DIR 要看整个 SWF 库（名字/适用条件）+ 任务本身，
   比写 word 的盒子看得多得多。它的输入是什么？SWF 库目录是否也走"信息段 + 标号"？

6. **TWF 的寿命与晋升接口**：留存到用户"发现好用"那一刻；晋升是口头一句话还是要 UI 按钮？
   晋升前遇到相似任务，DIR 会不会重造一遍？

7. **信息段库的分段粒度**——段太大则隔离失效，段太小则标号爆炸。
   这是成本模型的直接参数。

8. **预算闸门**：目前没有。若做，要区分"防单个 AMZ 失控"和"防 SWF 有 30 个 AMZ"。

### 已闭环（存档备查）

- ~~SWF 的 "Stable" 含义~~ → **人工设计 + 不可变**
- ~~DIR 能改 SWF 吗~~ → **不能。DIR 只选或另造**
- ~~AMZ 是 preset 吗~~ → **不是。AMZ 是硬编码的封闭盒子**
- ~~AMZ 谁调用~~ → **SWF/TWF 硬编码调用，非模型 tool use**
- ~~分级谁做~~ → 模型自评，prompt 极干净、不给工具
