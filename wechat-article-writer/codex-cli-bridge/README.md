# 本机 Codex CLI 桥接

这个小服务把面向个人知识创作者的非虚构内容请求转给本机已经登录的 Codex CLI；工业研发只是显式连接的可选 Skill：

- `initial_generation`：从工作台 brief 与 v2 task 写一版可编辑非虚构正文。
- `annotation_regeneration`：以用户当前编辑稿为权威底稿，只消费仍 active 的批注，并逐条回执。
- `source_rewrite`：把外部原稿作为权威事实与观点边界，真实运行 writer + reviewer；无需伪造批注，也不会把风格范文当事实来源。

它只监听 `127.0.0.1:43127`，没有通用 shell 或任意 prompt；MultiPost 仅通过下文列出的本机、白名单两阶段接口工作，提交发布仍必须人工确认。服务端串行处理 Codex 请求；上一请求运行时，下一请求收到 `409 busy`。所有 Codex 失败都返回脱敏错误，不会把 prompt、草稿、stderr、环境变量或凭据写入日志。

## 启动

在本目录运行：

```powershell
npm start
```

Windows 隐藏启动（仍然是当前用户权限）：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-hidden.ps1
```

要同时启动本地工作台，可在仓库根目录双击 `start-local-workbench.cmd`（或运行同目录的 `start-local-workbench.ps1`）。脚本只启动/复用两个明确的 loopback 进程：工作台生产服务 `127.0.0.1:43126` 和桥接 `127.0.0.1:43127`，桥接只反代这个固定上游，最后用系统默认浏览器打开同源入口 `http://127.0.0.1:43127/`。窗口隐藏但浏览器可见；端口若被未知进程占用会报错退出，不会杀掉或替换它。

服务启动前请先在同一个 Windows 用户下完成 `codex login`。桥接会优先使用 `CODEX_BIN`，然后按可执行文件更新时间发现 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`，最后才尝试 PATH 中的 `codex.exe`；缓存文件缺失、mtime/size 变化、兼容性探测失败或登录状态异常时会强制重新发现一次，不再永久黏住已经删除的旧版本。当前候选构建标识为 `codex-bridge.v40-20260903`，产品版本为 `0.40.0`；健康检查会返回精确 `bridgeVersion`、`productVersion`、`buildMarker`、`execReady`、CLI 版本、`authenticated`、`reason/code`、`rediscovered`、`busy` 和当前阶段 `stage`（只表示本机 CLI 可用，不返回凭据），反代页面带有同值的 `X-Bridge-Build`。`start-hidden.ps1` 仅在版本、所有权和源码时间戳都匹配时复用健康实例；源码比进程新时会在空闲状态下精确替换该 Bridge，遇到忙实例或未知占用则报错退出，不会杀未知进程。

质量复审若首次发生 `cli_failed` 或 `invalid_cli_output`，Bridge 会再启动一次新的独立 reviewer；取消、超时和质量门禁失败不会重试。最终失败仍兼容返回 `review_failed`，但 `diagnostics.failure` 会给出经过白名单过滤的上游错误类型、分类和处理建议，且不会返回或覆盖文章正文。

## MultiPost Desktop（v26，素材回填与两阶段发送）

v26 在 v25 的本机连接检查之上增加“素材回填 → 创建待发送任务 → 人工确认提交 → 按目标轮询/重试”流程。默认地址固定为 `http://127.0.0.1:19528`，Bridge 只接受 loopback 与该预期端口，避免把配置变成 SSRF 代理。发送状态与文字内容分离；文字 Manifest 仍不可变地保持 `assets_pending`，素材回填会创建新的不可变 delivery manifest，不会原地改写文字。

接口：

