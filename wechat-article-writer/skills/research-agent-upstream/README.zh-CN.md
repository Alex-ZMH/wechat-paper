# research-agent

> An Agent / Claude / Codebuddy Skill —— 一个三层多 Agent 研究流水线，负责规划、并行委派、综合撰写与引用标注。

[English](./README.md) · [SKILL.md](./SKILL.md)

---

## 这是什么

`research-agent` **不是**一个可运行的程序，而是一组生产级的系统提示词（system prompts）。把它们挂到任何支持子 Agent 调用的宿主（Claude sub-agents、Codebuddy，或兼容的 agentic runtime）上，就能得到一个完整的研究系统：

1. **规划** 研究策略，并决定需要多少个并行工作者。
2. **委派** 事实收集任务给 1–20 个并行运行的研究子 Agent。
3. **综合** 所有返回结果，撰写一份 Markdown 报告。
4. **引用** 为报告加上引用标签，且**一字不改**原文。

流水线对"谁干什么"有严格分工 —— 主导 Agent 从不亲自做一线研究，子 Agent 从不撰写最终报告，引用 Agent 从不改动正文。

## 架构

```
用户查询
    ↓
主导 Agent          ── 规划 + 委派
    ↓  run_blocking_subagent（并行，1–20 个）
研究子 Agent        ── OODA 循环、web_search / web_fetch、内部工具
    ↓  complete_task
主导 Agent          ── 综合撰写 report.md（不含参考文献列表）
    ↓
引用 Agent          ── 用 <exact_text_with_citation> 包裹并加引用
    ↓
research-<topic>/report.md（+ 附属资源）
```

## 三个 Agent

### 1. 主导 Agent —— `lead-agent-prompt.md`

掌管**策略与综合**。职责：

- 分解用户查询，判定属于 **深度优先 / 广度优先 / 直接型** 中的哪一类。
- 决定子 Agent 数量（见下表）。
- 为每个子 Agent 写极其明确的任务简报（目标、期望格式、起点来源、可用工具、范围边界）。
- 通过 `run_blocking_subagent` 并行部署子 Agent。
- 将所有子 Agent 返回的报告综合为最终 Markdown。**主导 Agent 亲自撰写报告，绝不委派。**
- 输出保存到独立文件夹 `research-<topic>/`，内含 `report.md` 以及任何附属资源（CSV、脚本、图片）。

**子 Agent 数量参考**

| 查询复杂度 | 子 Agent 数量 |
| --- | --- |
| 简单 / 直接型 | 1 |
| 标准 | 2–3 |
| 中等 | 3–5 |
| 高复杂度 | 5–10（硬上限 20） |

### 2. 研究子 Agent —— `subagent-prompt.md`

掌管**一线研究**。在严格的**工具调用预算**内执行 OODA 循环（观察 → 定向 → 决策 → 行动）：

- 简单任务：< 5 次调用
- 中等：约 5–10 次
- 困难：约 10–15 次
- **绝对上限：20 次调用 / 约 100 个来源** —— 超出则子 Agent 被终止。

核心模式：`web_search` 发现，`web_fetch` 读全文。内部工具（Google Drive、Gmail、GCal、Slack、Asana、GitHub、repl……）在可用且相关时**必须**使用 —— 它们出现就意味着用户有意启用。汇报只通过 `complete_task`。

### 3. 引用 Agent —— `citations-agent-prompt.md`

只管**引用标注**，仅此一项。接收 `<synthesized_text>` 标签内的报告，返回 `<exact_text_with_citation>` 标签内加好引用的版本。铁则：

- 零内容改动，零空白字符改动。
- 仅对来源直接支持的陈述添加引用。
- 优先在句末添加引用；不把句子切碎、不放相邻冗余引用。
- 输出与原文本不一致 = 直接拒收。

## 查询类型速查

| 类型 | 形态 | 示例 |
| --- | --- | --- |
| **深度优先** | 一个问题，多个角度 | "2008 年金融危机的真正原因是什么？" |
| **广度优先** | 多个独立子问题 | "比较欧盟各国的税收体系" |
| **直接型** | 单一聚焦查找 | "东京目前的人口是多少？" |

## 来源质量策略

**优先**：原始来源、带具体日期/数字的近期数据、官方报告、同行评审文献、政府门户网站。

**标记或回避**：未来时态的推测（"可能"、"也许"）、搭配匿名来源的被动语态、营销语言、伪装成事实的财务预测、丢失出处的新闻聚合器、未经证实的报道。

来源冲突时，按时效性、与其他证据的一致性、来源质量排序；若无法调和，将冲突上报给主导 Agent，而不是自行做选择。

## 如何使用这些提示词

本仓库提供的是**提示词**，不是代码。典型接入方式：

1. 把 `lead-agent-prompt.md` 作为编排模型的 system prompt。对它暴露 `run_blocking_subagent(prompt)` 工具和 `complete_task(report)` 工具。
2. 每次 `run_blocking_subagent` 调用，启动一个 worker，其 system prompt 为 `subagent-prompt.md`，可用工具包含 `web_search` 和 `web_fetch`（以及任意内部连接器）。
3. 主导 Agent 生成综合 Markdown 后，放入 `<synthesized_text>…</synthesized_text>`，交给一个加载了 `citations-agent-prompt.md` 的模型。
4. 将最终的 `<exact_text_with_citation>` 内容持久化到 `research-<topic>/report.md`。

提示词中含有 Go 模板占位符 `{{.CurrentDate}}`，宿主需在发送前替换为实际日期。

## 安装

通过 [skills.sh](https://skills.sh) 安装（支持 Claude Code / Cursor / Codex / CodeBuddy / OpenCode 等 50+ agent）：

```bash
# 全局安装（所有项目可用）
npx skills add dimayip/research-agent -g -a claude-code

# 项目级安装（随项目提交，团队共享）
npx skills add dimayip/research-agent -a codebuddy

# 只看仓库里有哪些 skill，不安装
npx skills add dimayip/research-agent --list
```

或手动安装：把整个仓库 clone/放到 agent 的 skills 目录下 ——
例如 `~/.claude/skills/research-agent/` 或 `.codebuddy/skills/research-agent/` ——
宿主下次启动时会自动识别。

兼容 [Agent Skills Specification](https://agentskills.io)。

## 仓库结构

```
research-agent/
├── SKILL.md                      # 含 frontmatter（name + description）的 skill 入口
├── lead-agent-prompt.md          # 主导 Agent 系统提示词
├── subagent-prompt.md            # 研究子 Agent 系统提示词
├── citations-agent-prompt.md     # 引用 Agent 系统提示词
├── README.md                     # 英文版
├── README.zh-CN.md               # 本文件
└── LICENSE                       # MIT
```

## 常见错误

| 错误 | 修正 |
| --- | --- |
| 主导 Agent 自己做一线研究 | 委派出去；主导只负责规划和综合 |
| 子 Agent 反复使用相同查询 | 变换措辞；无结果时适当拓宽范围 |
| 简单查询部署过多子 Agent | 匹配复杂度；从 1 个开始 |
| 引用 Agent 改动报告内容 | 只加标签；内容零改动 |
| 子 Agent 超出工具调用预算 | 15 次处停手，立刻 `complete_task` |
| 最终报告出现"参考文献"章节 | 报告不设参考文献；引用由引用 Agent 处理 |

## 许可

[MIT](./LICENSE)
