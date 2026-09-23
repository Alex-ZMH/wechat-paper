# Content Desk 当前框架（v34 本地候选；v32 为正式部署基线）

Content Desk 是面向个人知识创作者的可组合非虚构内容工作台。工业研发、科研、商业、科普和个人观点只是可选配方，不再把工业流程写作当成所有内容的默认前提。

本文件只描述已经接入运行时的能力。样例、规划、离线评分或页面占位不等于功能可用。

## 1. 产品边界

当前主链负责：任务简报、资料与范文分离、Codex CLI 双阶段写作、人工修改与批注、不可变文字定稿、外部图片登记，以及通过本机 MultiPost Desktop 进行预填和人工确认发送。

当前不负责：生成图片、登录内容平台、替用户确认发布结果、把纯文字稿冒充完整图文成品。图片由其他项目产生；没有封面时，本文始终停留在 `assets_pending`，不能创建发送任务。

v30 额外负责把用户明确授权的本机 MD/TXT 建立为可追溯语料快照。它不抓网页、不监控目录、不接收任意路径或 URL，也不声称支持尚未完成安全解析的 PDF/DOCX/HTML/ZIP/OCR。

v31 候选在 v30 数据与工作流兼容层上增加模型路由、两次隔离审核与 99 分服务端门禁。v32 再增加独立的主题证据调研节点：研究员实时搜索公开来源，来源审计员逐条检查来源和主张，Bridge 验证并冻结 `content-desk.evidence-packet.v1`。v33 本地候选增加手改 revision 与模型协同编辑环：手改明确追加保存；讨论不返回候选；局部改写和排版只返回绑定当前 revision/hash 的候选，必须由用户采用并再次保存。v34 把高级编排从三栏壳重构为全宽横向主流程，并把节点配置和实际阶段输出放在画布下方。v32 仍是正式部署基线。

页面提供两种视图，但共用同一套状态和 Bridge：

- 快速写作：面向日常使用，按任务、事实、范文、原稿、工作稿、批注和文字定稿组织。
- 高级编排：首屏是可缩放的从左到右主链；点击节点后在画布下方修改配置并查看该阶段实际内容。可选 Skill 可调整顺序；核心写作、复审、质量门禁、工作稿提交与人工编辑节点不能绕过。

## 2. 一条真实主链

```text
任务简报
  + 事实材料（只授权事实）
  + 风格范文（只学习表达）
  + 外部原稿（本次修改对象）
  + 可选主题证据调研
       └─ 实时搜索研究员 → 独立来源审计员 → 冻结 Evidence Packet
  + 可选 Skill / DNA / 写作记忆
             ↓
         Codex CLI + 已选 Writer 写作
             ↓
         Reviewer A 修订与评分
             ↓
         冻结候选稿内容哈希
             ↓
         Reviewer B 隔离审核
             ↓
       99 分未校准编辑门禁
        ├─ review_required → 保留候选工作稿，继续人工处理
        └─ approved        → 可由用户标记文字定稿
                                  ↓
                   Bridge 冻结不可变文字快照
                                  ↓
                  assets_pending（等待外部图片）
                                  ↓
                 登记封面/正文图片，冻结 delivery manifest
                                  ↓
             MultiPost autoSubmit:false 预填到选定账号
                                  ↓
                       人工刷新并检查 ready
                                  ↓
                  勾选确认 + 显式点击“确认发送”
                                  ↓
                 轮询逐账号回执；只重试失败账号
```

浏览器不能直接把编辑框正文发给 MultiPost。发送请求只能引用 Bridge 已冻结的 `deliveryManifestId`；Bridge 再从本机持久化清单恢复标题、正文和资产。

## 3. 内容对象与不可变边界

| 对象 | 标识 | 可变性 | 作用 |
|---|---|---|---|
| 任务简报 | 当前浏览器草稿 | 可编辑 | 主题、读者、目的、渠道、体裁、长度和领域 |
| 证据包 | `packetId + packetHash` | Bridge 端不可变 | 公开来源、短摘录、claim-to-source 台账、不确定性和独立来源审计回执 |
| 工作稿 | `documentId + revisionId + contentHash` | 可生成新 revision | 用户手改、批注和重生成的权威对象 |
| 编辑候选 | `baseRevisionId + baseContentHash` | 临时、未入库 | 模型局部改写或排版结果；基线变化即拒绝采用 |
| 语料暂存包 | `packageId` | 确认前可追加预声明文件 | 只保存服务端 ID、清洗后的文件名、权利声明、哈希与解析状态；上传失败不进入语料库 |
| 语料快照 | `snapshotId + manifestHash` | 不可变 | 绑定已确认来源回执，作为 Writing/Academic DNA job 的唯一 v30 语料输入 |
| 文字定稿 | `manifestId` | 不可变 | 通过 `revisionId + contentHash` 比较并交换后冻结；状态为 `assets_pending` |
| 资产包 | `content-desk.asset-bundle.v1` | 作为输入一次提交 | 封面必需，正文图片可选；v26 只接受本机 Windows 盘符绝对文件路径 |
| 交付清单 | `deliveryManifestId` | 不可变 | 绑定文字清单、内容哈希和资产哈希；状态为 `ready_to_send` |
| MultiPost 任务 | `deliveryId + groupId` | 只追加事件 | 保存预填、ready、提交、成功、失败和重试回执 |

