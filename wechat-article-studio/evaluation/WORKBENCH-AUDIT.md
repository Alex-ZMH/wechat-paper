# 工作台现状审计（2026-09-04）

范围：`wechat-article-studio`，入口 `http://127.0.0.1:43210`。旧项目未修改。

| 功能 | 状态 | 复现与证据 | 根因/后续 |
| --- | --- | --- | --- |
| 自由输入选题、读者、目的、长度、文风 | 可用 | 浏览器填写 MOF 选题并提交表单 | 已接入 Brief；无只读样例输入 |
| 实时研究 | 部分可用（真实失败可见） | `POST /api/research` 真实调用 Bridge；健康检查为已认证/空闲，但请求在等待窗口后返回 `research_timeout`（HTTP 504） | Bridge 研究任务超过当前等待窗口；未保存不完整资料。可重试或使用已核验资料模式；未把失败当成功 |
| 已核验资料模式 | 可用 | 载入 `evaluation/real-writer-runs.json`，服务返回 `verified_materials`，后续大纲、写作、审查、保存和 Word 均可继续 | 仅接受有完整来源和可追溯主张的结构化资料；内部记录为 human_curated |
| 步骤导航 | 可用 | 未满足前置条件时点击步骤 2–4，顶部显示“请先完成资料获取/确认大纲/生成并审查文章/保存当前修改” | 过去使用原生 disabled 导致无反馈；现改为可点击的阻断提示 |
| 来源与段落证据 | 可用 | 生成文章后点击段落，右侧显示来源标题、摘录、日期和链接 | 复用现有 claim/source 映射，不显示内部 JSON |
| 大纲编辑与确认 | 可用 | 已核验资料模式编辑论点后确认，进入写作阶段 | 未确认大纲不能请求 writer |
| 结构化 Writer | 可用（依赖真实 Codex） | 已完成一次真实 Codex writer 结构化返回；错误、超时、非 JSON、段落无依据均 fail-closed | Codex CLI 未就绪时只显示失败原因，不生成样例 |
| 正文编辑 | 可用 | 浏览器修改段落后保存状态变为“有未保存修改”，不会被 writer 自动覆盖 | 保存前不允许进入正式审查/下载 |
| 批注与重新审查 | 可用 | 添加批注后生成新 revision，保留旧稿；解决状态进入 review | 高优先级未解决批注阻断正式交付 |
| 保存、刷新、重启恢复 | 可用 | `POST /api/workspace` 写入本地工作区；刷新和重启服务后 `GET /api/workspace/latest` 恢复文章、模式、批注和 revision | 使用 `data/workspace.json` 与 `data/research-sessions.json`，不引入登录或云同步 |
| Word 下载 | 可用 | `/api/export/word` 生成当前编辑版本 `.docx`；已用 Microsoft Word COM 打开并渲染 PDF 检查版面 | Word 为唯一用户下载格式；审查未通过时文件名为审阅稿 |
| MultiPost/微信发布 | 未开发且待接通 | 工作台无发布 adapter/路由；`43210/api/multipost/health` 为 404。旧 Bridge 配置未启用，MultiPost Desktop 19528 无监听，健康检查 503 | 不显示发布按钮；界面明确“微信发布模块待接通”，保留 Word 交付 |
| 图片、封面、多平台、长期记忆、协作 | 未开发 | 页面无入口，TASKS.md 保持待完成 | 本版本冻结 |

## 已执行检查

- `npm test`：42/42 通过。
- `npm run check`：通过。
- 工作台 `/api/health`：200。
- Bridge `/health`：200，已认证、CLI 可用；实时研究请求仍真实返回 504 超时，超时后 Bridge 恢复 idle。
- 浏览器实操：自由输入、已核验资料续写、段落证据、批注历史、审查页、自动增高文本框、保存恢复均已检查。
- Word：当前编辑版本已生成，实际打开并渲染检查字体、标题、首行缩进、行距、链接、参考文献和开发字段清理。
