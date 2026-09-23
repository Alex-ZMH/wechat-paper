import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { createArgumentMap } from '../src/contracts/argument-map.mjs';
import { createBrief } from '../src/contracts/brief.mjs';
import { createDraft } from '../src/contracts/draft.mjs';
import { createEvidencePacket } from '../src/contracts/evidence-packet.mjs';
import { reviewDraft } from '../src/contracts/review-report.mjs';
import { createStyleProfile } from '../src/contracts/style-profile.mjs';
import { createWechatPackage } from '../src/contracts/wechat-package.mjs';
import { createWriterRequest } from '../src/contracts/writer.mjs';
import { fetchCodexWriter } from '../src/adapters/codex-writer.mjs';

const styleProfile = createStyleProfile({
  name: '清楚、具体、克制',
  principles: ['先说事实，再说判断', '每一节只推进一个新问题', '用具体例子替代空泛形容词'],
  avoid: ['宏大口号', '同义反复', '没有来源的确定性断言'],
  samples: [{ sampleId: 'eval-style-1', title: '示例', text: '先把问题拆成可以核对的主张，再决定文章如何推进。' }],
});

const cases = [
  {
    id: 'ai-trust',
    brief: { topic: 'AI 文章为什么说得通顺仍不等于可信？', purpose: '解释流畅表达与可信判断的差别，并给读者一套核对 AI 内容的方法。', audience: '会使用 AI、但担心被错误信息误导的普通读者', channel: '微信公众号', targetLength: 700 },
    sources: [
      { sourceId: 'nist-ai-rmf', title: 'NIST AI Risk Management Framework', url: 'https://www.nist.gov/itl/ai-risk-management-framework', publisher: 'NIST', sourceType: 'official', excerpt: 'NIST 将可信 AI 描述为需要同时关注有效性与可靠性、安全、韧性、问责与透明、可解释性、隐私和公平等特征；单独满足某一项并不能保证整体可信。' },
      { sourceId: 'google-helpful-content', title: 'Creating Helpful, Reliable, People-First Content', url: 'https://developers.google.com/search/docs/fundamentals/creating-helpful-content', publisher: 'Google Search Central', sourceType: 'official', excerpt: 'Google 建议创作者检查内容是否提供原创研究或分析、清晰来源和实质价值，并警惕只是改写其他来源或制造夸张确定性的内容。' },
    ],
    claims: [
      { claimId: 'trust-1', text: '流畅和完整的表达只能说明文本像一篇文章，不能单独证明内容有效、可靠或透明。', evidenceIds: ['nist-ai-rmf'], confidence: 0.9 },
      { claimId: 'trust-2', text: '核对 AI 内容时，应寻找清晰来源和实质分析，而不是把改写其他来源当成原创价值。', evidenceIds: ['google-helpful-content'], confidence: 0.9 },
    ],
    points: [
      { pointId: 'trust-point-1', order: 1, heading: '通顺是表面指标，不是可信证明', thesis: '读起来顺滑只解决表达问题，可信判断还需要有效性、可靠性和透明度等证据。', claimIds: ['trust-1'] },
      { pointId: 'trust-point-2', order: 2, heading: '把核对动作放回来源和分析', thesis: '判断一段 AI 内容是否值得相信，要追问来源、原创分析和它没有覆盖的边界。', claimIds: ['trust-2'] },
    ],
  },
  {
    id: 'structured-writing',
    brief: { topic: '为什么高质量写作工作流需要结构化输出？', purpose: '说明标题、章节、段落和证据绑定为何比一大段纯文本更适合协作审稿。', audience: '正在搭建 AI 写作流程的编辑和产品开发者', channel: '微信公众号', targetLength: 700 },
    sources: [
      { sourceId: 'codex-noninteractive', title: 'Codex non-interactive mode', url: 'https://learn.chatgpt.com/docs/non-interactive-mode', publisher: 'OpenAI', sourceType: 'official', excerpt: 'Codex 文档说明，脚本可以用 --output-schema 要求最终响应符合 JSON Schema，并用 -o 将最终 JSON 写入文件，供下游步骤消费。' },
      { sourceId: 'responses-reference', title: 'Responses API reference: structured outputs', url: 'https://developers.openai.com/api/reference/cli/resources/responses/methods/create', publisher: 'OpenAI', sourceType: 'official', excerpt: 'Responses API 的 text.format 支持 json_schema；为响应提供 JSON Schema 可以让支持该能力的模型按指定结构返回数据。' },
    ],
    claims: [
      { claimId: 'structure-1', text: '脚本化写作流程可以用 output schema 固定最终响应的字段，并把 JSON 文件交给下游步骤。', evidenceIds: ['codex-noninteractive'], confidence: 0.95 },
      { claimId: 'structure-2', text: '结构化输出不是把纯文本再解析一次，而是让模型按 JSON Schema 返回可验证的字段。', evidenceIds: ['responses-reference'], confidence: 0.95 },
    ],
    points: [
      { pointId: 'structure-point-1', order: 1, heading: '先把文章拆成可检查的字段', thesis: '标题、导语、章节和段落一旦成为字段，编辑才能逐项检查逻辑与证据绑定。', claimIds: ['structure-1'] },
      { pointId: 'structure-point-2', order: 2, heading: '结构化不是格式装饰', thesis: 'Schema 的价值在于让下游知道哪些字段存在、怎样验证，而不是把一段话假装成 JSON。', claimIds: ['structure-2'] },
    ],
  },
  {
    id: 'readable-longform',
    brief: { topic: '长文章为什么不能只靠加粗和换行来提高可读性？', purpose: '从标题层级和段落结构出发，解释长文章怎样降低读者的阅读负担。', audience: '写公众号长文、教程和研究解读的内容编辑', channel: '微信公众号', targetLength: 700 },
    sources: [
      { sourceId: 'w3c-writing', title: 'Writing for Web Accessibility – Tips for Getting Started', url: 'https://www.w3.org/WAI/tips/writing/', publisher: 'W3C WAI', sourceType: 'official', excerpt: 'W3C WAI 指出，超过三四段的文档需要标题和小标题来帮助可用性与无障碍；短标题还能提供内容大纲和跳转线索。' },
      { sourceId: 'w3c-content-structure', title: 'WAI Content Structure', url: 'https://www.w3.org/WAI/tutorials/page-structure/content/', publisher: 'W3C WAI', sourceType: 'official', excerpt: 'W3C 建议用语义化 section 和 heading 组织主题，用 p 标记段落；一致的段落样式有助于阅读，也让用户更容易调整呈现方式。' },
    ],
    claims: [
      { claimId: 'read-1', text: '超过三四段的长文需要标题和小标题来提供大纲、导航和阅读线索。', evidenceIds: ['w3c-writing'], confidence: 0.95 },
      { claimId: 'read-2', text: '语义化的 section、heading 和 paragraph 不只是视觉排版，也帮助技术和读者理解内容结构。', evidenceIds: ['w3c-content-structure'], confidence: 0.95 },
    ],
    points: [
      { pointId: 'read-point-1', order: 1, heading: '标题先回答读者要去哪里', thesis: '长文的标题层级应该形成一张可扫描的地图，而不是把所有重点都交给加粗。', claimIds: ['read-1'] },
      { pointId: 'read-point-2', order: 2, heading: '段落结构要有语义而不只是空行', thesis: '把内容标记为 section、heading 和 paragraph，读者和工具才能识别每部分承担的任务。', claimIds: ['read-2'] },
    ],
  },
  {
    id: 'mof-solid-electrolyte',
    brief: {
      topic: 'MOF（金属有机框架材料）用于固态电解质，是否具备商业化前景？',
      purpose: '面向投资人评估 MOF 固态电解质的技术路线、证据强度、制造成本、客户验证和未来 3—8 年产业机会；完成证据表后再形成文章。',
      audience: '关注锂电材料、固态电池和新材料产业化的投资人',
      channel: '微信公众号',
      targetLength: 1100,
    },
    sources: [
      { sourceId: 'mof5-2013', title: 'Enhanced electrochemical performance of PEO composite polymer electrolyte by nano-MOF-5', url: 'https://www.sciencedirect.com/science/article/pii/S0378775313008070', publisher: 'Journal of Power Sources', publishedAt: '2013', sourceType: 'paper', excerpt: '在 PEO-LiTFSI（EO:Li=10:1）中加入 10 wt% MOF-5，25 °C 电导率为 3.16×10^-5 S cm^-1；60 °C 稳定窗口 4.57 V；LiFePO4/Li 电池 80 °C、1 C 循环 100 次容量保持率 45%，对照约 30 次后衰减。' },
      { sourceId: 'mof688-2019', title: 'A Metal-Organic Framework of Organic Vertices and Polyoxometalate Linkers as a Solid-State Electrolyte', url: 'https://yaghi.berkeley.edu/pdfPublications/19MOFSSE.pdf', publisher: 'Journal of the American Chemical Society', publishedAt: '2019-10-23', sourceType: 'paper', excerpt: 'MOF-688 在 -40–60 °C 做多次 EIS，20 °C 和 30 °C 电导率分别为 3.4×10^-4 和 4.6×10^-4 S cm^-1，Li+ 迁移数约 0.87；样品离子交换后用无水丙烯碳酸酯（PC）溶剂化，论文同时展示了室温 Li|MOF-688|LiFePO4 原型电池。' },
      { sourceId: 'mof-review-2025', title: 'Solid-State Electrolytes for Lithium Metal Batteries: State-of-the-Art and Perspectives', url: 'https://advanced.onlinelibrary.wiley.com/doi/10.1002/adfm.202411171', publisher: 'Advanced Functional Materials', publishedAt: '2025', sourceType: 'review', excerpt: '综述汇总 UiOLiTFSI 约 2.1×10^-4 S cm^-1、tLi+ 0.84，以及 UiO-66-based 约 5.1×10^-4 S cm^-1；同时指出 MOF/COF 仍多为实验室小规模，成本和规模化数据不足。' },
      { sourceId: 'mof-scale-2025', title: 'Techno-economic assessment of scale-up of metal-organic framework production', url: 'https://www.sciencedirect.com/science/article/pii/S0019452225007514', publisher: 'Journal of Industrial and Engineering Chemistry', publishedAt: '2025', sourceType: 'paper', excerpt: '以 1 吨 MOF 为目标的技术经济模型估算初始投资约 €330k–€968k、年成本约 €596k–€1.62m；作者强调原料、溶剂和工艺选择对商业化成本影响很大。' },
    ],
    claims: [
      { claimId: 'mof-route', text: 'MOF 固态电解质至少有三类路线：骨架主导的离子导电体系、MOF/聚合物复合膜，以及含离子液体或塑化剂的准固态/界面复合体系。', evidenceIds: ['mof5-2013', 'mof688-2019', 'mof-review-2025'], confidence: 0.9, caveat: 'MOF-688 的原型含 PC 溶剂化，不能不加限定地写成“无液体全固态”；文献中的“固态”命名必须按配方和电池结构逐篇核对。' },
      { claimId: 'mof-performance', text: '部分 MOF 材料在室温达到 10^-4 S cm^-1 量级电导率并取得数百圈实验室循环，但数据集中于特定骨架、含溶剂化/复合膜和 LFP 或低负载电池。', evidenceIds: ['mof688-2019', 'mof-review-2025'], confidence: 0.85, caveat: 'MOF-688 的 PC 溶剂化和 UiOLiTFSI 的 PVDF 复合必须单独标注；综述数字需回溯原始论文，不能由单点电导率推出 EV 级厚电极表现。' },
      { claimId: 'mof-cost', text: 'MOF 的规模制造和成本仍是未解决变量；公开模型显示实验室估算的 MOF 电解质成本远高于成熟聚合物或氧化物，但放大后的真实成本尚无统一实测报价。', evidenceIds: ['mof-review-2025', 'mof-scale-2025'], confidence: 0.85, caveat: '模型不是成交价，需用电池级原料、溶剂回收、良率和干燥能耗重算。' },
      { claimId: 'mof-commercial', text: '基于当前证据，MOF 更可能先以复合电解质、界面层、隔膜或添加剂等辅助材料局部商业化，而非在 3—8 年内全面替代硫化物或氧化物主电解质。', evidenceIds: ['mof5-2013', 'mof-review-2025', 'mof-scale-2025'], confidence: 0.7, kind: 'inference', caveat: '这是基于性能、规模和成本证据的推断，不是来源直接证明的市场事实。' },
    ],
    points: [
      { pointId: 'mof-point-1', order: 1, heading: '先分清三条路线', thesis: '独立骨架、聚合物复合和准固态体系的证据不能混在一起比较。', claimIds: ['mof-route'] },
      { pointId: 'mof-point-2', order: 2, heading: '实验室性能不等于产品性能', thesis: '10^-4 S cm^-1 和循环数据说明技术可行，但还缺厚电极、批次和长周期验证。', claimIds: ['mof-performance'] },
      { pointId: 'mof-point-3', order: 3, heading: '商业化卡在制造和成本', thesis: '放大工艺、溶剂与配体成本、质量一致性和客户验证决定能否跨过实验室。', claimIds: ['mof-cost'] },
      { pointId: 'mof-point-4', order: 4, heading: '投资人应押注辅助材料场景', thesis: '未来 3—8 年更可验证的切入口是复合膜、界面层或隔膜添加剂，而不是替代成熟主电解质。', claimIds: ['mof-commercial'] },
    ],
  },
  {
    id: 'sodium-ion-outlook',
    brief: { topic: '钠离子电池会先在哪些场景商业化？', purpose: '解释钠离子电池的资源、性能和产业化边界，避免把示范项目写成全面替代锂电。', audience: '关注储能和电池产业的投资人', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'iea-ev-2024', title: 'Global EV Outlook 2024', url: 'https://www.iea.org/reports/global-ev-outlook-2024', publisher: 'International Energy Agency', publishedAt: '2024', sourceType: 'official', excerpt: 'IEA 将钠离子电池视为锂离子电池的补充路线，优势包括不依赖锂、镍和钴，但能量密度通常低于主流锂离子电池，商业化仍处于早期。' },
      { sourceId: 'catl-na-2021', title: 'CATL Unveils Its Latest Breakthrough Technology by Releasing Its First Generation of Sodium-ion Batteries', url: 'https://www.catl.com/en/news/665.html', publisher: 'CATL', publishedAt: '2021-07-29', sourceType: 'company', excerpt: '宁德时代公开发布第一代钠离子电池，公告称电芯能量密度最高 160 Wh/kg、-20 °C 容量保持率超过 90%，并给出钠锂混合 AB 电池包方案；公司公告属于企业披露，不等同于全行业量产事实。' },
    ],
    claims: [
      { claimId: 'na-complement', text: '钠离子电池更适合被评估为锂电的补充路线；IEA 将其视为早期补充技术，CATL 公告则给出 160 Wh/kg 和 -20 °C 容量保持率超过 90% 的企业数据，但这些指标不能外推为全行业表现。', evidenceIds: ['iea-ev-2024', 'catl-na-2021'], confidence: 0.85, caveat: 'CATL 数据是企业公告，需用第三方和量产数据复核。' },
      { claimId: 'na-proof', text: '企业发布产品和混合系统方案说明产业在推进，但公告本身不能证明大规模交付、成本优势或客户普遍采用。', evidenceIds: ['catl-na-2021'], confidence: 0.9, caveat: '需要进一步核验出货量、良率和真实订单。' },
    ],
    points: [
      { pointId: 'na-point-1', order: 1, heading: '资源优势不是全部答案', thesis: '钠离子路线的价值要和能量密度、体积利用率一起衡量。', claimIds: ['na-complement'] },
      { pointId: 'na-point-2', order: 2, heading: '发布产品和卖出产品是两回事', thesis: '产业判断要继续追问交付和客户验证。', claimIds: ['na-proof'] },
    ],
  },
  {
    id: 'battery-recycling',
    brief: { topic: '动力电池回收为什么不等于一门稳赚的生意？', purpose: '从材料价值、回收率和供应链周期解释电池回收的商业风险。', audience: '关注新能源产业链的投资人', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'iea-critical-minerals', title: 'Global Critical Minerals Outlook 2024', url: 'https://www.iea.org/reports/global-critical-minerals-outlook-2024', publisher: 'International Energy Agency', publishedAt: '2024', sourceType: 'official', excerpt: 'IEA 指出，回收能够在中长期降低对原生关键矿产供应的需求，但回收供给的形成还取决于收集和再处理体系；这不是对短期利润的直接预测。' },
      { sourceId: 'doe-recell', title: 'ReCell Research', url: 'https://recellcenter.org/research/', publisher: 'U.S. Department of Energy', publishedAt: '2024', sourceType: 'government', excerpt: '美国能源部 ReCell 的研究覆盖直接回收、材料分离和工艺标准化，目标是让回收材料达到可重复的性能和质量。' },
    ],
    claims: [
      { claimId: 'recycle-supply', text: '回收的长期资源价值明确，但短期供给量受退役电池数量和收集体系制约，不能用远期资源量推导当前利润。', evidenceIds: ['iea-critical-minerals'], confidence: 0.9 },
      { claimId: 'recycle-process', text: '直接回收和材料分离的工艺研究，反映出回收企业仍需解决杂质、批次波动和产品一致性。', evidenceIds: ['doe-recell'], confidence: 0.85 },
    ],
    points: [
      { pointId: 'recycle-point-1', order: 1, heading: '先看有没有足够的料', thesis: '回收商业模式首先受退役节奏和收集网络约束。', claimIds: ['recycle-supply'] },
      { pointId: 'recycle-point-2', order: 2, heading: '再看回收出来能不能卖', thesis: '工艺路线必须稳定地产出客户愿意接收的材料。', claimIds: ['recycle-process'] },
    ],
  },
  {
    id: 'perovskite-commercial',
    brief: { topic: '钙钛矿太阳能的效率优势，距离产品化还差什么？', purpose: '区分实验室效率、组件可靠性和产业化制造，评估钙钛矿的近期机会。', audience: '关注光伏技术和制造业的投资人', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'nrel-efficiency', title: 'Best Research-Cell Efficiencies', url: 'https://www.nlr.gov/pv/cell-efficiency', publisher: 'National Laboratory of the Rockies', publishedAt: '2026-07-17', sourceType: 'research_institution', excerpt: '国家实验室公开维护研究电池效率图表，钙钛矿及钙钛矿/硅叠层路线在研究电池效率上处于高位；研究电池纪录不等于量产组件效率。' },
      { sourceId: 'doe-perovskite', title: 'Perovskite Solar Cells', url: 'https://www.energy.gov/cmei/systems/perovskite-solar-cells', publisher: 'U.S. Department of Energy', publishedAt: '2024', sourceType: 'government', excerpt: '美国能源部将稳定性、耐久性、规模化制造和银行可融资性列为钙钛矿太阳能走向商业化需要解决的问题。封装是工程化时需要单独验证的实现路径，不在此摘录中冒充 DOE 的原话。' },
    ],
    claims: [
      { claimId: 'pv-record', text: '钙钛矿路线的研究电池效率优势是真实的，但纪录值不能直接代表大面积组件的效率和良率。', evidenceIds: ['nrel-efficiency'], confidence: 0.95 },
      { claimId: 'pv-gap', text: '稳定性、耐久性、规模化制造和银行可融资性是从实验室纪录走向产品的关键缺口。', evidenceIds: ['doe-perovskite'], confidence: 0.9 },
    ],
    points: [
      { pointId: 'pv-point-1', order: 1, heading: '纪录先回答能不能做到', thesis: '实验室效率证明材料体系有潜力，但还没有回答大面积生产。', claimIds: ['pv-record'] },
      { pointId: 'pv-point-2', order: 2, heading: '产品要经受时间和工厂', thesis: '稳定性、封装、良率和设备兼容性决定商业化。', claimIds: ['pv-gap'] },
    ],
  },
  {
    id: 'green-hydrogen',
    brief: { topic: '绿氢项目为什么常常宣布得快、落地得慢？', purpose: '解释绿氢项目从宣布到投资决策之间的成本、基础设施和承购约束。', audience: '关注能源转型和基础设施投资的读者', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'iea-hydrogen', title: 'Global Hydrogen Review 2024', url: 'https://www.iea.org/reports/global-hydrogen-review-2024', publisher: 'International Energy Agency', publishedAt: '2024', sourceType: 'official', excerpt: 'IEA 指出，低排放氢项目管线增长，但最终投资决定、需求承购、基础设施和成本仍是从宣布走向建设的主要约束。' },
      { sourceId: 'irena-green-hydrogen', title: 'Green Hydrogen Cost Reduction', url: 'https://www.irena.org/-/media/Files/IRENA/Agency/Publication/2020/Dec/IRENA_Green_hydrogen_cost_2020.pdf', publisher: 'International Renewable Energy Agency', publishedAt: '2020-12-17', sourceType: 'official', excerpt: 'IRENA 将可再生电力成本、电解槽利用率与性能、设备成本、规模化和标准化列为绿氢成本下降的核心因素。' },
    ],
    claims: [
      { claimId: 'h2-announce', text: '绿氢项目宣布数量不能直接等同于建成产能，承购、基础设施和最终投资决定是关键筛选条件。', evidenceIds: ['iea-hydrogen'], confidence: 0.9 },
      { claimId: 'h2-cost', text: '绿氢成本对电价、电解槽利用率、设备成本和项目规模高度敏感。', evidenceIds: ['irena-green-hydrogen'], confidence: 0.9 },
    ],
    points: [
      { pointId: 'h2-point-1', order: 1, heading: '先区分宣布和开工', thesis: '项目管线只有在承购和融资闭合后才更接近真实产能。', claimIds: ['h2-announce'] },
      { pointId: 'h2-point-2', order: 2, heading: '成本取决于利用率', thesis: '电价和设备利用率会决定绿氢能否和化石路线竞争。', claimIds: ['h2-cost'] },
    ],
  },
  {
    id: 'direct-air-capture',
    brief: { topic: '直接空气捕集是气候技术，还是昂贵的能源转换？', purpose: '用能耗、成本和永久封存条件拆解 DAC 的真实商业化边界。', audience: '关注气候科技的投资人', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'iea-dac', title: 'Direct Air Capture 2022', url: 'https://www.iea.org/reports/direct-air-capture-2022', publisher: 'International Energy Agency', publishedAt: '2022', sourceType: 'official', excerpt: 'IEA 认为 DAC 可从稀薄空气中去除 CO2，但能耗和成本较高，规模化需要低碳能源、技术改进和可靠的 CO2 运输与封存基础设施。' },
      { sourceId: 'doe-carbon-negative', title: 'Carbon Negative Shot Strategy', url: 'https://www.energy.gov/hgeo/carbon-negative-shot-strategy', publisher: 'U.S. Department of Energy', publishedAt: '2025', sourceType: 'government', excerpt: '美国能源部的 Carbon Negative Shot 战略以降低碳去除成本为目标，强调碳去除必须可测量、可验证并实现长期储存。' },
    ],
    claims: [
      { claimId: 'dac-energy', text: 'DAC 的难点不是能否吸附 CO2，而是以足够低的能耗和成本持续处理空气。', evidenceIds: ['iea-dac'], confidence: 0.9 },
      { claimId: 'dac-permanence', text: '没有可测量、可验证的长期储存，捕集量不能自动等同于气候减排量。', evidenceIds: ['doe-carbon-negative'], confidence: 0.9 },
    ],
    points: [
      { pointId: 'dac-point-1', order: 1, heading: '捕集只是第一步', thesis: '项目经济性受空气处理能耗和热源、电源条件约束。', claimIds: ['dac-energy'] },
      { pointId: 'dac-point-2', order: 2, heading: '还要证明碳真的留下', thesis: '永久储存和 MRV 决定 DAC 是否具备可交易的减排属性。', claimIds: ['dac-permanence'] },
    ],
  },
  {
    id: 'crispr-therapy',
    brief: { topic: '首款 CRISPR 疗法获批后，基因编辑商业化还要过几关？', purpose: '从监管批准、适应证和生产交付区分科学突破与可复制商业模式。', audience: '关注生物医药投资的读者', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'fda-casgevy', title: 'FDA Approves First Gene Therapies to Treat Patients with Sickle Cell Disease', url: 'https://www.fda.gov/news-events/press-announcements/fda-approves-first-gene-therapies-treat-patients-sickle-cell-disease', publisher: 'U.S. Food and Drug Administration', publishedAt: '2023-12-08', sourceType: 'government', excerpt: 'FDA 于 2023 年批准 Casgevy，这是首个获批使用 CRISPR/Cas9 的疗法，用于符合条件的镰状细胞病患者；同一公告还说明了适应证和临床获益边界。' },
      { sourceId: 'vertex-casgevy', title: 'Vertex and CRISPR Therapeutics Announce US FDA Approval', url: 'https://investors.vrtx.com/news-releases/news-release-details/vertex-and-crispr-therapeutics-announce-us-fda-approval', publisher: 'Vertex Pharmaceuticals', publishedAt: '2023-12-08', sourceType: 'company', excerpt: 'Vertex 公告说明 Casgevy 的一次性细胞治疗流程、适用患者和商业化推进；企业公告需与监管文件分开看待，不能单独证明支付方接受度。' },
    ],
    claims: [
      { claimId: 'crispr-first', text: '监管批准证明某一 CRISPR 疗法在特定适应证上达到获批标准，但不等于基因编辑已成为普遍、低成本的治疗平台。', evidenceIds: ['fda-casgevy'], confidence: 0.95 },
      { claimId: 'crispr-delivery', text: '一次性细胞治疗的商业化还取决于患者筛选和复杂的生产交付；支付方接受度属于需要另行验证的商业化问题。', evidenceIds: ['vertex-casgevy'], confidence: 0.8, kind: 'inference', caveat: 'Vertex 企业公告支持产品流程和商业化推进，但不能直接证明支付方接受度、真实可及性或长期随访结果。' },
    ],
    points: [
      { pointId: 'crispr-point-1', order: 1, heading: '批准是起点不是终点', thesis: '监管成功只覆盖特定产品和适应证。', claimIds: ['crispr-first'] },
      { pointId: 'crispr-point-2', order: 2, heading: '交付决定商业规模', thesis: '个体化细胞治疗的生产、医院网络和支付是平台化的现实门槛。', claimIds: ['crispr-delivery'] },
    ],
  },
  {
    id: 'heat-pumps',
    brief: { topic: '热泵普及的瓶颈是技术，还是家庭账单？', purpose: '从效率、初始投资和运行成本解释热泵在不同气候与电价下的采用条件。', audience: '关注能源消费和清洁技术投资的普通读者', channel: '微信公众号', targetLength: 650 },
    sources: [
      { sourceId: 'iea-heat-pumps', title: 'The Future of Heat Pumps', url: 'https://www.iea.org/reports/the-future-of-heat-pumps', publisher: 'International Energy Agency', publishedAt: '2022', sourceType: 'official', excerpt: 'IEA 指出，热泵通常比化石燃料锅炉更高效，但高前期成本、安装工人短缺和建筑改造会影响普及速度；政策和能源价格决定回收期。' },
      { sourceId: 'energy-star-heat-pump', title: 'Air-Source Heat Pumps', url: 'https://www.energystar.gov/about/federal-tax-credits/air-source-heat-pumps', publisher: 'ENERGY STAR', publishedAt: '2024', sourceType: 'government', excerpt: 'ENERGY STAR 对合格空气源热泵和补贴条件作出定义，提醒消费者按设备效率、气候和安装条件比较全年成本。' },
    ],
    claims: [
      { claimId: 'heat-efficiency', text: '热泵的效率优势需要结合当地电价、气候和建筑条件才能转化为家庭账单优势。', evidenceIds: ['iea-heat-pumps', 'energy-star-heat-pump'], confidence: 0.9 },
      { claimId: 'heat-adoption', text: '高前期成本、安装能力和补贴可得性会决定热泵采用速度，不能只用设备能效推导市场渗透。', evidenceIds: ['iea-heat-pumps', 'energy-star-heat-pump'], confidence: 0.9 },
    ],
    points: [
      { pointId: 'heat-point-1', order: 1, heading: '效率不等于立刻省钱', thesis: '账单结果由电价、气温和建筑共同决定。', claimIds: ['heat-efficiency'] },
      { pointId: 'heat-point-2', order: 2, heading: '安装环节同样重要', thesis: '前期成本和服务网络决定技术能否被家庭采用。', claimIds: ['heat-adoption'] },
    ],
  },
];