Bridge 登记资产时检查普通文件、限制大小、复制到 ContentDesk 受控快照目录并计算 SHA-256；交付清单与 MultiPost 使用冻结副本，而不是源文件路径。HTTP(S)、UNC、相对路径及 `blob:`/`data:`/`file:` 在 v26 拒绝，避免登记后远端或源文件被替换。

工作稿发生新修改不会反写旧文字定稿；重新补图不会覆盖旧交付清单；发送失败不会清空文章或回退内容版本。默认导出只接受当前 document 的最新已批准 revision；旧版本必须使用明确 `manifestId` 读取，不能被误当成当前成稿。

## 4. Bridge 运行边界

`start-local-workbench.ps1` 启动：

```text
Studio / Next.js       127.0.0.1:43126
Codex CLI Bridge       127.0.0.1:43127
MultiPost Desktop API  127.0.0.1:19528（由用户在 MultiPost 中启用）
```

公开 Sites 从 v28 起只托管启动说明页，不再向 `127.0.0.1` 发起健康检查或写作请求。真实操作面只在 `http://127.0.0.1:43127/` 或 `http://localhost:43127/` 提供，与 Bridge 同源。写作、记忆、DNA、内容存储、资产清单和 MultiPost 代理都留在用户电脑；Bridge 未启动、Codex CLI 未认证、版本标记不一致或 MultiPost API 未启用时，本地页必须显示真实阻断状态。

v32 继续使用统一 `generationGate`：执行面、CLI 健康、Bridge 忙状态、待恢复任务、主题/外部原稿、模型 readiness、DNA 就绪和证据包状态只在一处判定。接入主题证据调研后，缺包、运行中、输入已变、审计失败或关键事实仍无支持都会指向 `skill:topic-evidence-research` 并阻断写作。

快速页和高级页由同一 `content-desk.workflow-graph.v1` 语义图驱动。`skillChain` 只作为 v28 回滚兼容投影；画布坐标、缩放和选中状态不进入执行计划。每次生成冻结 `executionPlanHash + inputSnapshotHash`，后台结果只有同时匹配这两个哈希才可写回，防止用户在运行中改稿、换节点或删批注后被旧结果覆盖。

核心执行脊柱固定为：输入冻结 → 可选 `evidence_packet` → 白名单写作/DNA Skill → Codex writer → 独立 reviewer → quality gate → 原子工作稿提交。调研节点固定在所有风格节点之前，回执为 `packet_frozen`；浏览器只能提交 server-owned `packetId + packetHash`，不能用原始 JSON 冒充已审计资料。`review_required` 表示候选工作稿已原子提交但质量门结果未通过，不等于失败，也不能直接标记文字定稿。

写作画布只读取 Bridge 的真实阶段：`validating → writing → quality_review → quality_gate → committing → idle/failed`。复审阶段的 `cli_failed` 或 `invalid_cli_output` 最多启动一次新的独立 reviewer；取消和质量门禁失败不重试。最终失败必须保留上游错误分类与处理建议，同时保持已提交工作稿不变。

主要接口分组：