- `GET/POST/DELETE /v1/integrations/multipost/config`：这是 Content Desk 自己的本地配置端点，不是 MultiPost API；用于读取状态、保存或删除本地 Token。响应只返回 `configured`、`tokenPresent`、`source` 和 `baseUrl`，永远不回显 Token。
- `GET /v1/integrations/multipost/health`：不带 Token 调用 Desktop `/v1/health`。
- `GET /v1/integrations/multipost/accounts`、`/platforms`：由 Bridge 在本地读取 Token 后代理，并删除响应中的凭据字段。
- `GET /v1/exports/:manifestId`：读取指定不可变文字清单；`POST /v1/exports/:manifestId/assets` 接收 `content-desk.asset-bundle.v1`（必须有 `cover`，`images` 可选），v26 只接受 Windows 盘符绝对文件路径字符串。Bridge 会在登记时 stat 普通文件、校验扩展名和大小、计算 SHA-256，并复制到 `%LOCALAPPDATA%/ContentDesk/delivery-assets/<deliveryManifestId>/` 作为只读发送快照；原始文字清单不会被改写。
- `GET /v1/delivery-manifests/:deliveryManifestId`：读取素材回填后生成的不可变 `content-desk.delivery-manifest.v1`，其中 `assets` 是冻结副本路径，`assetRecords` 保存 `kind=local_file`、字节数、mtime 和 SHA-256。发送前会重新校验快照；同一文字清单与 `assetsHash` 重复登记会返回原 ID，不会重复创建。
- `GET/POST /v1/integrations/multipost/deliveries`：列出或创建发送任务。创建只接受 `content-desk.delivery-request.v1` 的 `deliveryManifestId`、`accountIds`、`contentType: "ARTICLE"`；Bridge 固定向上游发送 `autoSubmit:false`，不接受正文或 `autoSubmit` 字段。
- `GET /v1/integrations/multipost/deliveries/:deliveryId`：读取任务并按用户请求轮询上游状态；目标状态统一映射为 `pending/filling/ready/success/failed/cancelled`，混合终态返回 `partial_failed` 或 `partial_cancelled`。`POST .../:deliveryId/submit` 必须提交 `confirm:true`、`expectedGroupId`、`expectedDeliveryManifestId`；失败目标通过 `POST .../:deliveryId/targets/:accountId/retry` 单独重试（只接受两个 `expected*` 字段，不接受 `confirm`）。若首次预填收到确定的 4xx 且没有 `groupId`，必须显式调用 `POST .../:deliveryId/retry-prefill` 并提交 `{ "confirm": true, "expectedDeliveryManifestId": "…" }` 创建新 attempt，旧失败事件仍保留；网络、超时、5xx 或格式不确定会分别进入 `prefill_unknown`、`submit_unknown` 或 `target_retry_unknown`，禁止重复调用，只能先在 MultiPost 中人工核对后刷新。

封面和插图在 v26 必须是 Windows 盘符绝对路径（例如 `C:\\work\\cover.jpg`），且扩展名为 png/jpg/jpeg/webp/gif/avif、单文件不超过 50 MiB、总计不超过 200 MiB。UNC、POSIX/相对路径、HTTP(S)、对象 URL、`file:`、`blob:`、`data:` 明确拒绝；HTTP(S) 素材冻结下载另列后续版本，不能以“外部引用”冒充不可变清单。素材回填不会修改原文字清单。

使用前请在 MultiPost Desktop 的“设置 → External API”中明确开启 API，并确认 Desktop 正在运行；只有官方健康响应 `name: "multipost-desktop-api"` 才会被视为已连接。Token 优先从进程环境变量 `MULTIPOST_DESKTOP_TOKEN` 读取（适合一次性或 CI 进程），其次从 `%LOCALAPPDATA%\ContentDesk\multipost-config.v1.json` 读取。Windows 配置文件以当前用户可读的明文保存，安全边界是该用户 profile 的 ACL；请勿把文件同步、提交或备份到共享位置，环境变量优先可避免落盘。文件写入使用临时文件原子替换；Token 不会写入前端、运行记录、内容清单、delivery store 或日志。API 未启用、桌面应用未启动、Token 无效、无账号、账号未登录、平台不支持 ARTICLE、缺少封面或未人工确认提交时，Bridge 返回稳定状态码与错误码并阻断发送，不会伪装成已发布。

`POST /v1/dna/corpus` 接收 `{ "mode": "writing"|"academic", "text": "…" }`，只把经过长度校验的文本写入固定 `writing-dna-workspace/*/raw/reference-<sha256>.md`，重复内容幂等，并返回真实 `/v1/dna` 状态；它不会伪造 DNA 就绪，新增 raw 后仍需运行原始蒸馏。`POST /v1/cancel` 只作用于当前本机 Bridge 实例的 Codex 子进程树：内容任务必须提供并匹配 `clientRunId`（缺失或不匹配均为 `409 run_mismatch`），无 client id 的 DNA 蒸馏才允许空 ID 取消；空闲返回 `idle`，提交点之前成功请求返回 `cancel_requested`，原内容请求最终以 `409 cancelled` 结束且不覆盖稿件。质量门禁通过后，Bridge 会在写入记忆或成功账本前同步进入 `committing` 提交段；此时同一 `clientRunId` 的停止请求返回 `200 { status: "committing", code: "run_committing" }`，不会设置取消标记或杀进程，任务随后只能完成 `succeeded`。

