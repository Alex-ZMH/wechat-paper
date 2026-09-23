---
name: industrial-ai-wechat-research-writing
description: 面向工业智能体、工业/研发/科研大模型、MES/MOM/APS/ERP/SCADA、质量过程工具、VASP/DFT/HPC 与计算+实验论文，进行证据优先的公众号选题、调研、写作和审校；不自动登录、发布、群发或抓取需登录内容。
---

# 工业 AI 公众号调研写作

主题涉及工业智能体/工业或科研大模型、MES/MOM/APS/ERP/SCADA、FMEA/FEMA/8D/APQP/PPAP/SPC/MSA/6A、VASP/DFT/HPC、服务器销售或计算+实验论文时使用；其余交给 `wechat-article-writing`。

## 硬边界

- 不登录、发布、群发或抓取私域/付费墙内容，不绕过 robots.txt、验证码、403/429。厂商页只证明厂商主张，不能单独证明 ROI、性能或普遍效果。
- 区分 `fact`、`vendor_claim`、`inference`、`opinion`，推断写依据和不确定性。无资料的 topic-only 也交付实用正文并列出假设/缺失/核对项；不得用“还需调研”代替正文或编造数字、案例、引语、客户、亲历。
- 篇幅按形态、证据和目标；500 字仅范围示例，不固定。

## 术语与专业方案

- 制造质量语境将 `FEMA` 透明写为“FMEA（Failure Mode and Effects Analysis，原文 FEMA）”；灾害/应急/美国机构保留 `FEMA`。企业自定义先核对全称、版本/来源，资料不足不代写。FMEA 是前置风险分析；按需区分 DFMEA、PFMEA、FMEA-MSR，不混 RPN、AP 或付费标准。
- `6A` 路由：DMAIC/波动/西格玛→`6σ`；井口/采油树/阀门/PSL→`API Spec 6A`；铁路机车/制动/防火/高压绝缘/供电/走行/视频→车载安全防护系统；企业命名标 `vendor_claim/company_specific`，不外推。无线索给最多 3 个候选，只问一个问题。
- 专业方案必须写：问题边界/异常族；数据对象、测量系统、分母/时间窗、事件主键；局部因/共因（跨站点≠共因）；支持证据/反证/缺数；MES/QMS/SCADA/设备/批次/变更衔接；动作、责任、权限/审批；FMEA/8D/CAPA/控制计划落点；试点、基线、指标和验收证据。无基线只给测量方法，不编目标数/案例。

## VASP/HPC 与计算+实验

- 出售 VASP 服务器/HPC 先收集工作负载和 CPU/GPU、内存、存储、互联、许可证、功耗/散热、节点规模；无基准不写跑分、速度、ROI 或保证，报价/库存/交付/保修带 `as_of` 并人工核对。
- 遵守 VASP License Agreement 和官方 AI 指南。默认模型不得接收 source code、PP/POTCAR/PAW、修改内容、许可证凭证或秘密，不训练/微调/克隆；遇到标 `manual_required`，仅在用户确认许可后处理合法 logs、outputs、simulation results。
- 计算+实验文章分开写原始结论、转述、计算假设/DFT、实验条件/表征、相关性/因果和复现限制；“吻合”不等于机理证明。报价、私有 benchmark、实验数据或本地 PDF 只登记 `user_material`，原文/路径/URL/凭证不入模型。

## 证据优先工作流（非工作台运行链）

当前本地内容工作台以本文件作为专业写作入口：不联网、不读取本 Skill 的调研 `references/`，也不生成或校验 research packet。用户显式选择 Writing DNA 时是例外，只按后文路由读取对应原始 DNA Skill、其要求的 docs/scripts、蒸馏产物和原文。topic-only 应按已有简报写出完整正文，把缺失事实标为假设/待核对；不得暗示已完成在线调研。只有调用方另行提供联网工具或 research packet 时，才执行以下调研步骤。

1. 简报写清受众、主问题、形态、截止日期、地区/行业、篇幅目标和禁用断言。
2. 需要调研时按 [research-workflow](references/research-workflow.md) 检索标准/政府机构/论文 DOI/期刊官网/厂商一手材料；按 [web-access-policy](references/web-access-policy.md) 逐域串行限速、缓存去重，遇登录或 401/403/412/429/CAPTCHA 记 `blocked`/`manual_required`，不声称全景。
3. 用 sources、claims、uncertainties、retrieval_status、cutoff 组成 packet，按 [research-packet-schema](references/research-packet-schema.md) 校验；先事实，再解释、限制和判断，短摘录仅核对。
4. 交付按“准确性→作者修改→批注→专业性→人声→手机可读性”复核，标题、数字、时效、因果、术语和来源可追溯。

## 生成、批注与失败关闭