- 写作：`POST /v1/content`、`POST /v1/cancel`、`GET/DELETE /v1/runs/:clientRunId`
- 手改与协同编辑：`POST /v2/documents/manual`、`POST /v2/documents/:id/revisions/manual`、`POST /v1/editor-dialogue`
- 主题调研：`POST /v1/research`、`GET /v1/research/packets/:packetId`；停止复用精确 `POST /v1/cancel`
- DNA 状态与 legacy 入口：`GET /v1/dna`、`POST /v1/dna/corpus`、`POST /v1/dna/distill`
- DNA 持久任务：`POST /v1/dna/jobs`、`GET/DELETE /v1/dna/jobs/:jobId`、`POST /v1/dna/jobs/:jobId/cancel|resume`
- v30 语料包：`POST /v1/corpus-packages`、`PUT /v1/corpus-packages/:packageId/files/:fileId`、`GET /v1/corpus-packages/:packageId`、`POST /v1/corpus-packages/:packageId/confirm`
- 记忆：`GET/DELETE /v1/memory`
- 文字版本：文档、revision、finalize 与 export manifest 接口
- MultiPost 连接：`/v1/integrations/multipost/config|health|accounts|platforms`
- 资产：`POST /v1/exports/:manifestId/assets`、`GET /v1/delivery-manifests/:deliveryManifestId`
- 分发：`POST/GET /v1/integrations/multipost/deliveries`、单任务刷新、显式提交和失败目标重试

Codex CLI 模型运行没有应用层墙钟截止时间；停止只能由用户针对当前 `clientRunId` 显式触发。健康检查和本机 HTTP 探测仍使用短超时，以免页面永久等待不可用服务。

## 5. 输入、Skill 与记忆

三类长文本不可混用：

- 事实材料：允许进入论证的事实、数据、来源和限制。
- 风格范文：只允许抽取结构、节奏和语言习惯；不得迁移其中的事实、数字、观点、引语或来源。
- 外部原稿：本次改写对象；`source_rewrite` 会直接调用 Codex，并把原稿数字、日期、型号和其他内在事实作为受保护边界。“仅导入为工作稿”不调用模型，两条路径必须明确区分。

通用内容默认空 Skill 图。工业写作、Writing DNA、Academic Writing DNA 都必须由用户显式接入；Bridge 按语义图顺序校验并回传 `skillUsage.chain` 与逐节点 workflow receipt。两个 DNA 使用原始蒸馏 Skill 和原始产物，不以沉淀规则、摘要画像或本地模板代替。

v30 的文件语料先提交只含 metadata 的 manifest，再逐文件以 raw bytes 上传到 Bridge 生成的受控 ID。Bridge 使用 fatal UTF-8 解码、大小/数量门禁和 SHA-256 检查；网页响应只返回清洗文件名、字节数、字符数、解析器版本、哈希和问题码，不返回绝对路径或正文。用户点击确认后才生成不可变 corpus snapshot；DNA job 固定引用 `corpusSnapshotId`，并继续复用 v29 的持久任务执行器。权利声明只记录 `self_authored/permission_granted/licensed/public_domain`，系统不替用户作版权判断。

长期记忆只在质量门禁通过且用户明确采用后写入：

- 作者偏好：来自被模型确认为 `applied` 的全局表达/结构批注。
- 流程经验：只记录任务类型、目标长度、审校结果等确定性元数据。

事实、数字、引文、来源、正文和范文片段不得进入长期记忆。记忆逐条可见、可删除；本轮指令和证据始终高于 DNA 与长期记忆。

## 6. MultiPost 接入结构

v25 只提供本机连接、账号和平台能力检查；v26 才增加有边界的发送流程。

安全规则：

- Token 只来自进程环境或 `%LOCALAPPDATA%\ContentDesk\multipost-config.v1.json`，不进入响应、日志、localStorage、草稿、版本或回执。
- 上游地址固定为本机 `127.0.0.1:19528`，不允许把 Bridge 变成任意地址代理。
- 只选择 `isLoggedIn === true` 且平台声明支持 `ARTICLE` 的账号。
- 建立任务时由 Bridge 强制写入 `autoSubmit:false`。
- 预填和最终提交是两个独立用户动作；轮询只发生在用户刷新单个任务时，不后台静默发布。
- 提交必须同时匹配 `deliveryId`、`groupId`、`deliveryManifestId`，所有目标均为 `ready`，且请求携带 `confirm:true`。
- 失败重试只针对明确失败的单个账号；不得全量自动重试。

本机 MultiPost 当前若未启用外部 API、没有登录账号或 Token 错误，工作台只能显示诊断，不能进入可发送状态。

## 7. 本机持久化