async function runCase(item) {
  const brief = createBrief({ ...item.brief, authorName: '文章工作台评测组', tone: styleProfile.name, materials: [] });
  const evidencePacket = createEvidencePacket(brief, {
    sources: item.sources.map((source) => ({ ...source, sourceOrigin: source.sourceOrigin ?? 'human_curated' })),
    claims: item.claims,
  });
  const argumentMap = createArgumentMap(brief, evidencePacket, { points: item.points, status: 'confirmed' });
  const writerRequest = createWriterRequest({ brief, evidencePacket, argumentMap, styleProfile, provider: 'codex-cli', model: process.env.WRITER_MODEL || 'gpt-5.6-sol', clientRunId: `real-eval-${item.id}` });
  const writerResponse = await fetchCodexWriter(writerRequest, { model: writerRequest.model, timeoutMs: Number(process.env.WRITER_TIMEOUT_MS || 240000) });
  const draft = createDraft(brief, argumentMap, {
    ...writerResponse.draftInput,
    briefId: brief.briefId,
    argumentMapId: argumentMap.mapId,
    styleProfileId: styleProfile.styleProfileId,
    parentIds: [brief.briefId, evidencePacket.packetId, argumentMap.mapId, writerRequest.requestId, writerResponse.responseId, styleProfile.styleProfileId],
  });
  const reviewReport = reviewDraft({ brief, evidencePacket, argumentMap, draft, styleProfile });
  const wechatPackage = createWechatPackage({ brief, evidencePacket, argumentMap, draft, review: reviewReport });
  return { id: item.id, brief, evidencePacket, argumentMap, writerRequest, writerResponse, draft, reviewReport, wechatPackage };
}