- `initial_generation`：依据简报、材料和约束从零写结构与草稿；缺证据就标假设/待核对，不补事实。
- `annotation_regeneration` 输入 `brief`、`previous_generated_draft`、作者当前 `current_draft`、未解决批注、`voice_profile`、`protected_facts`、`draft_version_id`。`current_draft` 唯一权威；先建作者修改台账，保留删改、术语、顺序、判断强度和句式，除非批注明确要求/证据冲突不得还原；版本过期先报冲突。
- 每条批注返回 `applied`/`partially_applied`/`blocked` receipt，说明改动、未采纳原因和待决定事项；部分应用仍活动。无新证据的事实批注只能待核对/保留原句。两种模式均走 Codex CLI；CLI、结构化输出或复审失败须显式报错并保留稿、批注、版本，禁止本地模板冒充；生成时锁定输入。

## Writing DNA 路由与长期记忆

- `dnaMode=writing` 时先完整读取 `skills/writing-dna-skill/SKILL.md`，严格执行原始技能，不创建或使用 compact/runtime profile。原始蒸馏至少读取 20 篇本人或明确授权的完整 `.md/.txt` 文章，保留元数据、L1-L6 分层产物和 `Writing-DNA.md`；每次 writer 与 reviewer 都必须读取全部分层产物、整合文档及按原技能选择的 5 篇相关 raw 原文。
- `dnaMode=academic` 时完整读取 `skills/academic-writing-dna-skill/SKILL.md` 及其按模式要求的 docs/scripts。蒸馏读取固定学术工作区中的 `.pdf/.docx/.md/.txt`，生成完整 `Academic-Writing-DNA.md`；写作与复审按原始 Mode 2 读取该文件，不把它重写成公众号通用规则。
- DNA 只从本机固定工作区读取和写入；选择某模式但原始蒸馏产物未就绪时必须拒绝写作，不能静默退回普通写作或用长期记忆冒充 DNA。蒸馏、写作和复审的 Codex 模型进程不设时间上限，CLI 探测和 HTTP 健康检查仍可使用短超时。
- 单次 `referenceText` 范文只学习表达、结构与节奏，不继承其中的事实、数字、观点、引语或来源；只接受作者本人或明确授权文本。本轮成功后仅记录不含范文原文/正文片段的流程经验，供下一轮选择有效的形态、语气、长度与审校强度。
- Academic Writing DNA 只在用户明确选择学术模式时启用；普通工业公众号不得自动套用论文腔、引文密度或固定论文结构。
- `writingMemory` 只来自用户明确勾选、无局部选区、类型为表达/结构、且回执为 `applied` 的用户原始批注。禁止记忆事实核对、数字/日期/结论/来源、`partially_applied`、`blocked`、模型回执或模型自动总结。
- 每次通过完整门禁的写作可自动记录一条确定性流程经验，只含内容形式、语气、目标长度、编辑评分、是否使用范文、批注数与是否有手改；不保存正文、范文片段、批注回执或事实。经验用于流程选择，不直接成为文案指令。
- 优先级固定为：本轮事实与证据 > `currentDraft` 与活动批注 > 用户选择的原始 Writing DNA > 相关 `writingMemory` > 通用文风。DNA 和记忆都不是新增事实、数据、引语、来源或客户案例的授权；冲突时服从本轮输入。
- 去模板化只作为写作后的最小编辑：白名单定位套话、机械并列、同构句、滥用冒号/破折号和虚假人格化，保持信息守恒，不以“重写得更像人”为名改变事实、立场或专业术语。

## 人的声音与 95 分门禁

- 最小有效改动，保留作者短句、节奏、犹豫和技术判断；删空泛开场、套壳排比、夸张保证、模糊权威、无对象“赋能/闭环”和机械“首先/其次/最后”。术语落到数据、动作、权限或测量口径；不以规避外部检测器为目标。常规稿最多 4 个一级标题，重生成后至少有 3 处作者声音延续。
- 第二阶段用可解释编辑 rubric，不是 AI 检测概率。`qualityReview.editorialScore` 必含整数 `total`、固定 `threshold=95`、五项 `dimensions`（事实25、可执行25、作者声音20、反模板20、移动端10），逐项分数/理由/`deductions`；分项和为 `total`、扣分和为 `100-total`。低于95、越界、算术不一致、批注/作者修改丢失或硬问题均 `review_failed`，不得覆盖权威稿或伪装通过。

## 按需参考

在工作台之外直接调用本 Skill，且任务确实提供相应工具/输入时，才按需读 references：调研→research-workflow/web-access/packet-schema；批注→[annotation-regeneration-and-human-voice](references/annotation-regeneration-and-human-voice.md) 与 [codex-cli-workbench-contract](references/codex-cli-workbench-contract.md)；编辑→[wechat-editorial-contract](references/wechat-editorial-contract.md)。不要一次性加载全部；“已写成”不等于“已发布”。
