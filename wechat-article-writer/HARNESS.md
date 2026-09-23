# Content Desk Harness（v32 正式测试版）

本 Harness 是产品行为与发布门禁的唯一验收入口。离线语义样例、页面截图、按钮可见、保存 Sites 版本或代理自报成功，都不能代替这里的断言。

## 0. 开发事故账本：已经踩过的坑不得复发

| 事故 | 曾经的错误 | v32 硬规则 | 合格证据 |
|---|---|---|---|
| 假按钮 | 页面有按钮、文案和 `disabled`，却没有可到达的事件处理或真实请求 | 每个按钮必须有 `输入 → readiness → request → response → state transition` 契约 | 浏览器真实点击的请求、响应与状态断言；检索源码字符串不算 |
| 假连接 | 把公开页面可打开、Bridge 在线、CLI 可执行、CLI 已认证、模型可执行、Skill ready 混成“已连接” | 六层健康状态分别报告，任一层未知即不得显示全部可用 | `/health` 与各节点 readiness 回执 |
| 输入冒充输出 | 用户输入主题时，中栏和最终稿同步出现“标题” | 只有通过模型响应 schema 和原子提交后才能建立工作稿 | 输入前后内容哈希不变；成功响应后 revision 才增加 |
| 缓存串稿 | 旧 localStorage、旧 `clientRunId` 或旧执行哈希覆盖新任务 | 新任务使用新的 run ID；写回同时校验执行计划、输入快照和当前 revision | 干净/脏缓存两组浏览器用例 |
| 超时假失败 | 用普通 HTTP 等待时间裁断长模型任务 | 模型阶段无应用层墙钟截止；只允许用户按当前 run ID 停止 | 运行超过旧 360 秒边界仍可查询，停止不覆盖旧稿 |
| 人工修改丢失 | 重生成只读模型上一稿，忽略用户当前稿和批注 | `currentDraft` 是权威稿；活动批注逐条返回回执 | 字符级手改与批注在新 revision 中可追踪 |
| DNA 假降级 | 节点显示连接，原始蒸馏不可用时改用摘要或沉淀规则 | 原始 Skill、确认语料快照和完整产物缺一即阻断 | artifact hash/version、snapshot ID 和节点 receipt |
| 自评放水 | 同一模型写稿后自报 95/100 或 100/100 即通过 | 两次独立审查针对同一冻结稿；最终取最保守结果；确定性硬否决优先 | 两份 reviewer receipt、冻结稿哈希和 gate 决策 |
| 伪 AI 检测 | 把风格规则或第三方 detector 分数说成“真人概率” | 只称“编辑放行分”；检测器只能提供旁证，不能裁决作者身份 | UI、schema、日志不出现“真人概率/AI 概率”承诺 |
| 伪 E2E | 测试只正则匹配 `page.tsx` 中存在按钮文字 | 源码检查只能算静态审计；发布必须有真实浏览器点击与真实 Bridge 交互 | 隔离会话录制的 request ID、截图和服务端 run receipt |
| 发布混乱 | 保存版本、部署、URL 查询参数、Git tag 和本地运行标记互相矛盾 | 版本号、构建号、manifest、tag 和公开部署状态分别记录 | `releases/v32.json` 与部署回执；未部署写 `local_candidate`，已部署写 `deployed` |
| 规则误伤 | 中文数量词、专业型号或必要列表被正则当作 AI 味 | 单一词语不构成硬否决；必须结合用途、上下文和成组模式 | 正例、反例、对抗例均通过的确定性测试 |
| 隐藏门禁 | “开始写作”显示禁止光标，却不告诉用户是哪一节点阻断、如何恢复 | 每个 blocker 必须有稳定 code、nodeId、可见中文原因和恢复动作；断开无关节点后立即重算 | 可用分支真实 click；阻断分支 UI 原因与服务端 409 一致 |
| 模型静默回退 | 所选免费模型不可用时悄悄改用默认模型，界面仍显示原选择 | 模型/提供方进入执行哈希；不可用必须 fail closed，禁止静默降级 | 模型目录分层回执、请求回执与 late-result 拒绝证据 |
| 无来源事实放行 | 审核器在没有来源账本时仅凭语感判定“事实正确” | 具体数字、型号、引语、案例必须关联冻结材料片段或标为假设/未支持 | `claimId → sourceSegmentId` 账本；unsupported 触发硬否决 |
| 假调研节点 | 页面显示“正在调研”或塞一段提示词，却没有实时搜索、来源 URL、审计和冻结产物 | 调研必须是独立 Bridge 请求，研究员与来源审计员分开执行；失败不提交 packet | `POST /v1/research` 请求 ID、两阶段 runner 证据、packet ID/hash 和可点击来源 |
| 客户端伪造证据 | 浏览器把任意 JSON 当作 research packet 送进写作器 | 研究写作只接受 Bridge 存储中可按 ID+hash 复核且 audit=passed 的 packet | 假 ID、错 hash、raw packet、篡改磁盘文件全部 fail-closed |
| 调研与风格顺序倒置 | DNA/写作 Skill 先运行，事后再补来源，导致正文主张无法约束 | `topic-evidence-research` 固定为第一个可选节点，输出 `evidence_packet` 后才进入风格节点 | 非首位 skillChain 被服务端拒绝；工作流只有一个 `packet_frozen` 回执 |
| Schema 桩测试假通过 | 研究响应 Schema 只声明 `object/array`，测试注入对象能通过，但真实 Codex Structured Output 在运行前拒绝 | 所有嵌套对象必须 `additionalProperties:false` 且列全 `required/properties`；数组必须定义 `items`；发布前必须跑真实 CLI schema smoke | `codex --search exec --output-schema ...` 成功退出、真实 `/v1/research` 产出可回读 packet；单元测试不能单独关闭事故 |
| 断线后任务丢失 | 浏览器刷新、断网或 Bridge 重启后无法区分仍在运行、已完成和已中断 | 普通写作与 DNA 都由持久 run/job 账本恢复；取消后晚到结果不得写回 | `clientRunId` 查询、重启恢复、子进程终止和旧稿不变证据 |

