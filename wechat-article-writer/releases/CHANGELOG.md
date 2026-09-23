# Changelog

## v40（本地候选，真实链路复测中）

- 沿用 v39 的全新单画布前端，不恢复旧版切换页；修复严格复审失败时整篇候选稿被丢弃的问题。初次生成的低分／硬问题稿现在必须以 `review_required` 显示给用户检查、手改和批注，但内容存储层继续禁止定稿、导出和发送。
- 批注重生成与外稿改写仍在事实或用户手改被破坏时拒绝覆盖，避免为“可见”牺牲作者稿安全。
- 中文量化检查区分“两个层面／一批候选”等论述结构和“两台设备／一批样品”等具体数量，减少错误的事实越界判定。
- 长文复审新增服务端冻结正文长度和 `bridgeGeneratedReferences` 回执；审核员不得再把 Bridge 确定性生成的参考文献、URL、DOI 或题名数字误判为写作器越权。
- 修复同版本旧 Bridge 被启动器复用：只有进程启动时间不早于 `server.mjs` 时才允许复用；总启动器等待子启动器完成后再判断健康，避免旧进程抢先通过健康检查。
- v39 已记录为失败候选并隔离，v40 完成真实 2 万字 MOF 页面复跑、手改、批注删除和模型对话前不声称正式可用。

## v39（本地候选，验证中）

- 将旧的“顶部小节点条 + 下方互斥替换面板”改为真正的左到右横向工作流画布；所有阶段卡片在同一页面展开，点击节点只做滚动和聚焦。
- 任务输入、作者画像、主题调研、Writing DNA、Academic DNA、专业上下文、写作、独立复审、人机编辑和定稿发送均保持可见；可选节点未接入时仍展示，并在卡内提供接入／移除操作，明确未接入不等于失败。
- 画布支持 Ctrl／⌘ + 滚轮缩放、+／−／100%／适应全图和横向滚动；输入、调研、DNA、写作、审查、编辑、交付使用独立颜色。
- 新增永久产物阅读区，同时显示调研证据、工作稿、人机编辑对话和最终稿；现有 Bridge handler 继续接回真实 API。
- 审查区将旧 99/100 显示降级为“未校准编辑放行分（兼容门禁）”，优先呈现硬性问题与双审回执。

## v38（本地候选，验证中）

- 保留 v37 单画布前端，修复节点运行态精确映射；写作、续写、审核和交付不再同时冒充运行中。
- 2 万字任务改为分段只追加，写作器不再反复回传并覆盖整篇稿；长文硬边界为目标的 90% 到目标值，零宽字符不计字数。
- 初稿、每个续写段和最终冻结稿都执行机械重复门禁；周期填充、低分片多样性和近重复不能用来凑字数。
- 调研稿强制校验正文 claim marker、Evidence Packet sourceId 和文末参考文献的闭环；每条实际引用必须展示来源标题、原始 URL 及 DOI（若有）。
- 长文 Reviewer 只返回审核元数据和服务端冻结 hash，不再返回或替换 2 万字正文；任何分段或审核失败都不改变已有 revision/latest/hash。
- 自动验证为 Bridge 222/222、Studio 137/137、lint 与 production build 通过；独立对抗审查从 BLOCK 经四轮修复转为 PASS。真实 MOF 2 万字 UI 复跑及手改/批注/对话验收尚未完成，因此当前仍是本地候选，不能声称正式可用。

## v33（本地候选，未部署）

- 新增永久可见的“手改保存与模型对话”双栏编辑台；快速写作和高级编排共用同一状态，不用弹窗或折叠隐藏输出。
- 手改正文经 Bridge 追加为 `manual_edit` revision；保存与恢复都使用 revision/hash CAS，历史正文不可原地覆盖。
- 新增 Codex 编辑器动作：只讨论、局部改写选区、重新排版。模型结果先进入候选区，不会自动修改或保存正文；基线变化时拒绝采用。
- 新增精确停止、前端候选契约和 Bridge 集成测试。此版本保持本地候选，v32 仍是正式部署基线。

## v32（正式部署）