const runs = [];
const failures = [];
const selectedCases = process.env.WRITER_EVAL_CASES
  ? cases.filter((item) => process.env.WRITER_EVAL_CASES.split(',').map((value) => value.trim()).includes(item.id))
  : cases;
if (selectedCases.length === 0) throw new Error('WRITER_EVAL_CASES did not select any known case');
for (const item of selectedCases) {
  console.error(`running ${item.id}`);
  try {
    runs.push(await runCase(item));
  } catch (error) {
    failures.push({ id: item.id, code: error?.code || 'evaluation_failed', message: error instanceof Error ? error.message : String(error) });
    console.error(`failed ${item.id}: ${failures.at(-1).code}`);
  }
}
const outputPath = resolve(process.env.WRITER_EVAL_OUTPUT || 'evaluation/real-writer-runs.json');
await mkdir(dirname(outputPath), { recursive: true });
let outputRuns = runs;
if (process.env.WRITER_EVAL_APPEND === 'true') {
  try {
    const existing = JSON.parse(await readFile(outputPath, 'utf8'));
    const replacementIds = new Set(runs.map((run) => run.id));
    outputRuns = [...(existing.runs || []).filter((run) => !replacementIds.has(run.id)), ...runs];
  } catch {
    outputRuns = runs;
  }
}
const outputModels = [...new Set(outputRuns.map((run) => run.writerResponse?.model).filter(Boolean))];
await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), provider: 'codex-cli', model: outputModels.length === 1 ? outputModels[0] : 'mixed', runs: outputRuns, failures }, null, 2));
console.log(JSON.stringify(runs.map((run) => ({ id: run.id, title: run.draft.title, status: run.reviewReport.status, packageStatus: run.wechatPackage.status, score: run.reviewReport.score, sections: run.draft.sections.length, paragraphs: run.draft.sections.flatMap((section) => section.paragraphs).length })), null, 2));
if (failures.length > 0) process.exitCode = 1;
