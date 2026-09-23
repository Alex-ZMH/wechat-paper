# 核心流程修复与验收记录（2026-09-04）

## 判定

**待验收版本**。已核实的“已核验资料模式”核心流程可以工作；实时研究没有在本轮完成来源核验，因此不能把整条链路称为可交付，也没有把失败改写成成功。

## 发布前复核补充（2026-09-04）

- 修复了实时研究失败/取消后主按钮仍显示“开始查资料”的歧义；现在显示“重试实时研究”，并保留失败原因与资料输入。
- 在独立目录 `data/acceptance-20260904-run3`、固定入口 `http://127.0.0.1:43210` 用真实 Chromium 重新走通已核验资料模式：新凹凸棒石选题 → 资料预览/选择 → 大纲编辑确认 → 真实结构化 writer → 正文编辑与段落证据 → 高优先级批注 → 保存/刷新/重启 → 重新审查 → 解决批注 → 再审查 → 当前版本 Word 下载。结果记录见 [fresh-browser-flow-run3.json](acceptance-20260904/fresh-browser-flow-run3.json)，共 12 项通过，未载入旧 MOF 工作区。
- 对上述下载的 `凹凸棒石进电池：三条研究路线，应用边界要分清（编辑版）_审阅稿.docx` 用 Microsoft Word COM 实际打开并导出 PDF，再用 Poppler 渲染 3 页逐页检查。COM 结果：3 页、3 个 DOI 超链接、所有非空段落微软雅黑、正文 12 磅/18 磅行距/24 磅首行缩进、参考文献悬挂缩进、无内部字段；手工编辑文字已出现在 Word。渲染页位于 `acceptance-20260904/fresh-word-render/fresh-page-1.png` 至 `fresh-page-3.png`。
- 以上是代理执行的验收证据，不等于用户人工签字；实时研究仍未返回完整 `realtime_research` EvidencePacket，因此版本判定仍为“待验收版本”。
- 默认数据目录的旧 v1 MOF 快照仍在 `data/workspace.json` 及 `.legacy-backup.json`，因含早期验收标记被列为“早期保存文章（需检查）”；`/api/workspace/latest` 不会自动载入它。run3 只在隔离目录保存验收文章，未写入默认工作区。

## 本轮实际修改

| 部分 | 修复 | 复用模块 |
|---|---|---|
| 研究 | 原生 `http(s)` 请求、有界异步 job、阶段进度、归属检查、匹配取消和 busy 释放；profile/provider 回执和完整 trace | `bridge-research.mjs`、`research-jobs.mjs` |
| 选题隔离 | 每篇文章独立 workspace；换题新建分支；响应按 workspace/brief/epoch 校验；旧工作区和旧数据备份 | `workspace-store.mjs`、`app.js` |
| 已核验资料 | 文件预览、来源/主张完整性检查、明确选择；多份或题目不符时不自动取第一份 | `/api/research/verified`、`app.js` |
| 写作 | 只调用真实 Codex writer；结构化 draft、段落 claim 绑定和证据追溯；writer 失败无样例回退 | `codex-writer.mjs`、现有 Draft/Review 合同 |
| 批注与保存 | open high 批注跨审查、保存、刷新、重启保留；真实解决动作；内容修改生成 revision；保存失败回滚持久化但保留页面编辑 | `workspace-service.mjs`、`workspace-store.mjs`、`app.js` |
| 导出 | 服务端按当前保存版本生成通用 DOCX；服务器核验版本、审查门槛和人工确认，不信任前端 `approved` | `src/export/word-exporter.py`、`word-exporter.mjs` |
| writer 启动 | Windows 从 PATH 解析真实 `codex.exe`，显式不存在路径 fail-closed，禁止 shell shim 静默 fallback | `codex-executable.mjs`、`codex-writer.mjs` |

## 凹凸棒石实时研究追踪