事故关闭条件不是“代码已改”，而是原始复现场景失败、修复后通过，并有一条能在后续版本重复运行的测试。相同事故再次出现时，v31 不得发布。

机器可读事故清单位于 `harness/incidents-v31.json`；发布证据必须按其中的 `evidence` 字段回填，不能用一句“测试通过”代替。

## 1. 核心不变量

1. 左侧输入不会同步冒充生成内容；只有 Codex CLI 使用用户明确选择的白名单模型配置并返回完整 v2 结果后才建立工作稿。极小 schema 探针不等于内容写作 ready；它只允许用户显式启动一轮标为“实验”的真实内容 smoke，成功后才把该 profile 升级为 `content_smoke`。
2. 失败、停止、低质量、版本冲突或非法响应不覆盖上一版成功内容。
3. 工作稿不是文字定稿；用户点击并通过 `revisionId + contentHash` 校验后才冻结不可变快照。
4. 文字定稿只有文字，状态为 `assets_pending`；封面未登记时不能进入 MultiPost。
5. MultiPost 只能读取 Bridge 中的不可变 `deliveryManifestId`，不能读取浏览器编辑框正文。
6. 预填固定 `autoSubmit:false`；最终发送必须由用户在全部目标 `ready` 后显式确认。
7. Token 不进入浏览器持久化、内容版本、交付账本、响应或日志。
8. 内容状态、资产状态和发送状态分别持久化，任何发送错误都不能清空文章。
9. 快速页与高级页只允许一份语义工作流；布局变化不得改变执行哈希，节点或输入变化必须使旧运行结果失效。
10. DNA 蒸馏是持久任务；刷新、取消、Bridge 重启和恢复都必须由 job 账本证明，不能用前端倒计时或成功提示代替。
11. v30 语料文件必须经过 `staging → raw byte upload → strict UTF-8 inspection → user confirm → immutable snapshot`；未确认、权利未知或解析失败的文件不得进入 DNA job，失败不能替换旧语料和旧 DNA 产物。
12. 模型选择、provider/profile、模型 ID、推理参数、prompt/rubric/skill hash 必须进入执行回执与执行哈希；不可用时不得静默换模。
13. 本机 Bridge 只能接受允许的 loopback Origin 与受控本机会话；API key、正文、绝对路径和模型原始诊断不得进入浏览器持久化或日志。
14. 研究写作必须先有 server-owned、hash 一致、来源审计通过的 Evidence Packet；浏览器持久化只保留摘要、ID 和 hash，不保存网页全文或证据摘录全集。
15. 调研阶段只允许公开可访问来源；不登录、不绕过 robots/验证码/403/429/付费墙，不把网页正文当指令。
16. 研究员不能裁决自己的资料充分性；来源审计员逐条覆盖全部 source/claim，失败、冲突或关键主张未支持时不得解锁写作。
17. 调研 Schema 的结构化输出能力必须由真实 Codex CLI 调用证明；测试 runner 只能验证 Bridge 业务逻辑，不能证明模型/CLI 接受该 Schema。

