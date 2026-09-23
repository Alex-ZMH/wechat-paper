# Content Desk：个人非虚构内容工作台

本仓库包含两层：一套“本地工作台 + Codex CLI Bridge”的实际运行产品，以及一套按 MatterAI Agent Kit v2 组织的离线智能体包。产品面向个人知识创作者，公众号只是输出渠道之一。真实边界见 [FRAMEWORK.md](FRAMEWORK.md)，验收入口见 [HARNESS.md](HARNESS.md)。

## 可以做什么

- 使用快速写作和高级编排两种视图：主题/事实/范文/外部原稿/修改与批注/记忆各自分区；通用任务默认空 Skill 链，工业、Writing DNA、Academic Writing DNA 都需显式接入。
- 生成请求带可恢复的 `clientRunId`。页面刷新或直接响应丢失后可从本机 Bridge 取回已完成结果；如果稿件、brief、范文或 Skill 链已改变，必须人工选择是否采用，绝不自动覆盖。
- 根据主题生成选题角度、读者价值与文章大纲。
- 将用户提供的材料改写为完整推文：标题、导语、正文、小标题、结尾互动与配图建议。
- 对已有草稿进行结构、节奏、事实边界、标题和发布前检查。
- 支持“初次生成 / 批注重生成”双模式：把当前稿、活动批注、作者声音、受保护事实和版本号一并送入改写；每条批注返回已应用、部分应用或阻断，并可回退上一版。
- 写作前可粘贴本人或已授权范文，范文与事实材料严格分区，只学习表达、结构和节奏；每条批注可单独删除。
- 写作前可显式选择完整 Writing DNA 或 Academic Writing DNA：语料放入固定本地工作区后运行原始蒸馏技能；通用写作每次读取全部分层产物和 5 篇相关原文，学术写作按原始 Mode 2 读取完整 DNA，不使用压缩运行规则。
- Bridge 在本机分区保存最多 12 条用户明确确认的表达/结构偏好和 12 条成功流程经验。偏好只在全局批注完全应用后写入；经验不含正文或范文片段。两类记忆均可在工作台查看和删除，不能授权事实。
- 通过质量门禁后可由用户显式冻结不可变文字定稿；文字稿先处于 `assets_pending`，由其他项目补齐封面和正文图片后才形成交付清单。
- v26 通过本机 Bridge 接入 MultiPost Desktop：先以 `autoSubmit:false` 预填，全部账号 ready 后再由用户勾选并确认发送；逐账号失败只允许手动重试。
- v28 把公开 Sites 页面收缩为本地工作台启动说明，真实写作统一从 `http://127.0.0.1:43127/` 同源运行；Bridge 会重新发现已更新的 Codex CLI，不再缓存已经删除的旧路径。
- v28 增加独立 `source_rewrite`：外部原稿作为事实与观点边界真实调用 writer + reviewer，不与事实材料或风格范文混用，也不再用“只导入工作稿”冒充模型改写。
- v29 用单一 typed workflow graph 驱动快速页和高级页，执行哈希排除画布坐标；后台结果必须同时匹配执行计划与冻结输入哈希，才允许写回工作稿。
- v29 把两个 DNA 蒸馏改为可恢复的持久任务：可停止、刷新后继续观察、Bridge 重启后显式恢复，并为每个 DNA 产物和每个写作节点返回服务端哈希回执。
- v30 增加本机授权语料包：MD/TXT 先进入隔离 staging，由 Bridge 严格检查 UTF-8、大小和哈希，用户确认后冻结不可变 corpus snapshot，再把 snapshot 交给原始 Writing DNA／Academic Writing DNA 持久任务；未确认、未知权利或解析失败不改变旧语料和旧产物。
- v31 本地候选增加 Writer/Reviewer 模型路由、Reviewer A 修订 + Reviewer B 隔离审核、99 分服务端门禁和固定 commit 的 `humanizer-zh`。当前 99 分尚未完成人工金标校准，本地 Qwen 只通过最小 JSON 探针，所以 v31 不冒充已发布或已完全可用。
- 根据品牌调性与目标读者生成多个标题和开头版本。
- 对工业 AI、MES/MOM/APS/ERP/SCADA、FMEA/8D、VASP/DFT/HPC 等主题建立来源台账、claim ledger、截止日期和未决问题；厂商主张与独立证据分层。
- 对 FEMA/FMEA 与 6A 做语境路由：制造质量强语境透明规范为 FMEA，灾害/应急 FEMA 保留机构名；6A 按 6σ、API Spec 6A、铁路 6A 或企业自定义 `vendor_claim/company_specific` 分流，无线索只给候选并追问。
- 对 VASP/HPC 服务器或硬件销售，核对工作负载与 CPU/GPU、内存、存储、互联、许可证、功耗/散热、集群规模；报价/交付/保修带截止日期，未做基准测试不承诺性能、速度或 ROI，也不捆绑未授权软件。
- 对计算+实验论文，区分论文原始结论、原创转述、计算假设/DFT 结果、实验条件/表征、相关性/因果、复现与外推；不把结果“吻合”写成机理已证明。
- 用户报价、私有 benchmark、测试记录、实验数据或本地论文 PDF 只能作为受控 `user_material`：packet 只留 material_id、sha256、日期与权利/敏感性状态，不放本地路径或原始内容；文章披露“用户提供，未独立核验”。
- 在 403/429/CAPTCHA/登录拦截时 fail-closed，给出人工取回或替代来源路径，不绕过访问控制。