写作、复审和 DNA 蒸馏的 Codex 子进程不设置墙钟超时，会一直等待 CLI 退出；只有 CLI 探测、登录状态和固定工作台反代保留短超时。客户端应使用请求取消或自己的等待策略，桥接不会因长文自动覆盖当前稿。

```powershell
Invoke-RestMethod http://127.0.0.1:43127/health
```

官方 `codex exec` 使用 stdin 接收受控提示词、`--ephemeral`、`--sandbox read-only`、`--output-schema` 和临时 `-o` 文件，并通过 `-c approval_policy=never` 关闭交互审批（该版本的审批是全局参数，必须放在 `exec` 子命令前）。工作目录是项目根目录；服务不向 Codex 请求写入文件。健康检查还会实际运行一次 `codex exec --help` 兼容性探测，避免只因 `--version` 成功就误报可用。

## 请求与响应

`POST /v1/content` 只接受 JSON 字段 `mode`、`brief`、`previousGeneratedDraft`、`currentDraft`、`annotations`、`voiceProfile`、`protectedFacts`、`versionId`（或 `draftVersionId`）、`targetLength`、`humanize`、可选结构化 `researchPacket`、可选 `referenceText`（最多 20,000 字符）、兼容字段 `dnaMode`（`none`、`writing`、`academic`，默认 `none`）、可选 `skillChain` 和可选 `clientRunId`。`skillChain` 必须是 0–4 个不重复的 `topic-evidence-research`、`industrial-ai-wechat-research-writing`、`writing-dna`、`academic-writing-dna`，按数组顺序组合；不传时保持旧行为（工业技能加 `dnaMode` 对应的 DNA），传 `[]` 时不加载可选 Skill。两个 DNA 都会逐个检查真实就绪状态，任一未就绪在调用模型前返回 `409 dna_not_ready`。技能冲突只允许后置技能覆盖写法、结构或节奏，任何技能不能授权事实。成功响应追加 Bridge 计算的 `skillUsage`（`schemaVersion=content-desk.skill-usage.v1`、按请求顺序的 `chain` 和 writer/reviewer/qualityGate 完成状态）及兼容 `dnaUsage`（取链中最后一个 DNA）；模型不能伪造。`referenceText` 只是用户提供的范文，桥接会将它独立传给两阶段 Codex；模型只能学习表达、结构和节奏，不能把范文内容当事实、数字、引文、URL、来源或观点授权。正文目标长度可调，范围为 300–20,000 字，不把 500 字当作硬限制。调研格式若未提供合法 packet/来源材料，正文必须标注“未做外部调研/待补证据”，不得伪装已检索。

### v2 非虚构内容契约

v2 请求在相同的 `/v1/content` 入口提交 `schemaVersion: "content-desk.request.v2"` 与 `task: { kind, domain, genre, channel, purpose }`。`task` 五个字段由客户端定义，不受工业产品枚举限制；未提供 `skillChain` 时默认为空，不会因为主题或领域自动加载工业 Skill。只有显式连接 `industrial-ai-wechat-research-writing` 才注入工业过程规则；Writing/Academic DNA 也必须显式连接或指定对应 `dnaMode`。两阶段提示词遵循 `nonfiction-editorial.v1`，只要求通用的事实边界、批注覆盖、作者声音和移动端清晰度检查。

v2 低于 95 分但不存在事实、批注覆盖或用户手改硬错误时，响应会保留候选正文并返回 `status: "review_required"`；服务端不会把候选稿伪装成成稿，也不会因为反模板扣分而丢弃正文。返回中的 `documentId`、`revisionId`、`contentHash`、`contentStatus`、`deliveryStatus` 与 `runStatus` 由 Bridge 生成，模型不能伪造。

内容文档持久化在 `%LOCALAPPDATA%/ContentDesk/content-store.v2.json`（可用 `CODEX_BRIDGE_CONTENT_STORE_PATH` 注入测试目录）。每次生成追加不可变 revision；内容状态和运行状态分离。可用以下接口读取与定稿：