| 文件 | 内容 |
|---|---|
| `%LOCALAPPDATA%\ContentDesk\content-store.v2.json` | 文档、revision、文字定稿和 export manifest |
| `%LOCALAPPDATA%\ContentDesk\writing-memory.v1.json` | 受控作者偏好与流程经验 |
| `%LOCALAPPDATA%\ContentDesk\multipost-config.v1.json` | 本机 MultiPost 配置；不返回 Token |
| `%LOCALAPPDATA%\ContentDesk\multipost-deliveries.v1.json` | 交付清单与发送事件账本；不保存 Token |
| `%LOCALAPPDATA%\ContentDesk\delivery-assets\` | 按交付清单冻结的本机图片副本及内容哈希 |
| `%LOCALAPPDATA%\ContentDesk\dna-jobs.v1.json` | DNA 持久任务状态、阶段、错误和不可变产物清单；不保存原文 |
| `%LOCALAPPDATA%\ContentDesk\corpus-packages\` | v30 staging、不可变 source receipts 与 corpus snapshots；磁盘目录只用服务端 ID，网页响应和日志不暴露绝对路径 |
| `%LOCALAPPDATA%\ContentDesk\evidence-packets\` | v32 经来源审计后冻结的主题证据包；浏览器只持有摘要、ID 与哈希 |

浏览器 localStorage 只保存非敏感工作区草稿和最近回执索引。清理浏览器草稿不能删除 Bridge 的内容历史、DNA、记忆、交付清单或发送回执。

## 8. 版本隔离

- v23：旧公开版本，冻结为 legacy，不再作为新状态来源。
- v24：通用可组合非虚构工作台与 v2 内容存储；独立回滚点。
- v25：MultiPost 只读连接层；独立回滚点。
- v26：外部资产登记和两阶段发送；曾替换公开 v23，现保留为 v27 的回滚点。
- v27：复审错误保真、一次独立重试、画布阶段同步和人工修改差异假阳性修复；v28 发布后仅作唯一紧急回退基线。
- v28：公开启动页/本地执行面分离，CLI 路径自愈，统一生成门禁，真实 `source_rewrite` 模式，DNA 不就绪原因可见。
- v29：单一 typed workflow graph、执行与输入双哈希 CAS、可恢复 DNA jobs、多 DNA 使用回执和逐节点执行回执；v28 保留为唯一紧急回退基线。
- v30：本地授权 MD/TXT 语料包、严格解析、不可变 corpus snapshot 和 snapshot-bound DNA job；发布后 v29 是唯一紧急回退基线。
- v31：Writer/Reviewer 模型路由、Reviewer A/B 隔离审核、99 分 strict finalize 和 `humanizer-zh` 固定来源；保留为历史候选，不单独部署。
- v32：主题证据调研、来源审计和冻结 Evidence Packet；当前正式公开启动页基线，本机执行面保持数据与模型隔离。
- v33：手改正文追加式 revision、恢复上一保存版本、模型讨论/选区改写/重新排版候选；当前仅为本地候选，未替换 v32 正式部署基线。

旧的重复构建和临时 staging 先移入 `releases/legacy/` 隔离。不得删除正文、DNA、写作记忆、内容 manifest、delivery manifest 或发送回执。Sites 中“保存版本”和“部署公开版本”是两个动作，不能混称已经发布。

## 9. 发布门禁与候选状态

v31 以根目录 `HARNESS.md`、`harness/incidents-v31.json` 和 `releases/v31.json` 为唯一候选门禁。真实 Luna 内容 smoke 已完成，但候选仍为 `review_required` 且暴露了长度和 15 分钟级时延问题；只要人工金标校准、真实浏览器批注/外稿改写链路、Humanizer 执行回执或 claim-to-source 账本仍为空，v31 就保持 `local_candidate`，不能保存/部署为公开新版。

v30 的发布门禁（只能在验证完成后勾选）：

1. Studio test、TypeScript、lint、build 全部通过。
2. Bridge test 和语法检查全部通过。
3. 真实 Codex CLI 至少完成一次随机通用主题的初稿；手改、批注和重生成链路不得覆盖用户修改。
4. 资产登记、账号能力筛选、`autoSubmit:false` 预填、ready 门禁、CAS 确认、提交回执和失败目标重试有确定性测试。
5. 测试不得调用本机真实 MultiPost publish/submit/retry；真实发送必须等用户启用 API、登录账号并在界面明确确认。
6. Studio、Bridge、启动器、发布 manifest 的 v30 标记一致。
7. 公开 Sites 只显示启动页；本地同源页完成真实生成、停止、改写、批注与回流验证。
8. 保存 Sites v30 后再执行公开部署，并检查部署健康状态。
9. typed graph 的核心链不可绕过，布局变化不改变执行哈希；DNA job 的取消、刷新恢复、重启中断和显式恢复均有回执与测试。
10. 至少用两个自有合成 MD/TXT 在真实浏览器完成暂存、raw 上传、解析检查、确认快照和 DNA job 建立；未知权利、错误 UTF-8、未确认快照和路径穿越均被服务端拒绝。