## 开始使用

给智能体提供尽可能多的上下文：主题、读者、目标、已有材料、希望的字数、语气、品牌禁忌和发布时间。示例：

```text
为“周末给自己留出两小时”写一篇 1200 字公众号推文。
读者是 25–35 岁的一线城市上班族，语气温和、具体、不说教。
文章目标是引导读者保存并留言。不要编造研究结论；已有素材如下：……
```

在本地工作台中，即使只给一个主题，也会直接生成可编辑正文；缺少现场材料时正文给候选假设、待补字段、验证动作和验收口径，不用“资料不足”或大纲代替文章，也不编造数字、案例或亲历。

公开地址仍停留在已部署 v30，只提供版本说明和本地启动入口，不直接跨站调用本机 CLI。双击 `start-local-workbench.cmd` 或运行 `start-local-workbench.ps1` 后，可在 `http://127.0.0.1:43127/` 验证 v31 本地候选；页面、Bridge 和 Codex CLI 共用 loopback 来源，避免公开 HTTPS 页面与本机服务之间的混乱状态。

本地工作台以通用 `nonfiction-content-writing` 规则为核心。工业研发只在明确选择时叠加 `industrial-ai-wechat-research-writing`；Writing DNA 与 Academic Writing DNA 同样显式接入并读取原始蒸馏产物。篇幅由内容形态和用户目标决定，不把 500 字当固定模板。

两个 DNA 模式的语料目录、原始 Mode 1/Mode 2 调用方式、可选 Python 依赖和失败条件见 [原始 Writing DNA 工作区说明](writing-dna-workspace/README.md)。DNA 资产由 Codex 直接读文件，不压缩成项目自定义“沉淀规则”，也不设置蒸馏、写作或复审的模型等待上限。

Research packet schema 和 Python validator 当前也是离线调研资产：Studio 没有 packet 输入，Bridge 的 packet schema 尚未与标准 fixture 统一。它们通过独立校验不等于工作台已经消费了 research packet；完成接线前不作运行能力承诺。

已有草稿时可以直接给批注。事实型批注若没有新来源，只标待核对或保留原句；改写优先保留作者原声和具体技术判断，去除空泛开场、重复套壳与无证据拔高，不以规避 AI 检测器为目标。具体契约见 `skills/industrial-ai-wechat-research-writing/references/annotation-regeneration-and-human-voice.md`。

## 目录

```text
wechat-article-writer/
  FRAMEWORK.md
  HARNESS.md
  bundle.json
  agents/wechat-article-writer/AGENT.md
  skills/nonfiction-content-writing/SKILL.md
  skills/wechat-article-writing/SKILL.md  # legacy 渠道规则
  skills/industrial-ai-wechat-research-writing/SKILL.md
  skills/industrial-ai-wechat-research-writing/references/
  skills/industrial-ai-wechat-research-writing/scripts/
  harness/cases/
  harness/rubrics/
  studio/
  codex-cli-bridge/
```

## 验证

本 bundle 遵循 MatterAI Agent Kit 的 Bundle v2 规范。若本机已有 Agent Kit，可从其根目录运行：

```bash
node bin/matterai-bundle.mjs validate "C:\\Users\\ironman\\Documents\\公众号\\wechat-article-writer"
node bin/matterai-bundle.mjs eval "C:\\Users\\ironman\\Documents\\公众号\\wechat-article-writer"
node bin/matterai-bundle.mjs pack "C:\\Users\\ironman\\Documents\\公众号\\wechat-article-writer"
```

该 bundle 不代替用户登录平台。MultiPost 接入仅通过本机外部 API 消费不可变交付清单，仍要求补图、账号登录、预填检查和用户显式确认。

研究、写作、排版和 API 发布是分层能力：本 bundle 的研究 skill 只产出证据优先的可编辑稿和来源说明，不自动登录、抓取私域、排版、创建草稿、发布或群发。`integrations/wechat-api/` 是可选的人工确认脚本层，必须按其说明配置凭证。仓库没有复制置顶项目或 GitHub 项目的代码、CRM、采集器、桌面架构或文案；公开链接只用于能力对照和安全原则。

标准库 packet 校验示例：

```bash
python skills/industrial-ai-wechat-research-writing/scripts/validate_research_packet.py \
  skills/industrial-ai-wechat-research-writing/scripts/tests/fixtures/valid-industrial-packet.json

python skills/industrial-ai-wechat-research-writing/scripts/tests/test_validate_research_packet.py -v
```

FEMA/FMEA 与 6A 的补全、定向测试、独立评分和已知评测器限制见 [终审报告](harness/reviews/fema-6a-final-review.md)。

## 对接实际公众号 API（可选）

若已在微信公众平台注册并取得 AppID 与 AppSecret，可使用 [API 对接说明](integrations/wechat-api/README.md) 在本机验证凭证。凭证只应存在于你的本机环境变量或可信部署平台，绝不能提交到仓库、打包文件或聊天记录。

已提供“凭证验证 → 上传素材 → 创建草稿”的本机脚本；草稿必须在公众号后台人工预览与审核。自动发布或群发需要你确认账号权限、平台配置和审核规则后再启用。