- 新增独立的“主题证据调研”节点，固定在 Writing DNA、Academic Writing DNA 和 Codex 写作器之前；调研后写作只有拿到审计通过且输入未变化的 Evidence Packet 才能启动。
- Bridge 使用 `codex --search exec` 分两次运行研究员与来源审计员，服务端生成 packet ID、重算 SHA-256、原子保存；浏览器只持有 ID、hash 和有限摘要，原始 JSON 不能冒充依据。
- 采用项目适配 Skill `skills/topic-evidence-research/`，并固定参考 MIT `dimayip/research-agent@5fab4dc258315e9680064b565ba49a5a07ae7895`；上游原件保持不改，宿主专用工具不进入运行时。
- 真实 smoke 以 NIST AI 600-1 的 confabulation 风险为主题，得到 packet `ep-mtimi398-98e479a3`：3 个 NIST 一手来源、9 条主张、4 条不确定性，`codex-sol` 独立审计通过，GET 回读 hash 与 POST 回执一致。
- 真实 smoke 先后发现并修复 `--search` 全局参数顺序、嵌套 Structured Output Schema 不完整、模型时间字段越权和不完整发布日期三类测试桩无法暴露的问题；均已写入 Harness 回归规则。
- Bridge 189/189、Studio 126/126、TypeScript、lint、build、Bridge 语法和证据包 validator 全部通过。按用户明确要求，源码 `2c92356` 标记为 `content-desk-v32`，保存为 Sites 版本 31 并部署到原正式地址；线上已回读 `CONTENT_DESK_BUILD=v32`。带证据包的真实写作、真实浏览器点击和 99 分人工校准仍是已知限制，不得从“已部署”推导为“内容质量已全面验收”。

## v31（本地候选，未部署）

- 增加 Writer/Reviewer 模型路由；Codex Sol/Terra/Luna 与本机 Ollama/Qwen 使用白名单配置，未知模型和静默回退被拒绝。
- 主链改为 Writer、Reviewer A、冻结稿 Reviewer B 和逐维保守门禁；低于 99、双审缺失/改稿、硬否决或 `review_required` 均由服务端拒绝定稿与导出。
- 本机 Qwen 最小 JSON 探针已真实跑通，但 `ready=false`；只有完整 `/v1/content` smoke 才能升级为 `content_smoke`。
- 固定引入 MIT `humanizer-zh`，并建立 18 条事故账本与未校准 benchmark manifest。
- 当前自动验证为 Bridge 182/182、Studio 118/118、TypeScript、lint、build 和语法检查通过。真实 Luna 链路完成 Writer + Reviewer A + Reviewer B（request `2230f061-3463-40c5-9089-8f02e301d28f`），但 300 字目标返回 778 字且状态仍为 `review_required`；真实浏览器批注/外稿改写、Humanizer 执行 hash/回执、满分 evidence span 和人工盲评校准尚未关闭，因此未保存为公开 Sites 版本、未部署、未打 tag。

## v30（已部署）

- 新增本机授权语料包：只接受严格 UTF-8 的 `.md/.txt`，逐文件计算 SHA-256，先暂存、再由用户确认生成不可变 corpus snapshot；网页响应、日志与 Sites 包均不暴露原文或绝对路径。
- Writing DNA 与 Academic Writing DNA 的语料包、确认快照、状态提示和幂等键全部按 mode 隔离；同一批文件可分别建立两个包，切换节点不会串线。
- DNA 任务绑定确认快照并复用 v29 持久 job executor；artifact manifest 在原子替换前完成，job、receipt、snapshot 与 artifact hash 必须一致，提交后回执异常不会伪报普通失败。
- 真实浏览器验收从 UI 上传两篇文章、分别确认 Writing/Academic 快照，并完成一次真实 Academic Writing DNA 蒸馏；任务运行约 9 分 50 秒后成功原子提交，未使用演示数据或前端伪结果。
- Bridge `170/170`、Studio `114/114`，TypeScript、lint、build 与 `git diff --check` 全部通过；三轮严格审查未发现 P0/P1。
- Studio 源码 `f43afe9`，标签 `content-desk-v30`，Sites 版本 30；公开页面已核验为 `CONTENT_DESK_BUILD=v30`。
- v29 作为 v30 的唯一紧急回退基线；v30 当前不支持 DOCX、PDF、HTML、ZIP、OCR 或公开 URL 抓取，不能把路线规划写成已实现能力。
- 完整部署与真实任务证据见 `releases/v30.json`。

## v29（已部署）