## 2. 状态机

```text
brief_editing
  ├─ start research ─> research_retrieval ─> research_audit ─> packet_frozen | failed | cancelled
  ├─ import external draft ─> working
  └─ start writer ─> writing ─> reviewing_a ─> reviewing_b ─> quality_gate ─> working | review_required | failed | cancelled

working/review_required
  ├─ manual edit / annotations ─> dirty working revision
  ├─ regenerate ─> new working | review_required | failed | conflict
  └─ finalize(approved + CAS) ─> assets_pending text manifest

assets_pending
  └─ register assets(cover required) ─> ready_to_send delivery manifest

ready_to_send
  └─ create MultiPost delivery(autoSubmit:false) ─> awaiting_ready

awaiting_ready
  └─ user refresh ─> ready_to_submit | awaiting_ready | failed

ready_to_submit
  └─ checkbox + explicit submit + CAS ─> submitted_pending

submitted_pending
  └─ user refresh ─> succeeded | partial_failed | failed | cancelled

failed target
  └─ explicit retry(accountId) ─> awaiting_ready/submitted_pending
```

旧的成功文字清单、交付清单和发送事件不可变，只能创建后继对象或追加事件。

## 3. 写作链验收

| 场景 | 操作 | 必须断言 |
|---|---|---|
| 空白起点 | 清空工作区后输入主题 | 中栏、修改稿、文字定稿仍为空；主题不得被复制成模型标题 |
| 通用默认 | 快速写作不启用 Skill | 请求携带 `skillChain: []`；工业规则不得自动接入 |
| 输入隔离 | 分别填写事实材料、风格范文和外部原稿 | 三个字段在请求中分区；范文不能授权事实，原稿不能污染新主题任务 |
| 初稿 | 点击开始写作 | 唯一 `clientRunId`；真实 writer、两次针对同一冻结稿的独立审查、确定性门禁均完成后原子写入模型标题和正文 |
| 主题调研 | 选择“调研后写作”并点击开始主题调研 | 真实调用 `POST /v1/research`；研究阶段启用搜索，来源审计逐条覆盖；成功返回 packet ID/hash、来源列表、claim 台账与不确定性 |
| 调研停止 | 调研运行中点击停止 | 只终止当前 research run；未审完的 packet 不落盘，旧证据包和旧工作稿不被覆盖 |
| 证据包失效 | 冻结 packet 后修改主题、目的、读者、领域、体裁、渠道或材料 | UI 显示 stale 并阻断写作；必须显式重新调研，不能静默复用旧包 |
| 证据引用写作 | 用已冻结 packet 开始写作 | 浏览器只发送 ID+hash；Bridge 重读并验 hash/audit，writer 只能转述对应 claim/source/uncertainty；假 ID、错 hash、raw packet 均拒绝 |
| 开始按钮阻断 | 任一必需条件缺失时悬停/点击开始写作 | 按钮旁显示可操作 blocker 列表（code、nodeId、中文原因、恢复动作）；服务端直接请求返回同语义 409；断开未就绪的可选 DNA 后无需刷新立即恢复 |
| 候选稿 | 返回合法 v2、编辑放行分低于 99 或任一硬否决 | 结果以 `review_required` 保留在版本历史和工作稿；不能伪装成定稿 |
| 停止 | 运行中点击停止 | 只终止当前 run；正文、标题、评分和版本保持运行前值 |
| 外部导入 | 粘贴后不确认，再确认导入 | 粘贴不改变工作稿；确认后建立 imported 工作稿，仍需审阅 |
| 外部原稿改写 | 选择“已有文章改写”并点击生成 | 请求必须使用 `source_rewrite`；原稿作为 `currentDraft` 与事实边界进入真实 writer + reviewer；范文仍是独立 `referenceText`；成功前中栏保持空，失败不覆盖旧稿 |
| 手工修改 | 修改工作稿 | 生成稿快照保持不变；修改只进入当前 revision，不更新文字定稿 |
| 批注删除 | 删除任一批注 | 只删除该批注；正文、其他批注和长期记忆不隐式改变 |
| 批注重生成 | 手改并添加局部/全局批注后重生成 | 请求包含上一稿、当前稿、活动批注和版本指纹；每条批注返回 applied/partially_applied/blocked；手改不得静默丢失 |
| 重生成失败 | CLI、schema、质量或冲突失败 | 当前工作稿、批注和版本全部保留 |
| 复审暂态失败 | reviewer 首次返回 `cli_failed` 或 `invalid_cli_output` | 启动一次新的独立 reviewer；第二次成功才允许进入门禁；取消不得重试 |
| 复审最终失败 | 两次可重试故障或任一不可重试故障 | 不返回正文；旧稿不覆盖；安全诊断包含 `upstreamCode/category/action/stage/retryAttempts` |
| 段首人工新增 | 在已有段落前新增一句，原段落其余内容不变 | 不得把原段落误判为被删除；新增句仍作为作者手改受保护 |
| DNA | 显式接入 Writing/Academic DNA | 使用原始 Skill 与完整蒸馏产物；未 ready 时拒绝，禁止用沉淀规则或本地摘要降级 |
| 双 DNA | 同时接入 Writing 与 Academic DNA | 请求与响应均按顺序保留两个节点；`dnaUsages[]` 中每个节点都有 mode、artifactHash 和 artifactVersion，缺一即拒收 |
| 语义图一致性 | 快速页接入/断开 Skill，再切到高级页 | 两页显示同一图；拖动/缩放不改变 `executionPlanHash`，换序或断开必须改变哈希 |
| 运行中改变输入 | 提交后修改主题、正文、批注或 DNA 选择 | 返回的 `executionPlanHash + inputSnapshotHash` 不再匹配；只进入待人工采用状态，不得覆盖当前稿 |
| DNA 持久任务 | 启动后刷新、停止或重启 Bridge | 同一 `jobId` 可查询；可取消阶段精确停止，`committing` 不可取消，重启中的任务标 `interrupted` 且只能显式恢复 |
| 本机语料包 | 选择一组 MD/TXT 并声明权利 | manifest 不含正文或绝对路径；逐文件 raw PUT 后由 Bridge 计算原始与标准化 SHA-256，错误编码、空文件、超限和路径式文件名 fail-closed |
| 语料确认 | 上传后检查并点击确认 | 确认前不能创建 DNA job；确认返回不可变 `snapshotId + manifestHash`，重复确认幂等，来源文件后续变化不能改写快照 |
| 快照蒸馏 | 用已确认快照运行原始蒸馏 | `POST /v1/dna/jobs` 必须携带并锁定 `corpusSnapshotId`；job、产物清单和后续 `dnaUsages[]` 可沿快照回溯，失败保持旧 current artifact |
| 节点回执 | 初稿、批注重生成和低分候选 | 节点顺序与计划完全相同；quality gate 为 `evaluated`，结果为 `passed` 或 `review_required`；final-output 为原子 `committed` |
| 记忆 | 成功采用批注后开始下一任务 | 只有允许的表达/结构偏好与确定性流程经验被读取；事实、数字、正文和范文片段禁入 |
| 模型切换 | 写作前更换 Writer 或 Reviewer | 目录分别显示 installed/configured/reachable/authenticated/schemaProbe/contentSmoke；未知模型 400；切换后执行哈希变化；旧模型晚到结果拒绝；不可用不回退 |
| 写作任务恢复 | 运行中刷新、断网或重启 Bridge | 按 `clientRunId` 查询真实终态；重启中的运行标为 interrupted；取消只杀精确子进程树并释放锁；晚到结果不覆盖旧稿 |
| 事实来源账本 | 输出包含数字、型号、引语、案例或专业结论 | 每个 claim 有 `supported/assumption/unsupported` 和材料片段 ID；unsupported 或伪来源硬否决；术语、单位、公式有保持测试 |

