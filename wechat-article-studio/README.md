# 公众号文章工作台（证据优先核心切片）

> 当前 R01–R15 改造与实测状态见 [交付进度](artifacts/wechat-article-studio-delivery-progress.zh-CN.md)。正常入口是双击 `打开公众号工作台.cmd`；研究和写作使用真实 Codex CLI，检查只提供建议，不决定保存和 Word 下载资格。使用方法见 [START-HERE.md](START-HERE.md)。

这是从旧 `wechat-article-writer` 中独立出来的最小模块化内核。确定性合同和 orchestrator 不调用模型、不访问网络；外部能力由运行层的适配器和核验模块明确调用。它遵循以下文章生产顺序：

```text
Brief + StyleProfile → EvidencePacket → ArgumentMap → Draft → AnnotationSet → ReviewReport → WechatPackage
```

## 运行

需要 Node.js 20 或更高版本。Windows 用户双击 `打开公众号工作台.cmd`，无需输入地址；原 `START-WORKBENCH.cmd` 保留兼容。开发者手动命令如下：

```powershell
npm test
npm run check
npm run sample
npm start
```

在 Codex CLI 已登录的本机上，可运行真实 writer 评测：

```powershell
npm run eval:writer
```

该命令把历史评测题的 Brief、人工确认的 ArgumentMap 和已列明来源交给 `codex-cli`，输出 `evaluation/real-writer-runs.json`。日常使用不需要运行它。

启动器内部沿用本机回环服务和本项目 `data` 目录；测试环境中的 `WECHAT_STUDIO_PORT` / `WECHAT_STUDIO_DATA_DIR` 不会改变用户入口。样例数据只应通过明确的本地演示入口使用，不会混入真实任务。

实时研究由用户界面启动为后台任务，内部 endpoint 保留完整失败审计：

```text
POST /api/research/jobs（后台运行，浏览器查询任务状态；保留同步兼容接口 /api/research）
→ 本机 Codex CLI 联网研究
→ 接收可用结构化资料；每条论点绑定存在的来源，区分原文与整理要点
→ 转换为本项目 EvidencePacket（每个 source 显式标记 `sourceOrigin`：`realtime_research`、`user_provided` 或 `human_curated`）
→ 保存为本地 ResearchSession，可通过 `GET /api/research/:sessionId` 查看/重新载入
→ `GET /api/research/:sessionId/argument-map` 生成可直接写作的真实论点大纲
→ 编辑后的当前大纲随 `POST /api/research/:sessionId/draft` 一起采用
→ `POST /api/research/:sessionId/draft` 调用真实 `codex-cli` writer；provider 不可用、超时或结构化响应不合格时直接失败，不回退样例
→ `POST /api/workspace/review` 可选 AI 内容建议，不控制保存和下载
→ `POST /api/research/:sessionId/writer-request` 构造真实 writer 请求（仅展示，不自动调用模型）

实时研究失败时不会生成文章。当前交付路径使用 `POST /api/research/verified` 接收包含完整 `sources` 与 `claims` 的已核验资料；该路径不会伪装成 realtime research。工作台的最近一次明确保存版本通过 `GET /api/workspace/latest` 恢复，保存接口为 `POST /api/workspace`。
```

无可用来源/论点、错误引用或无效结果会被拒绝；个别不完整资料明确记为未采用，不撤销其他可用资料。独立导入模式不会伪装成联网研究。

ResearchSession 和最近一次明确保存的工作区写入项目 `data` 目录，服务重启后可恢复；它只保存 Brief、EvidencePacket 及用户明确保存的文章状态，不会把真实证据自动套到样例正文上。若服务或恢复校验失败，浏览器会保留本地副本并标记为未保存，不覆盖原内容。ArgumentMap 编辑器必须显式消费它。

历史 ArgumentMap 状态可读；新研究会话默认给出可用大纲，当前编辑在生成时直接采用。可以选择部分论点、增删、排序，也可跨章节引用同一论点；未知引用仍会报错。

`evidence-writer` 只保留为显式诊断 fixture，不是 live writer 的 fallback。真实写作使用 `codex-cli` 结构化 JSON；过渡段可无 claimIds 绑定，不强制覆盖所有论点，有引用时仍须属于当前大纲。

旧 writer 的 11 题运行和代理五项复核记录见 `evaluation/REAL-WRITER-MANUAL-REVIEW.md`，仅作历史材料，不是用户人工验收。当前改动及真实验证见 `evaluation/IMPROVEMENTS-20260922.md`。

历史 MOF 验收记录保留在 `evaluation/MOF-USER-ACCEPTANCE.md`，仅用于追溯当时的材料与审查结论，不是当前工作台的实时研究路径。当前实时研究不调用旧 Bridge；当前写作路径也只接受本机 Codex CLI 返回的结构化正文与段落—论点绑定。

## 设计约束

- 每个阶段输出不可变、有 `schemaVersion`、ID、hash 和父级 lineage 的 Artifact。
- 重要主张必须关联来源摘录；论点必须先于正文存在。
- 批注只针对一个确切 draft hash，修订生成新版本，不覆盖原稿。
- AnnotationSet 保留优先级和解决状态；未解决的 high 批注是提醒，不阻止保存和下载。
- ReviewReport 提供逻辑、证据、重复、文风和可读性建议；可选 AI 检查不产生审批凭据或交付门禁。
- 保存当前版本后可直接下载普通标题 `.docx`；有未保存修改时页面先保存再导出。
- 内部 claim/source token 只能存在于编辑阶段，离开工作台前必须清理。
- WechatPackage 同时提供清理过的 `bodyMarkdown` 和转义后的 `bodyHtml`，并保留来源台账供编辑复核。

## 模块边界

- `src/contracts/`：数据合同和不变量。
- `src/adapters/`：把外部研究和写作结果转换成核心合同；适配器失败时不污染主干。
- `src/orchestrator.mjs`：只负责串联合同，不持有 UI 状态。
- `src/server.mjs`：极简本地 HTTP 入口，后续只接 adapter。
- `public/`：最小线性工作区，不展示旧项目的十阶段画布。
- 旧项目保持不改，作为后续 adapter 的参考实现。