```text
GET  /v2/content/:documentId
POST /v2/content/:documentId/finalize        body: { revisionId, contentHash }
GET  /v2/content/:documentId/export-manifest[?manifestId=...]
```

`finalize` 是用户审批动作，必须同时提交当前最新 `revisionId` 与 `contentHash`；任一来自旧页面的值都会返回 `409 stale_revision` 或 `409 stale_hash`，避免旧页误批新稿。审批会追加不可变文字快照并将状态置为 `assets_pending`、`blockingReasons: ["assets_missing"]`；本项目不生成图片，图片和其他素材由外部项目补齐。`export-manifest` 在文字未定稿时返回 `409 text_not_finalized`，定稿后返回包含标题、正文、hash、revision 和外部素材策略的不可变导出清单；历史快照可用其 `manifestId` 通过查询参数再次读取，不会因新 revision 被清除。为兼容旧前端，同样支持 `/v1/content/:documentId/...` 路径；这只影响文档端点，不改变旧请求的 v1 生成契约。

当请求带合法 `clientRunId`（1–128 位字母、数字、下划线或连字符）时，Bridge 会在私有 `codex-cli-bridge/.runtime/runs/` 以临时文件加 rename 保存运行状态。`GET /v1/runs/:clientRunId` 返回 `content-desk.run.v1` envelope，`status` 为 `running`、`succeeded` 或 `failed`；终态分别包含 `result` 或脱敏 `error`。客户端消费后可用 `DELETE /v1/runs/:clientRunId` 删除单条记录。最多保留最近 20 条，未知标识返回 `404 run_not_found`，未知的未来 `/v1/*` 路径不会落入静态工作台代理。刷新浏览器后可用同一 `clientRunId` 重取成功结果或失败节点（writing 映射 `codex-writer`，quality_review/quality_gate 映射 `quality-review`，DNA 未就绪映射对应 Skill id）；若 Bridge 重启前仍有 `running` 记录，下次读取会终结为 `failed`/`run_interrupted`，不会永久轮询。

服务端会先跑写作阶段，再跑独立质量复审阶段。复审检查准确性、批注覆盖、人类语气、手机可读性和六项工业专业检查；如果复审结构化失败、`qualityReview.passed=false`、issues 非空、任一检查为 false、服务端事实/反 AI 门禁失败，接口统一返回脱敏 `502`，不返回可覆盖稿。低风险 unresolved 只会合并进 `diagnostics.remainingFlags` 并返回 `succeeded_with_warnings`。

提示词固定要求：只使用用户输入的事实；不编造跑分、客户、案例、来源或亲历；说明跨站点共因与局部因、MES/QMS/SCADA/设备/批次/变更数据、事件主键、聚类/关联/时间窗口/IS-IS NOT、证据链、8D/FMEA/CAPA/控制计划、试点指标、权限和审计边界。用户手改、数字、日期、URL、专名和 `protectedFacts` 不能被静默改回。无论生成还是重生成，最终仍需人工核对和审批，桥接不负责发布。

### 写作记忆

桥接在本机保存一份跨浏览器来源共享的 JSON 记忆文件：Windows 默认 `%LOCALAPPDATA%\ContentDesk\writing-memory.v1.json`；非 Windows 默认 `$XDG_STATE_HOME/ContentDesk/writing-memory.v1.json`（未设置时为 `~/.local/state/ContentDesk/writing-memory.v1.json`）。可用 `CODEX_BRIDGE_MEMORY_PATH` 指定测试或本机路径。写入采用同目录临时文件加 rename，并串行化并发更新。

`GET /v1/memory` 返回 `{ schemaVersion, memories, experiences }`；`DELETE /v1/memory?id=...` 可删除偏好或经验。公开 `POST /v1/memory` 始终返回 `405`，偏好只能在一次 `/v1/content` 成功通过门禁并且用户随后确认文字定稿时，由桥接依据批注回执内部提升，客户端不能伪造。v2 的 `review_required` 候选稿永远不会写入长期偏好或经验；定稿前候选只随不可变 revision 保存。偏好 kind 严格限定为“表达调整”或“结构建议”；事实、证据、引用、来源、数字、日期、参数、型号、链接和明显客户事实/数据结论均不会写入。API 允许受限工作台 Origin 的 `DELETE` CORS 预检。