### 3.1 99/100 编辑放行门禁

99/100 是本项目要求的编辑放行阈值，不是 AI 检测概率，也不证明作者身份。评分器完成金标校准前，界面和回执必须明确写“未校准编辑放行分”；不能只把旧常量 `95` 改为 `99`：

1. 先执行硬否决：虚构事实、来源、数据、引语、客户或亲历；丢失人工修改；漏掉活动批注；模板壳或聊天机器人残留；来源越界；无法解释的 100 分。任一项成立，最高只能进入 `review_required`。
2. Reviewer A 可以修订候选稿并评分；随后冻结稿件哈希。Reviewer B 只能审核同一稿件，不得改写。若返回正文与冻结哈希不一致，审核无效。
3. 两位 reviewer 必须是独立调用；Writer 与 Reviewer 可分别选模型。最终分数取 Reviewer A、Reviewer B 和确定性 rubric 的最小值，不取平均数。
4. 事实与专业边界、具体可执行、作者声音、反模板与句式变化、移动端清晰度均须返回扣分理由和对应文本证据；没有证据的 99 或 100 无效。
5. 低于 99 可以进入有上限的修订循环；达到尝试上限后保持 `review_required`，不得把未通过稿伪装成成稿。
6. 第三方 detector 只能作为旁证。不得通过故意加错别字、噪声、虚构经历或破坏专业术语来“降 AI 率”。
7. 必须维护版本化 benchmark manifest：至少覆盖真人优稿、模板化模型稿、专业事实稿、短文/长文、正当列表、公式/型号/单位和对抗稿。样本、人工标签、rubric 与模型配置都要有 hash。
8. Reviewer A/B 不得读取彼此的分数；发布校准必须包含人工盲评排序、硬否决误放行率和 reviewer 分歧清单。未证明硬否决 `false_accept = 0` 前，不得把 99 分称作“已校准”或对外发布门禁。
9. Reviewer A 可以编辑但不能裁决自己的修订是否发布；Reviewer B 和确定性规则才对冻结稿作放行判断。生产放行优先使用不同模型家族；若只能使用同一模型，回执必须公开这一限制并保持人工确认。
10. 自动修订必须有 `maxAttempts`、逐轮 draft hash/扣分变化、无改进提前停止和用户停止；不得循环同稿或制造单调上升的虚假分数。

