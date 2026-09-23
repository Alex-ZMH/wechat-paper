# v31 中文生成模型、免费接口与去模板工具调研

调研日期：2026-09-01。本文只记录可核验的现状和本项目决策，不把宣传页能力等同于本机已可用。

## 1. Codex 的中文能力是不是很差

结论：目前没有证据支持“Codex 中文理解很差”。OpenAI 当前模型文档明确写明最新模型具备多语言能力；GPT-5 system card 中简体中文 translated MMLU 是知识理解类证据，但不是中文非虚构写作、专业度或“AI 味”测试。Codex system card 又明确把 Codex 定位为 agentic coding 模型，不是通用聊天产品。因此，当前问题更像任务适配、提示链膨胀、同模自写自评和门禁未校准，不能只归咎于中文理解。

本机证据：Codex 配置当前使用 `gpt-5.6-sol` 且 reasoning 为 `xhigh`。项目已经在用较强的当前模型；继续只升级模型无法修复输入串线、状态覆盖、假按钮或伪 E2E。

来源：

- OpenAI model guide：https://developers.openai.com/api/docs/models
- GPT-5 system card：https://cdn.openai.com/gpt-5-system-card.pdf
- GPT-5-Codex system card：https://cdn.openai.com/pdf/97cc5669-7a25-4e63-b15f-5fd5bdc4d149/gpt-5-codex-system-card.pdf

验证方式：使用 20 个真实中文主题，每个模型运行 3 次，冻结输入后盲评。分别记录事实边界、具体性、专业可执行性、作者声音和模板痕迹；不能拿单次好稿或模型自评分作结论。

## 2. 模型选择与“免费 API”

“免费”拆成三类：本地无 token 费用、限额免费云 API、短期新用户额度。免费服务的配额、隐私政策和可用地区会变化，运行时必须探针确认，不能在界面硬编码“永久免费”。

| 方案 | 2026-09-01 状态 | 中国大陆与隐私 | 本项目位置 |
|---|---|---|---|
| 本机 Ollama + Qwen | 本机已经安装 Ollama 与 `qwen3:8b`；无每 token API 费 | 文本留在本机；速度和质量受硬件、量化与上下文限制 | 首选免费候选；最小探针仅标 experimental，完整内容 smoke 后才可显示 fully ready |
| GLM-4.7-Flash | 智谱官方当前列为免费，提供 OpenAI 兼容接口并面向中文写作/翻译/长文本 | 需要 API key；“当前免费”不等于永久免费，敏感材料默认不上传 | 第二优先 Writer；未配置 key 时明确显示未配置 |
| ModelScope API-Inference | 有体验性日限额和 OpenAI 兼容入口 | 需要实名，体验服务不等于生产 SLA | 备用实验，不进入默认链 |
| Qwen Model Studio | 新用户/新模型通常有 90 天免费额度 | 不是长期免费 | 仅作为临时对照，不标“免费长期方案” |
| Gemini free tier | 有免费层 | 官方可用地区不含中国大陆；免费层数据条款需要单独审查 | 不作为大陆默认方案 |
| OpenRouter free | 免费模型有低日请求上限 | 路由、模型可用性和数据处理取决于上游 | 只作对照，不承诺稳定 |
| Cloudflare Workers AI | 有每日免费 neurons | 需要 Cloudflare 账户；大陆可用性和延迟不作默认承诺 | 备用，不进 v31 默认链 |

来源：

- Ollama OpenAI compatibility：https://docs.ollama.com/api/openai-compatibility
- GLM-4.7-Flash：https://docs.bigmodel.cn/cn/guide/models/free/glm-4.7-flash
- 智谱 OpenAI 兼容接口：https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
- ModelScope API-Inference 限额与非 SLA 边界：https://modelscope.cn/docs/model-service/API-Inference/limits
- Qwen 新用户免费额度：https://help.aliyun.com/zh/model-studio/new-free-quota/
- Gemini 地区：https://ai.google.dev/gemini-api/docs/available-regions
- Gemini 条款：https://ai.google.dev/gemini-api/terms
- OpenRouter FAQ：https://openrouter.ai/docs/faq
- Cloudflare Workers AI 计费：https://developers.cloudflare.com/workers-ai/platform/pricing/

