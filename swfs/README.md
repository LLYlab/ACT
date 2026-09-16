# LLMR 的 SWF 库

这里放**真实使用的工作流**（不是 `verify/` 里那些测试夹具）。

---

## `homework.swf.json` — 作业成品流水线

> 来源：从对话「抓取PDF作业题目内容」里跑的**三遍实战流程**（ODE HW1 / 数学分析 HW1 / ODE HW2 双语版）提炼。
> 输入老师发的那段话（或作业单 PDF）→ 输出一份排版好看、公式可编辑的 Word 成品，**并直接在页面上显示出来**。

### 效果（用户要的 7 步）→ 声明（11 个节点）

| 效果 | 节点 |
|---|---|
| 1 判断是作业任务 | `judge_task` |
| 2 从中提取信息 | `extract_info` |
| 3 与用户确认作业 | `confirm_homework` → **暂停**，把抽到的信息摆出来问一句 |
| 4 自动读取作业 pdf | `read_pdf`（用户答完从这里接着走） |
| 5 开始转换 | `translate` → `solve_cn` → `solve_en` → `draw_figures` → `render_docx` |
| 6 搞好 | `verify_docx`（公式没成 OMML 就绕 `fix_formulas` 修一次） |
| 7 显示作业于页面上 | `show_result`（它的正文就是页面上显示的那份成品） |

```
judge_task ──[signal.is_homework == true]──▶ extract_info ──[signal.has_task == true]──▶ confirm_homework
     │ else                                        │ else                                    │ ⏸ 暂停
     ▼                                             ▼                                         ▼（恢复）
 not_homework                                   not_homework                            read_pdf
                                                                                            │ [problem_count > 0]
                                                                                            ▼
                                    translate ▶ solve_cn ▶ solve_en ▶ draw_figures ▶ render_docx
                                                                                        │ [omml_count > 0]
                                                                                        ▼
                                                                                    verify_docx ▶ show_result
                                    （任一步 run.status != 'ok' → abort；公式没转成 OMML → fix_formulas → verify_docx）
```

> **每次运行都必然经过第 3 步的暂停**——这是设计，不是意外。
> 「确认」用 `signal.ask` 表达，**不动 schema**；见 `LLMR-设计规格.md` §16.3。

| AMZ | 型 | 干什么 | 工具 |
|---|---|---|---|
| `judge_task` | exp | 先判断这是不是作业任务，并说出依据 | — |
| `not_homework` | exp | 不是作业 → 说清你看不出、以及需要给什么，**不硬套流程** | — |
| `extract_info` | exp | 抽出课程/题目/老师要求/文件路径，**没提到就写"未提到"** | `dlt_doc_read` |
| `confirm_homework` | exp | 把抽到的信息整理成确认卡，报 `ask` → 暂停等用户点头 | — |
| `read_pdf` | exp | 用户确认后自动读作业单，出题目清单 + 渲染原页 PNG | `dlt_doc_read` `dlt_doc_convert` |
| `needs_input` | exp | 没读出题目 → 告诉用户需要什么，**不猜题目** | — |
| `translate` | exp | 英文题面**逐句**翻译，符号与 (a)(b)(c) 不省 | — |
| `solve_cn` | exp | **可直接抄写**的中文详解，逐步推导不跳步 | — |
| `solve_en` | exp | 等价的完整英文详解 | — |
| `draw_figures` | ttc | 只给**确实需要**的题作图（分段函数/几何/点集） | `dlt_run` |
| `render_docx` | ttc | pandoc 转 docx，报 `omml_count` | `dlt_run` |
| `fix_formulas` | exp | 公式没成 OMML → 修 LaTeX 写法重转 | `dlt_run` |
| `verify_docx` | ttc | 核对段落/图/公式数，然后**清理中间产物** | `dlt_doc_read` `pwsh` |
| `show_result` | exp | 收尾，输出给用户看的最终成品（题目 / 中文解答 / English Solution / 交付物） | — |
| `abort` | exp | 报告哪一步失败、需要用户做什么，**不重试不跳过** | — |

### 关键点（这套方法真正"好看"的原因）

1. **公式必须是 Word 原生公式（OMML），不是纯文本符号。**
   做法：写含 LaTeX 的 Markdown → **pandoc** 转 docx。这样分式/积分/上下标/求和都按真实数学排版，
   **在 Word 里可直接编辑**。实战核对过：281 段落 / 20 图 / **579 个 OMML**。
2. **每题固定五件**：英文原文题面 + 中文翻译 + **原文截图** + 中文详解 + English detailed solution，
   需要时再加图。结构固定 → 看起来整齐。
3. **原文截图**保留教材原版式与符号，比重新打字更可信。
4. **收尾要核对**（段落/图/公式三项）再清理中间产物——否则容易像那次一样把上一份作业删掉。

### 写 SWF 的一条纪律：`tags` 是匹配用的关键词通道

新建 AGT 时，用户那句话是拿 `tags` / `when` / `title` 去**关键词匹配**的（§12.2）。
所以 **`tags` 要写全别名**：中文、英文、同义词、以及用户可能说的口语说法。

实测教训：这张 SWF 原来只写了 `["作业","排版","文档"]`，
结果**最真实的输入全部匹配失败**——

| 输入 | 修前 | 修后 |
|---|---|---|
| `MATH2201.01 Homework 2：§7.1 八题、§7.2 八题，合计 100 分` | ❌ 不确定 | ✅ |
| `Homework 2 §7.1 P1,5,10,12,16,18,22,24` | ❌ 不确定 | ✅ |
| `帮我把这份 PDF 的题目翻译一下并解答` | ❌ 不确定 | ✅ |
| `写一份产品需求文档`（**不该命中**） | ⚠ 误配 | ✅ 正确拒绝 |

老师发的作业单本来就是「英文课程号 + 章节号 + 题号」——补上 `homework / assignment / PDF / 题解 / 习题 / 翻译` 后 10/10 命中；
同时把过于宽泛的 `文档` 换成 `习题`，误配也消失了。

> **匹配器的保守是对的**（宁可说"不确定"也不假匹配）；**该修的是元数据**。

### 校验结果

```
$ node tools/validator/validate.cjs swfs/homework.swf.json
结果: 通过（0 错误 / 4 警告）
```

4 条警告都是 **`LLMR-W201`**：`draw_figures` / `render_docx` / `fix_formulas` / `verify_docx`
带 `dlt_run` / `pwsh`，属于 **exec 类工具**。

> **这是校验器在正确工作，不是误报。** 这几个盒子继承了整个会话的 sandbox，
> 不是"窄口 CSP 安全容器"。要收紧的话有两条路：给它们**换更专用的工具**
> （比如只暴露 `pandoc_convert` 而不是整个 `dlt_run`），或给它们加 `guards` 限定参数。

### 实测（echo 后端，不花钱）

```
$ node tools/llmr/homework.smoke.cjs
通过 19 / 失败 0

第一次运行：judge_task → extract_info → confirm_homework        （暂停）
恢复运行：  read_pdf → translate → solve_cn → solve_en → draw_figures
            → render_docx → verify_docx → show_result            （completed）
合起来 11 个节点 = 7 步效果

不是作业：   judge_task → not_homework
抽不出信息： judge_task → extract_info → not_homework
题数 0：     …read_pdf → needs_input
OMML 0：     …render_docx → fix_formulas → verify_docx → show_result
```

同一份声明也能在 WebUI 里点着走完（真点了：暂停卡 → 确认，继续 → 成品页）。
`tools/llmr/uidemo.cjs` 另出一份静态页，供无头 Edge 出图比对版式。