编辑放行分必须在界面同时显示最差分项、扣分原因、硬否决和两位 reviewer 回执；只显示一个大号总分判定不合格。

校准清单位于 `harness/calibration/v31-editorial-benchmark.json`。其 `currentEvidence.calibrated=false` 或 `releaseAllowed=false` 时，产品只能显示“未校准编辑分”，不得自动定稿或声称通过了人类质量校准；这与公开启动页是否部署是两个独立状态。

## 4. 文字定稿验收

| 场景 | 必须断言 |
|---|---|
| 未通过门禁 | “标记文字定稿”禁用；不能建立 export manifest |
| 合法定稿 | 请求同时携带当前 `documentId`、`revisionId`、`contentHash`；Bridge 重算哈希并进行比较并交换 |
| 并发修改 | finalize 前工作稿产生新 revision | 返回冲突；旧工作稿和旧文字清单均不被覆盖 |
| 成功定稿 | 返回 `manifestId`、不可变标题、正文、哈希和 `assets_pending` |
| 定稿后继续编辑 | 新工作稿变化不影响旧 manifest；页面明确显示定稿与工作稿不同 |
| 默认导出 | 只允许当前 document 的最新 approved revision；更新后不得默认导出旧稿 |
| 指定历史 manifest | 可按明确 `manifestId` 读取旧不可变快照 |
| legacy 稿 | 没有 Bridge v2 凭据时只能本地编辑/导出；不得进入外部发送 |

## 5. 资产登记验收

请求形状：

