# Content Desk 版本路线

本文区分已交付基线和下一版目标，防止规划被提前写成“已实现”。

## v29：真正的节点执行器（唯一回滚基线）

- 单一语义图驱动快速页和高级页；`skillChain` 只作为 v28 回滚兼容投影，画布坐标不进入执行哈希。
- 固定不可绕过主链：冻结输入 → 白名单可选 Skill → 写作器 → 独立复审 → 95 分门禁 → 原子提交工作稿。
- 每个节点统一实现 `Input → Readiness → Run → Artifact → Receipt`；回执使用 `prepared/context_supplied/loaded/drafted/reviewed/evaluated/committed`，质量门另写 `passed/review_required` 结果，不得用笼统的“applied”冒充执行证据。
- Writing DNA 和 Academic Writing DNA 蒸馏返回持久 `jobId`，支持精确停止、刷新恢复、Bridge 重启后显式恢复、失败节点定位和不可变产物哈希；`committing` 阶段不可取消。
- 写作响应使用 `dnaUsages[]` 代替单个 legacy `dnaUsage`，两个 DNA 同时接入时都必须有服务端回执。
- 后台结果回写前同时比较 `executionPlanHash + inputSnapshotHash`；输入、节点或批注变化时不得静默覆盖当前稿。
- v29 串行执行，一次只允许一个模型任务；不加入任意 shell、任意路径、任意 prompt、循环、条件分支或模型并行。

## v30：本机授权语料包与证据溯源（已部署基线）

- 只接收用户明确授权的本机文件；不抓网页、不监控目录、不做云同步、不接受任意路径或 URL。
- 两阶段导入：建立 staging → 上传原始字节并计算 SHA-256 → 用户确认 → 不可变 corpus snapshot → 蒸馏 → 原子切换 current artifact；失败不得替换旧语料或旧产物。
- v30 仅接受严格 UTF-8 的完整 `.md/.txt` 文章；不把结构化 metadata、图片描述、DOCX 或 PDF 规划冒充为现有能力。
- Writing DNA 与 Academic Writing DNA 各自保存语料包和确认快照；同一批文件可以分别授权，节点切换不得跨 mode 复用状态。
- 权利回执只记录用户声明的 `self_authored/permission_granted/licensed/public_domain`；未知权利不能蒸馏，系统不自动作版权判断。
- 每个来源记录原始 SHA-256、MIME、字节数与安全问题；绝对路径和原文不得进入网页响应、日志、Git 或 Sites 包。
- v30 复用 v29 的 job executor，不建立第二套任务系统；完整溯源为 source receipt → corpus snapshot → skill package hash → DNA job → artifact manifest → `dnaUsages[]` → content revision。
- v30 不支持 DOCX、PDF、HTML、ZIP、OCR、公开 URL 或 MultiPost 发送变更；这些能力如需开发，必须作为后续版本重新设计和验收。

## v31：模型路由、双次隔离审核与可校准门禁（本地候选）

- Writer 与 Reviewer 使用 Bridge 白名单 profile 分开选择；未知模型拒绝，模型不可用不静默回退。
- Codex Sol/Terra/Luna 使用已认证 CLI；本机 Ollama/Qwen 只有最小 schema 探针时标 `experimental/minimal_schema`，不开放长文写作，完整 `/v1/content` smoke 后才可标 content ready。
- 主链为 Writer → Reviewer A 修订 → 冻结稿 → Reviewer B 隔离审核 → 逐维保守合并 → 99 门禁。低分、缺审计、审计改稿或硬否决都不能定稿或导出。
- 99 分明确标为“未校准编辑放行分”；在 20+ 样本金标集、人工盲评和硬否决误放行率报告完成前，v31 只能是 `local_candidate`。
- vendoring `humanizer-zh` 固定 commit 与许可证；当前仍需补齐 skill 执行 hash/回执和满分 evidence span，不能声称已证明“无 AI 味”。

## v32：主题证据调研与可追溯写作（已正式部署）

- 采用项目 Skill `skills/topic-evidence-research/`，输出唯一契约 `content-desk.evidence-packet.v1`；它负责资料依据，不负责代写正文。
- 参考 MIT `dimayip/research-agent` 固定提交 `5fab4dc258315e9680064b565ba49a5a07ae7895` 的查询拆解、来源分级和角色隔离方法；上游原件保持不改，宿主专用工具不进入运行时。
- Bridge 通过 `codex --search exec` 运行研究员，再用独立结构化调用审核来源、短摘录、claim 对应、冲突、版本和利益关系；审计失败不产生可写作 packet。
- 证据包由 Bridge 生成 ID、计算 SHA-256 并保存到本机；`/v1/content` 只接受 ID+hash 并在服务端重新读取校验，客户端原始 packet 不能授权研究写作。
- 高级编排中的调研节点固定在所有风格/DNA Skill 之前；快速写作选择“调研后写作”后也必须先运行调研。主题、目的、读者、领域、体裁、渠道或材料变化使现有 packet 失效。
- v32 已按用户明确要求替换 v30 公网启动页基线；真实搜索 smoke 和证据包回读已通过。带证据包的真实写作、真实浏览器点击和 99 分人工校准仍未关闭，发布记录必须继续展示这些限制。

## v33：手改版本与模型协同编辑（本地候选）

- 在快速写作和高级编排中加入永久可见的双栏编辑台，不使用弹窗或折叠隐藏关键输出。
- 手改保存通过 Bridge 追加不可变 revision，并用 `baseRevisionId + baseContentHash` 做并发校验；恢复历史也是追加新 revision，不改写旧记录。
- 模型对话只读取已保存 revision。“只讨论”不得返回候选；“局部改写”只替换选区；“重新排版”不得改变事实。候选先展示，必须人工采用并再次保存。
- v33 保持 `local_candidate`，完成真实浏览器手改保存与真实 Codex 对话 smoke 前不得替换 v32 正式部署基线。

## v34：横向主流程与阶段输出（本地候选）

- 高级编排首屏改为全宽、从左到右的主流程图；不再以“左节点库／中画布／右配置”的三栏结构作为主界面。
- 画布支持鼠标滚轮和显式按钮缩放；输入、Skill、写作、复审、门禁、工作稿与人工协作使用高辨识度颜色。
- 节点配置固定在画布下方；另设常驻“当前节点输出”，展示正文、证据包、分数、门禁决定或 revision 回执，不以状态文案冒充产物。
- 人工编辑与模型协作进入主链。候选稿仍需人工采用并追加保存，不改变 v33 的数据边界。
- v34 已完成本机浏览器结构、缩放、节点切换、输入门禁和空输出隔离检查；99 分人工盲评校准仍是公开放行阻断项。