v31 接口原则：Writer 与 Reviewer 分开选择；每个 provider 独立返回 `installed/configured/reachable/schemaProbe/ready`。密钥不得进入 localStorage、内容版本、prompt、日志或 release。未通过结构化响应探针的模型只能显示“实验/不可运行”，不能因为名字出现在下拉框就算接入完成。

本机实测：`qwen3:8b` 通过 `fixtures/model-provider-probe.schema.json` 的真实 Codex CLI + Ollama 极小结构化输出探针，exit 0。第一次探针继承全局 `xhigh` 时失败，因为本地 provider 不接受该推理级别；显式使用兼容值后成功。这只证明最小 schema 传输，不证明 4096 上下文下可以完成项目的长写作 prompt、Humanizer 与双审。因此当前 readiness 必须是 `experimental/minimal_schema_ready`，不能标 full content ready。

## 3. AI 味评估和改写工具

### 采用：`humanizer-zh`

项目固定采用 `holygeek00/humanizer-zh-cn` 的 `2.9.1-zh.2`，commit `401e372eeb1a91045d15ec21c2d13b9d0f7842ea`，MIT。它覆盖 33 类中文模板模式，明确保护事实、数字、引用、术语和作者声线，也明确声明自己不是 AI 检测器。项目保存原始 `SKILL.md`、`LICENSE` 与固定来源回执，不在运行时跟随 `main`。

位置：`skills/humanizer-zh/`。推荐放在候选稿之后、专业/事实复审之前，以 embedded 模式提供编辑规范；它不能授权新事实，也不能替代领域审稿。

来源：https://github.com/holygeek00/humanizer-zh-cn

### 不采用为门禁：`chatgpt-comparison-detection`

该仓库主要是 2023 年 HC3 中英文问答数据、早期 ChatGPT detector 与训练代码，不是可直接串联的 Agent Skill；数据来源许可混合，也不能代表 2026 年模型。它可以作历史研究参考，不能 vendoring 到本项目或作为 99 分裁决器。

来源：https://github.com/Hello-SimpleAI/chatgpt-comparison-detection

### 可选旁证：`llmlint`

`notnotype/llmlint` 提供中文模式检查，但采用 AGPL-3.0，部分 detect 流程可能访问外部服务。若未来使用，只允许以隔离进程调用本地 `check`，不复制源码、不上传私稿，并单独完成许可证和网络审计。

来源：https://github.com/notnotype/llmlint

### 为什么不使用 detector 做硬门禁

OpenAI 曾下线自己的 AI 文本分类器，理由是准确率低。研究也记录了误判和可规避性。因此 99 分只能表示“达到本项目定义的编辑放行标准”，不能表示“99% 像真人”或“1% AI”。

来源：

- OpenAI classifier 说明：https://openai.com/index/new-ai-classifier-for-indicating-ai-written-text/
- detector 偏差研究：https://doi.org/10.1016/j.patter.2023.100779
- detector 可靠性研究：https://doi.org/10.1007/s40979-023-00146-z
- detector 规避研究：https://arxiv.org/abs/2303.11156

## 4. v31 决策

1. 默认保留 Codex Sol；增加显式 Writer/Reviewer 分离选择。
2. 首个无需云 key 的替代 Writer 候选是本机 `qwen3:8b`；只有完成真实 `/v1/content` smoke 并产生可验证回执后才开放完整写作。极小 JSON 探针只开放实验标识，不开放生产写作。
3. GLM-4.7-Flash 作为大陆可用的限额免费云候选；没有 key 时不冒充 ready，敏感科研与客户材料默认使用本机模型。
4. 固定 `humanizer-zh` 作为去模板编辑规范；评分仍由独立 reviewer 与确定性硬门禁共同决定。
5. 99 分不取平均。任何虚构、人工修改丢失、批注遗漏、来源越界和模板壳都是硬否决。