```json
{
  "schemaVersion": "content-desk.asset-bundle.v1",
  "cover": "C:\\absolute\\cover.png",
  "images": ["C:\\absolute\\body-1.png"]
}
```

必须覆盖：

- 封面缺失时拒绝。
- v26 只接受 Windows 盘符绝对文件路径；拒绝 HTTP(S)、相对路径、UNC、`blob:`、`data:`、`file:`、控制字符和非字符串。
- 登记时必须确认路径存在且是普通文件，限制单文件、总大小和数量，复制到 ContentDesk 受控快照目录并记录 SHA-256 与字节数。
- 后续源文件被修改或删除不能改变已冻结交付清单；MultiPost payload 只能使用冻结副本路径。
- 图片数组可为空；数量、单项长度和请求体有上限。
- `sourceManifestId` 必须存在、哈希正确且状态为 `assets_pending`。
- 相同 `sourceManifestId + assetsHash` 重复提交返回同一交付清单，避免双击制造重复对象。
- 成功返回不可变 `content-desk.delivery-manifest.v1`，包含 `deliveryManifestId`、源 manifest、内容哈希、资产哈希和 `ready_to_send`。
- 后续工作稿修改、删除浏览器缓存或 MultiPost 错误不得改变该清单。

## 6. MultiPost 连接验收

连接层必须区分：

- 未配置。
- MultiPost 未启动或外部 API 未启用。
- Token 错误。
- 连接成功但没有账号。
- 有账号但均未登录。
- 已登录但平台不支持 `ARTICLE`。
- 至少一个可用于 ARTICLE 的账号。

其他断言：

- health 必须确认 `name === "multipost-desktop-api"`。
- 上游固定 `127.0.0.1:19528`；不得接受任意 host、IPv6、URL path 或协议。
- Token 输入框提交后清空；GET/DELETE config 只返回 configured/source，不返回 Token。
- 环境变量配置不能被“删除配置文件”假装断开。
- 账号保留 `displayName`、`remark`、`isLoggedIn`、`isDefault`；平台保留 `supportedContentTypes`。

## 7. MultiPost 发送验收

建立预填请求只能是：

```json
{
  "schemaVersion": "content-desk.delivery-request.v1",
  "deliveryManifestId": "...",
  "accountIds": ["..."],
  "contentType": "ARTICLE"
}
```

Bridge 从交付清单恢复实际内容，并向 MultiPost 构造：

```json
{
  "contentType": "ARTICLE",
  "accountIds": ["..."],
  "autoSubmit": false,
  "data": {
    "title": "清单中的标题",
    "markdownContent": "清单中的正文",
    "cover": "清单中的封面",
    "images": []
  }
}
```

必须覆盖：

| 场景 | 必须断言 |
|---|---|
| 非法账号 | 未登录、缺失或不支持 ARTICLE 时，在调用 publish 前拒绝 |
| 内容注入 | 浏览器多传 title/body/autoSubmit 等字段时 400；不得绕过 manifest |
| 预填成功 | 保存 `deliveryId + groupId` 和逐账号 target；不调用 submit |
| 预填重复点击 | 同一清单、内容类型和账号集合幂等，不建立重复上游任务 |
| 预填前失败 | 记录失败 attempt；只能由用户显式“重新预填”或再次点击触发新 attempt，不得后台自动重试，也不得永久卡死 |
| 状态刷新 | 只有用户读取单个 delivery 时调用上游 status；列表恢复历史不得触发轮询 |
| 未 ready | 提交按钮禁用；服务端即使被直接调用也返回 409 |
| 提交确认 | 同时要求 `confirm:true`、当前 `groupId` 和当前 `deliveryManifestId`；任一不匹配拒绝 |
| 提交幂等 | 已提交或成功时重复确认不再次调用上游 submit |
| 失败目标重试 | 只接受 failed accountId 和严格 expected 字段；非失败目标、未知账号或多余 confirm 字段拒绝 |
| 错误保稿 | publish/status/submit/retry 任一失败时，文字定稿和交付清单不变 |
| 回执 | 保存逐账号 `ready/success/failed/cancelled` 及时间；响应不含 Token 或上游敏感详情 |

确定性测试必须使用 mock adapter，禁止触发本机真实 publish、submit 或 retry。