`/v1/content` 的成功响应是桥接 API envelope：除 Codex 结构化结果外，Bridge 会追加 `memoryPromotion: { promotedAnnotationIds: string[] }`。列表只包含本轮实际 upsert 成功且被保留的 `applied` 安全批注；初稿、无提升、事实污染或记忆写入失败时为空。该字段由 Bridge 在响应前计算，Codex 输出 schema 不包含它，模型不能伪造。

只有用户明确选择“记住”，且批注在一次成功通过两阶段质量门禁后得到 `applied` 回执，随后对应 revision 被用户确认定稿，桥接才会将它提升到 `memories`。`partially_applied`、`blocked`、事实/证据批注和 `review_required` 候选不会进入长期记忆。定稿时桥接额外保存一条不含正文的 `experience` 元数据摘要（format、tone、targetLength、score、是否有范文、活动批注数、是否手改、门禁结果），最多 12 条，不把模型正文或回执当作偏好；重复提交同一 revision 不会重复增加确认次数。

下一次 `/v1/content` 由桥接自动读取两区并在两阶段的 prompt `input_data.writingMemory` 中分别注入 `preferences` 与 `experiences`。记忆只影响表达、结构、节奏和流程取舍；当前 brief、材料、currentDraft、activeAnnotations 与 protectedFacts 优先，记忆永远不能授权新增或改写事实、数字、日期、型号、引文、URL、DOI、来源、客户或亲历。记忆文件损坏或暂时不可读时，本次内容仍继续生成，接口会在 `warnings` 中提示且使用空记忆。

## Writing/Academic DNA

原始技能以 ZIP 内容完整保存在 `skills/writing-dna-skill/` 与 `skills/academic-writing-dna-skill/`；学术模式的入口是顶层 `skills/academic-writing-dna-skill/SKILL.md`。语料只放在 `writing-dna-workspace/general/raw/`（至少 20 个完整 `.md`/`.txt`）或 `writing-dna-workspace/academic/raw/`（至少 1 个有效 `.pdf`/`.docx`/`.md`/`.txt`）。具体投放与调用要求见 `writing-dna-workspace/README.md`。

`GET /v1/dna` 返回两种模式的计数、门槛、就绪状态和项目相对 workspace。`POST /v1/dna/distill` body 为 `{ "mode": "writing" | "academic" }`；桥接先把原始 skill 与语料复制到临时隔离工作区，调用 Codex CLI 真实读取完整 `SKILL.md`、其要求的 docs/scripts/templates/references 和全部 raw。Academic 蒸馏严格执行原始 Mode 1；writing 写作/复审读取全部层、`Writing-DNA.md` 和 5 篇相关 raw，academic 写作/复审执行原始 Mode 2。

Bridge 只把结构完整、与 raw 对应、由模型逐项声明且通过新鲜度检查的输出做事务替换。空白/过短/损坏语料、metadata 不完整、Academic 缺 L0–L6 或单篇缺“演示模式”、原始 Skill/support 更新、蒸馏期间输入变化、未声明额外文件都会使请求失败；旧正式 DNA 和 raw 保持不变。DNA 文件由 Codex 在工作目录中直接读取，不做 compact/runtime profile 或应用层截断；蒸馏、写作和复审均无模型墙钟超时。

## 允许的浏览器来源

公网 Sites v30 只提供本地启动说明，不调用本机 Bridge。完整工作台入口是桥接反代后的 `http://127.0.0.1:43127/`，上游固定为 `http://127.0.0.1:43126/`，不接受请求携带的代理目标。CORS 只允许明确的 localhost/127.0.0.1 开发来源；公开域名不在白名单中。响应包含 `Access-Control-Allow-Private-Network: true` 以配合本地开发浏览器。未知 Origin 会被拒绝；没有 Origin 的本机命令行请求可用于健康检查和测试。

## 测试

不调用真实模型的 Node 单元/HTTP 测试：

```powershell
npm test
```

有本机 Codex 登录时，可运行真实两阶段 smoke（会消耗一次 Codex 调用，且只在本机生成临时文件）：

```powershell
npm run smoke
```

Smoke 只检查健康状态和结构化响应，不打印草稿或任何认证材料。

仅本机验收时可在启动桥接进程前设置 `CODEX_BRIDGE_QA_CAPTURE_FAILED=1`，把失败复审的结构化稿写入仓库 `outputs/qa/` 以定位门禁；文件可能包含正文，默认关闭，禁止提交或打包，验收后可手工清理。正常生产启动不会保存失败正文。