主题为“凹凸棒石在新能源领域面临的挑战与实际应用”。请求约 5 ms 发出，旧 Bridge 健康状态在约 283 ms 后确认进入 `research_retrieval`；检索持续到约 644,808 ms（10 分 44.8 秒），随后进入 `research_audit`。达到工作台固定的 900,000 ms（15 分钟）有界上限时，仍没有响应、结构化结果或可冻结 EvidencePacket。匹配 `clientRunId` 的取消返回 HTTP 200 `cancel_requested`；约 107 ms 后健康状态为 `busy=false/stage=idle`，释放已验证。

此前全局 Node `fetch` 约 305 秒报 `TypeError: fetch failed`，而 Bridge 仍 busy；这属于客户端隐式 response-header 断链，不是上游 HTTP 504。新传输层绕过了该断链，但暴露出旧 Bridge 同步检索/审源本身超过 15 分钟。旧 Bridge 没有 clientRunId 级阶段日志、检索 URL、资料读取事件或异步结果接口，模型进程内部停顿原因因此不可观测，不能臆测。完整 trace、取消和失败记录见：

- [research-trace-atp-studio-atp-20260904-real-01.jsonl](research-trace-atp-studio-atp-20260904-real-01.jsonl)
- [research-trace-atp-studio-atp-20260904-real-01.md](research-trace-atp-studio-atp-20260904-real-01.md)
- [research-trace-atp-root-cause.md](research-trace-atp-root-cause.md)

因此：服务在线、请求发出、取消成功都只证明各自步骤；本次实时研究和“由该研究生成文章”均未通过。最小后续接入点是让旧 Bridge 提供带 clientRunId 的异步 job/result 与阶段日志；本轮没有修改旧项目。

## 真实浏览器操作证据

在隔离目录 `data/acceptance-20260904-run1` 中实际操作了：填写新选题 → 真实研究并取消 → 明确导入已核验资料 → 查看来源 → 编辑确认四节大纲 → 真实 Codex writer 生成结构化初稿 → 修改正文 → 点击段落查看证据 → 添加高优先级批注 → 保存 → 刷新/重启恢复 → 解决批注 → 重新审查 → 保存 → 下载当前 Word。

自动化 Chromium 还独立验证了：保存失败时输入不丢失且刷新恢复；新题研究失败不显示 MOF 旧内容；多份资料要求明确选择和题目确认；writer 启动失败不生成文章且可重试；切换已保存文章时选题、资料、大纲和正文同步；移动端长文本框按内容增高；页面无内部字段和脚本错误。测试故意注入的网络/写作失败标记为注入失败，不冒充真实上游故障。

证据文件：

- [browser-checks.json](acceptance-20260904/browser-checks.json)
- [browser-failure-checks.json](acceptance-20260904/browser-failure-checks.json)
- [acceptance-workspace-gates-20260904.json](acceptance-workspace-gates-20260904.json)
- [acceptance-workspace-gates-20260904.audit.jsonl](acceptance-workspace-gates-20260904.audit.jsonl)

五条浏览器注释均已处理：开始查资料现在显示真实失败/取消进度；2—4 步在缺少资料、大纲或文章时显示自然的前置条件；选题目的长输入框随内容增高，不使用内部滚动条。

## Word 视觉验收

下载文件：[凹凸棒石进入电池材料：三条研究路线与一道产业化边界_审阅稿.docx](acceptance-20260904/凹凸棒石进入电池材料：三条研究路线与一道产业化边界_审阅稿.docx)。用 Microsoft Word COM 实际打开并导出 PDF，再用 Poppler 渲染三页逐页查看：标题和小标题使用真正标题样式且无首行缩进；正文为微软雅黑 12 磅、1.5 倍行距、真正两字符首行缩进；参考文献为悬挂缩进；3 个 DOI 链接可点击；正文和文末没有开发字段。COM 检查结果为 3 页、3 个链接、0 个非微软雅黑段落、0 个读者字段泄漏。渲染页图位于 `acceptance-20260904/word-render/page-1.png` 至 `page-3.png`。

## 测试边界

`npm test`：67/67 通过；`npm run check`：通过。测试和代理浏览器操作不是用户人工验收；本轮没有重新运行 11 篇泛化评测。MultiPost 保持“待接通”，没有显示或测试发布按钮。默认旧 MOF 工作区未被测试覆盖，早期含验收文字的数据仍保留并有备份。