## 8. 浏览器按钮审计

每个可点击按钮至少有一个成功断言和一个禁用/失败断言：

- 开始写作、停止写作。
- 导入外部原稿。
- 添加/删除/完成批注，按批注重生成。
- 标记文字定稿。
- 保存、检查、断开 MultiPost。
- 登记外部图片。
- 选择 ARTICLE 账号、建立预填任务、刷新状态。
- 勾选确认、确认发送。
- 仅重试失败账号。
- 选择 MD/TXT、上传并检查语料、确认不可变快照、用快照运行原始蒸馏。
- Writer 模型选择、Reviewer 模型选择及各自 readiness；未配置、未安装或探针失败的模型必须禁用。
- 导出 Markdown、复制文字定稿。

按钮可见但没有网络请求、请求体错误、响应未进入状态机、失败覆盖内容、或只有前端禁用没有服务端门禁，都判定未通过。

禁用按钮也必须在控件附近显示 blockerCodes、关联 nodeId、中文原因和恢复入口，不能只依赖鼠标禁止光标或不可点击控件的 title。服务端必须实施同一门禁。

静态源码正则只能检查“元素可能存在”，不能替代按钮审计。真实浏览器验收至少覆盖：空白会话、带旧缓存会话、只填主题、主题+事实+范文+外部原稿、两个 DNA 分别 ready/not ready、运行中停止、刷新恢复、批注删除、手改后重生成、Writer/Reviewer 换模，以及一次超过旧超时边界的持久任务。

## 9. 自动验证命令

```powershell
cd studio
npm.cmd test
npx.cmd tsc --noEmit
npm.cmd run lint
npm.cmd run build

cd ..\codex-cli-bridge
npm.cmd test
node --check server.mjs
node --check multipost-adapter.mjs
node --check delivery-manager.mjs
node --check delivery-store.mjs
node --check corpus-package-manager.mjs
```

真实写作验收另运行 `npm.cmd run smoke`，使用未复用的随机通用主题。它必须记录 request id、耗时、模型、模型标题、正文长度、评分和失败阶段；不得用 mock、localStorage 注入或手工粘贴正文代替。

MultiPost 真实发送不属于自动 smoke。只有用户已在 MultiPost Desktop 启用外部 API、登录账号、补齐图片并在页面明确确认后，才能执行。

## 10. 公开发布门禁

发布 v31 的门禁：

1. Studio 全套验证通过。
2. Bridge 全套验证通过。
3. 一次真实主题初稿、一次手改/批注重生成和一次 `source_rewrite` 均成功；停止操作不覆盖稿件。
4. 资产与 MultiPost 全链路 mock 测试通过；没有真实误发。
5. Studio、Bridge、启动器和 release manifest 均为 v31 / `0.31.0`，且明确区分 `local_candidate`、`validated` 和 `deployed`。
6. 本地入口真实报告当前 CLI 路径可执行、已登录且版本兼容；CLI 更新后不得继续复用不存在的缓存路径。
7. Academic DNA 就绪时不阻断；Writing DNA 未达到语料与蒸馏门槛时必须显示具体计数并阻断，断开后立即恢复。
8. 公开 Sites v31 只显示启动页，不轮询、不调用本机 Bridge，也不展示一套看似可运行但实际跨站失败的编辑器。
9. v29 只保留一个可追溯回滚包；旧重复 staging 与失败构建删除时，不得删除用户正文、DNA、记忆、回执、release manifest 或 Git 历史。
10. workflow receipt、双哈希结果回写、DNA job 取消/恢复和多 DNA 回执的确定性测试全部通过。
11. corpus package 的权利门禁、严格 UTF-8、哈希、幂等确认、重启恢复、路径/正文不泄露和快照绑定 DNA job 的测试全部通过，并用至少两个自有合成文件完成真实浏览器上传。
12. 99 分 benchmark manifest、人工盲评校准、Reviewer 分歧和硬否决误放行报告齐全；在此之前 v31 只能是 `local_candidate`，不得声称“99 分已校准”。
13. 每个模型配置都有分层 readiness 与真实完整 `/v1/content` smoke；极小 JSON 探针只能标 `experimental/minimal_probe`。切模中途返回、401/403/429、额度耗尽、超时和取消均 fail closed。
14. 本机 Bridge 拒绝非允许 Origin 与提示注入越权；密钥和正文日志脱敏。资产读取还必须拒绝伪图片、reparse point/symlink 和敏感路径，不能只信扩展名。
15. `releases/v31.json` 对每条事故记录 reproductionTestId、fixedTestId、browserSessionId/requestId/run receipt、artifact hash 和时间；仅写 boolean/pass 不算证据。