- 快速页与高级页改为共享单一 typed workflow graph；核心写作、复审、质量门禁和原子工作稿提交不可绕过，画布布局不进入执行哈希。
- 每次运行冻结 `executionPlanHash + inputSnapshotHash`；恢复结果必须双哈希一致，运行中改题、改稿、改批注或改节点不会被旧结果静默覆盖。
- Writing DNA 与 Academic Writing DNA 改为持久 job：支持幂等创建、精确取消、刷新查询、Bridge 重启后中断标记、显式恢复和终态删除；`committing` 阶段不可取消。
- 写作响应增加 `dnaUsages[]` 与逐节点 `workflowReceipt`；低于 95 分的合法候选稿仍原子保留，quality gate 明确返回 `evaluated + review_required`，不冒充通过。
- Workspace envelope 和内容 API 保持 v24/v2，以便 v28 紧急回退仍能读取正文和 Skill 投影；v28 作为唯一回滚基线。
- Studio 源码 `0c4202f`，标签 `content-desk-v29`，Sites 版本 29；公开页面已核验为 `CONTENT_DESK_BUILD=v29`。
- 真实验收覆盖停止、主题初稿、手改与批注重生成、持久 Academic DNA 任务启动与精确取消；Sites 打包统一为 `dist/server/index.js`，错误的根目录布局不得再作为发布产物。
- v28 仅保留为 v29 的紧急回退基线；完整证据见 `releases/v29.json`。

## v28（已部署）

- 公开 Sites 只做本地启动导航；真实工作台改为 Bridge 同源本地执行面，公开网页不再跨边界读取 `127.0.0.1`。
- Bridge 支持 Codex CLI 升级后路径自动失效与重发现，健康接口返回可操作的阻断原因。
- 快速写作、画布运行栏和 Codex 写作器共用同一 `generationGate`，并显示 CLI、待恢复任务和 DNA 就绪状态。
- 新增真实 `source_rewrite`：外部原稿直接调用 Codex 改写，受保护事实与范文表达输入保持分离；同时保留“仅导入”路径。
- 真实验收覆盖停止、主题初稿、手改与批注重生成、单条批注删除、外稿改写和 DNA 就绪门禁；修复“一条/一个/一套”被误判为未授权量化事实的规则缺陷。
- Studio 源码 `3febe49`，标签 `content-desk-v28`，Sites 版本 28；公开页面已核验为 `CONTENT_DESK_BUILD=v28`。
- v27 仅保留为唯一紧急回退基线；v24–v26 重复构建、失败打包和临时 staging 已列入精确删除清单，但当前主机策略在命令启动前拒绝递归删除，因此仍标记为待清理；未删除版本记录、Git 历史、文章、记忆或 DNA 语料。

## v27（已部署）

- 画布节点改由 Bridge 实际阶段驱动，写作、独立复审、质量门禁、提交和失败终态不再混用同一个“运行中”状态。
- 复审器对 CLI 进程失败或结构化输出不合约最多自动重试一次；取消不重试，最终失败仍不覆盖旧稿。
- 失败响应和运行账本保留经过白名单过滤的上游错误类型与处理建议，不再把所有复审故障压成不可诊断的 `review_failed`。
- 修复段首新增一句被误判为删除原段落的差异假阳性；真实批注重生成已验证人工修改保留、逐条回执和批注删除。
- Studio 源码 `b61d880`，Sites 版本 27；公开站点已从 v26 升级到 v27，v26 保留为回滚点。

## v26（已部署）

- 产品改为面向个人知识创作者的可组合非虚构内容工作台；工业研发、Writing DNA、Academic Writing DNA 均为显式可选能力。
- 快速写作与高级编排共用同一 Bridge 契约；事实材料、风格范文、外部原稿、工作稿、文字定稿和分发状态彼此分离。
- 批注重生成逐条返回采用回执，保护人工修改；低于门槛的候选稿保留为 `review_required`，不冒充成稿。
- 增加重复翻案句式等确定性编辑门禁；95 分是可解释编辑评分，不宣称为 AI 检测概率。
- MultiPost 两阶段发送：冻结本机图片、预填、人工确认、提交、轮询和逐目标回执；不确定状态整单冻结，禁止自动重试。
- Studio 源码 `c4f11de`，Sites 版本 26；已替换公开 v23。

## v25（已保存，未部署）

- MultiPost Desktop 本地 Bridge 适配器。
- 连接、账号和平台能力检查；不自动提交。
- Token 只保存在本机 Bridge；保留账号登录状态和平台 `supportedContentTypes`。
- Sites 版本 25 对应源码 `b422018`；未替换公开 v23。

## v24（已保存，未部署）

- 通用可组合非虚构任务模型，工业研发改为显式可选领域能力。
- 工作稿、文字定稿、等待补图、可发送稿分离。
- 统一产品版本、构建标记和历史迁移。
- Sites 版本 24 对应源码 `3efcc3f`；作为 v25/v26 的独立回滚点，未替换公开 v23。

## v23-legacy

- 公开 Sites 版本号为 23，但页面与 Bridge 的实际构建标记仍为 v16。
- 以 Studio 提交 `cbb3263924bbdf8c13877fd7aa3157be4a83d4a9` 冻结历史，不再作为新状态的默认来源。