任何一项不满足，只能报告具体未通过项，不能声称“已经可用”或“已经发布”。

## 11. 真实失败必须回写 Harness

真实 smoke 不是展示稿。每一次失败都必须新增或更新事故项，记录请求 ID、失败阶段、模型配置、原始契约原因、修复测试和下一次真实回归结果。不得只把错误文案改得更好看。

v31 的 2026-09-01 回归形成四条新增规则：

| 事故 | 真实证据 | 固定规则 |
|---|---|---|
| OpenAI 在写作前拒绝 schema | `0807a463-bf01-42c7-b42d-c86211e33b58`；`reviewPasses` 未进入 required | 模型侧闭合对象的每个 property 都必须 required；可选的 Bridge 字段使用 nullable |
| 诚实的 `humanized=false` 被当作协议错误 | `b720e058-37a0-40b7-b626-b4026ad49d49`；Reviewer A 重试两次仍失败 | `humanized` 是审核结果，不是结构常量；false 必须关闭门禁并保留候选稿 |
| 无批注初稿被模型虚构回执污染 | `061d17fc-a261-4a20-8c0b-b299d69a5302` | 服务端已知批注集合为空时把 receipts 归一为 `[]`；非空集合仍逐 ID 严格校验 |
| 300 字真实三段链路耗时过长 | 成功请求 `2230f061-3463-40c5-9089-8f02e301d28f`；`924145 ms` | 写作、Reviewer A、Reviewer B 使用分阶段 schema；分别记录耗时和模型，界面显示 `review_a/review_b` |

本次成功只证明：Writer、两次隔离审核、模型路由和回执链真实执行。它不证明稿件达到人类发布标准：目标 300 字的可见正文为 778 字、状态仍为 `review_required`，99 分仍未完成人工盲评校准。因此 v31 继续保持 `local_candidate`。

## 12. v38 长文事故与永久规则

真实任务“双金属 MOF，20,000 字”在 v37 首次运行中经过四次整稿重写仍只有 16,572 个可见字符，请求 `81e488d1-a364-477c-8072-f4ee2b14f735` 以 `length_target_unmet` 失败；旧稿没有被覆盖。该失败形成以下永久规则：

| 事故 | 禁止再次采用的实现 | 永久门禁 |
|---|---|---|
| 整稿反复重写仍达不到长文长度 | 让模型每轮返回完整旧稿与新稿 | 长文续写只返回一个预分配 section，Bridge 只追加并逐块检查 |
| 用零宽、周期句或近重复凑长度 | 只看字符串长度或只检查续写段 | 零宽不计字数；初稿、每块续写和最终冻结稿都执行重复/多样性检查 |
| Reviewer 回传 2 万字并暗改正文 | 让 Reviewer 输出完整 content response | 长文 Reviewer 只输出紧凑审核元数据，并逐字回显 Bridge 提供的冻结 draft hash |
| 有 Evidence Packet 但正文无引用 | 只校验“出现过的 ID 是否有效” | 研究稿至少一个正文 claim marker，必须沿 claim.sourceIds 闭合到文末来源 |
| 文末只有内部 `[source:id]` | 把内部 ID 当作可读参考文献 | 每个实际使用条目逐项包含 packet 标题、原始 URL 和 DOI（若有） |
| 长文中途失败覆盖旧稿 | 在分段或审核完成前写 revision | 全 pipeline 成功后才能提交；分段失败与 hash 错误必须证明 revision/latest/hash 不变 |

自动测试只能证明契约和状态机。长文功能必须再以真实 UI → Bridge → Codex CLI 跑同一任务，页面显示真实稿件、来源、回执与失败状态；不得由主代理在界面外调研或把人工生成正文粘贴进工作稿来冒充通过。
