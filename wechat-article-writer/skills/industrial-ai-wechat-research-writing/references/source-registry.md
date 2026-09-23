# 工业调研来源注册表

本表是检索起点，不是“已核验全部内容”的清单。访问时记录抓取日期、截止日期和状态；页面能访问只说明页面当时可见，不自动证明其中的效果主张。厂商页面只能证明厂商发布了什么，不能独立证明 ROI、性能、客户案例或行业普遍结论。

注册表条目本身不预先授予摄入许可；packet 中的 `usage_status` 默认按 `unknown`，只有实际检查服务条款、版权/许可后才能记 `allowed`。`metadata_only`/`manual_required` 只保留链接和元数据。

## 标准、协会与方法

| 机构/来源 | 链接 | 适用主张 | 层级 | 访问提示与局限 |
| --- | --- | --- | --- | --- |
| ISA | [ISA-95 导航入口](https://www.isa.org/standards-and-publications/isa-standards/isa-95-standard) | 企业、制造运营、控制层的术语和边界入口 | standard | 该条目默认只作 link-only 导航，`usage_status=manual_required`：不要直接摄入或摘要受许可限制的页面正文。正式术语须由用户有权访问的标准、许可材料或允许使用的替代官方说明人工核对；产品映射仍需实施资料 |
| MESA | [MESA](https://mesa.org/)、[MESA model](https://mesa.org/topics-resources/mesa-model/) | 早期制造运营模型和术语背景 | industry_association | MESA 已公告于 2026-06-30 停止运营，内容转由 ISA 接续；今后优先 ISA，历史页面仅作背景 |
| AIAG/VDA | [FMEA 手册](https://www.aiag.org/training-and-resources/manuals/details/FMEAAV-1) | FMEA 方法、表格和评分语境 | industry_association | 可能需要购买手册；不得把摘要或培训页当完整标准文本 |
| AIAG | [AIAG/VDA FMEA 手册公告与 7 步背景](https://blog.aiag.org/its-here...claim-your-copy-of-the-new-aiag-vda-fmea-handbook-today) | AIAG 对新手册、七步方法和培训语境的公开说明 | industry_association | 仅支持“AIAG 发布了什么”和方法导航；不复制付费手册，不把博客当完整标准或所有行业规则 |
| AIAG | [Quality Core Tools](https://www.aiag.org/expertise-areas/quality/quality-core-tools) | APQP、PPAP、FMEA、MSA、SPC 等工具总览 | industry_association | 版本和客户要求需另行核对 |
| ASQ | [Eight Disciplines (8D)](https://asq.org/quality-resources/eight-disciplines-8d) | 8D 的公开方法说明 | industry_association | 公开说明不等于某客户的内部模板 |
| ASQ | [Six Sigma](https://asq.org/quality-resources/six-sigma) | Six Sigma 概念和质量改进语境 | industry_association | 不能把所有“6A”自动解释为 Six Sigma；需有 DMAIC/波动/西格玛线索 |
| ASQ | [DMAIC](https://asq.org/quality-resources/dmaic) | Define、Measure、Analyze、Improve、Control 流程语境 | industry_association | 公开方法说明不是特定企业的认证或效果证明 |
| American Petroleum Institute | [API Spec 6A 重要标准公告](https://www.api.org/products-and-services/standards/important-standards-announcements/spec-6a) | 石油天然气井口和采油树设备规范入口 | standard | 记录版本和 addendum；21 版及 2024 addendum 只作当时有效性提醒，不宣称永久最新，正文/标准许可需人工核对 |
| American Petroleum Institute | [API Monogram 最新更新](https://www.api.org/products-and-services/api-monogram-and-apiqr/latest-updates) | API 认证/标准更新线索 | standard | 不能从认证标志推导设备性能或合规全貌；版本和许可边界需核对 |
| ISO | [ISO 10423:2022](https://www.iso.org/standard/79588.html) | 石油天然气钻井和生产设备、井口与采油树补充标准入口 | standard | 标准正文可能受购买/许可限制；只作导航和版本线索，不直接摘要受限全文 |

## 调度、制造软件与工业 AI

| 机构/产品 | 链接 | 可支持的主张 | 层级 | 局限 |
| --- | --- | --- | --- | --- |
| Google OR-Tools | [Job Shop Scheduling](https://developers.google.com/optimization/scheduling/job_shop) | 官方示例展示约束调度建模方式 | official | 示例不代表某工厂交付效果 |
| Siemens Opcenter | [Advanced Planning and Scheduling](https://www.siemens.com/en-us/products/opcenter/advanced-planning-scheduling-aps/) | Siemens 发布的产品定位和能力 | vendor | 不能单独证明实施 ROI、排程改善或客户效果 |
| Siemens | [Industrial Copilot](https://www.siemens.com/en-us/company/insights/generative-ai-industrial-copilot/) | Siemens 发布的 Industrial Copilot 能力、集成与安全叙述 | vendor | 页面是厂商材料；客户数量、效率或停机变化需另找独立/原始披露 |
| SAP | [Digital Manufacturing](https://www.sap.com/products/scm/digital-manufacturing.html) | SAP 发布的产品范围和集成叙述 | vendor | 版本、区域和许可条件需核对 |
| ABB | [Genix Copilot](https://new.abb.com/process-automation/genix/abb-genix-copilot) | ABB 发布的 Genix/Copilot 能力主张 | vendor | 厂商主张需单列，不当独立证据 |
| Microsoft | [Industrial AI in action / Factory Operations Agent](https://www.microsoft.com/en-us/microsoft-cloud/blog/manufacturing/2025/03/25/industrial-ai-in-action-how-ai-agents-and-digital-threads-will-transform-the-manufacturing-industries/) | Microsoft 发布的工业智能体、Industrial Copilot 与 Factory Operations Agent 叙述 | vendor | 新闻稿/博客不是独立评测；名称、版本和范围按原页核对 |
| NVIDIA | [Factory Operations blueprint](https://blogs.nvidia.com/blog/factory-operations-fox-blueprint-ai-brain/) | NVIDIA 发布的工厂运营 blueprint 叙述 | vendor | 不据此推导普遍部署结果 |
| Microsoft Research | [MatterGen](https://www.microsoft.com/en-us/research/workbench/project/mattergen) | 项目介绍和公开研究方向 | research_institution | 论文、代码、模型卡和实验条件需分开核查 |
| Microsoft Research | [Materials / MatterSim](https://www.microsoft.com/en-us/research/project/materials/) | MatterSim 等材料研究项目入口 | research_institution | 项目页面不能替代论文实验细节 |
| DeepModeling | [DeePMD-kit documentation](https://docs.deepmodeling.com/projects/deepmd/en/latest/) | 软件用途、安装和接口 | official | 文档不等于生产性能或材料结论 |

## VASP、HPC 与硬件规格入口

以下入口只用于许可证、官方文档和原始规格核对；注册表不预先授予摄入许可，packet 的 `usage_status` 仍须逐页检查。厂商基准只能记为 `vendor_claim`，不能直接升级为独立性能或 ROI 证据。

| 机构/来源 | 链接 | 可支持的主张 | 层级 | 访问提示与局限 |
| --- | --- | --- | --- | --- |
| VASP Software GmbH | [VASP 官方主页](https://vasp.at/) | 官方产品入口、许可证/文档导航、版本线索 | official | VASP 软件受许可证约束；默认 `usage_status=unknown`，不上传、转发或暗示捆绑未授权软件 |
| VASP Software GmbH | [许可证 FAQ](https://vasp.at/info/faq/purchase_vasp/) | 许可证购买和合法来源提示 | official | 仅作许可边界核对，不替用户购买或转让许可证；不得把硬件报价写成含 VASP |
| VASP Software GmbH | [AI 使用指南](https://vasp.at/info/post/ai-use-guide/) | AI 使用 VASP 时的软件、源码、PP 数据、保密材料和输出分析边界 | official | License Agreement 优先；源码、PP database、修改内容、凭证和保密材料设 `manual_required`，不得输入公共/消费级或未正确配置 AI；合法 outputs/logs 仅在不泄露受保护材料时人工确认后分析 |
| VASP Software GmbH | [Terms of Use](https://vasp.at/footer/termsofuse/) | 网站服务条款、版权与商标边界入口 | official | 默认 `usage_status=unknown`，逐页检查服务条款；不把网站条款或商标页面当作软件许可证，不复制受限内容 |
| VASP Software GmbH | [VASP Wiki Welcome](https://vasp.at/wiki/Welcome) | 工作负载、并行与内存需求需按应用测试的官方提醒 | official | 页面明确不替用户推荐具体硬件；正文使用前须检查许可，不能据此给出型号承诺 |
| VASP Software GmbH | [安装 VASP](https://vasp.at/wiki/Installing_VASP.6.X.X) | license holder 下载源码和安装前提 | official | 只有有权用户才能从 Portal 获取源码；不提供盗版、镜像或未授权安装包 |
| VASP Software GmbH | [OpenACC GPU port](https://vasp.at/wiki/OpenACC_GPU_port_of_VASP) | NVIDIA OpenACC 支持与 AMD/Intel offload 状态等官方说明 | official | 不把实验性支持写成生产保证；消费级 GPU 的 FP64/ECC/显存和功能缺口须单独核对 |
| VASP Software GmbH | [Memory requirements](https://vasp.at/wiki/Memory_requirements) | 内存需求随体系、算法和并行方式变化的入口 | official | 不能从页面推导固定内存容量；需要用户输入规模和短 benchmark |
| VASP Software GmbH | [NCORE / 并行优化](https://vasp.at/wiki/NCORE) | 非平凡生产任务先做短 benchmark scan 的优化线索 | official | benchmark 条件、版本、编译器和输入必须记录，不能改写成普遍加速比例 |
| NVIDIA | [Data Center GPU](https://www.nvidia.com/en-us/data-center/) | GPU 型号、显存、互联等厂商规格入口 | vendor | 原始规格页不是独立性能证据；厂商 benchmark 只能记 `vendor_claim`，默认不记 `allowed` |
| AMD | [EPYC Server Processors](https://www.amd.com/en/products/processors/server/epyc.html) | CPU 型号和官方规格入口 | vendor | 规格不等于 VASP 工作负载性能；需按输入规模、编译和并行设置测试 |
| Intel | [Xeon Processors](https://www.intel.com/content/www/us/en/products/details/processors/xeon.html) | CPU 型号和官方规格入口 | vendor | 规格不等于跨平台 benchmark；价格、库存和交付另行人工核对 |
| OpenHPC | [OpenHPC community](https://openhpc.community/) | HPC 软件栈和社区入口 | official | 社区资料不替代具体集群厂商的支持、许可或性能承诺 |

## 中国官方、研究机构与公开企业材料

| 机构/来源 | 链接 | 适用主张 | 层级 | 访问提示与局限 |
| --- | --- | --- | --- | --- |
| 工业和信息化部 | [“人工智能+制造”专项行动实施意见](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2026/art_01010414608a4226b30687773bb21bdf.html) | 政策文本、目标、行动安排 | government | 政策目标不能写成已实现成效；页面可能改版 |
| 工业和信息化部/国家数据局 | [2026“模数共振”行动](https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2026/art_ba07e09d40834ec992615490fd2ccd18.html) | 政策行动原文和范围 | government | 同上，需注明发布日期和截止日期 |
| 中国信通院 | [工业智能创新发展报告（2026）](https://www.caict.ac.cn/kxyj/qwfb/ztbg/202603/P020260330598512806510.pdf) | 研究机构对工业智能的分析 | research_institution | 企业案例效果仍要回到企业披露或独立证据核验 |
| 中国信通院 | [科研智能：人工智能赋能工业仿真研究报告（2025）](https://www.caict.ac.cn/kxyj/qwfb/ztbg/202510/P020251020499183907925.pdf) | 科研智能/工业仿真研究综述 | research_institution | 报告观点和案例不等于独立实证 |
| 市场监管总局 | [国家标准全文公开系统](https://std.samr.gov.cn/gb/) | 标准检索入口 | government | 动态页面或访问限制时登记 `manual_required`，不绕过 |
| 国家知识产权局 | [重点产业专利信息服务平台](https://chinaip.cnipa.gov.cn/) | 专利检索线索 | government | 动态/登录限制时仅作待人工核对入口 |
| 国家知识产权局 | [人工智能相关发明专利申请指引（试行）](https://www.cnipa.gov.cn/art/2024/12/31/art_66_196988.html) | 专利申请审查指引原文 | government | 不能从指引推导企业技术成效 |
| 国家铁路局 | [6A 系统相关公开说明](https://www.nra.gov.cn/ztzl/hd/cxdh/cxcg/tkjj/201705/t20170502_146749.shtml) | 机车车载安全防护系统（6A 系统）的铁路语境和组成线索 | government | 只支持铁路语境说明；不把 6A 系统外推为质量六步法或其他行业标准，页面时效和正文使用需核对 |
| Federal Emergency Management Agency | [FEMA 官方定义入口](https://www.fema.gov/node/404557) | 灾害/应急管理语境中的 FEMA 机构名称和职责线索 | government | 该条目用于保留 FEMA=Federal Emergency Management Agency，不改成 FMEA；按页面许可与截止日期核对 |
| 交易所 | [上海证券交易所](https://www.sse.com.cn/)、[深圳证券交易所](https://www.szse.cn/) | 企业年报、公告、风险披露 | exchange | 只引用公开文件中的明确表述；避免把管理层预测写成事实 |
| DOI/Crossref 与期刊官网 | [doi.org](https://doi.org/)、[Nature](https://www.nature.com/) | 论文 DOI、版本和期刊正文入口核对 | academic | DOI 只定位论文，不代表摘要或结论已被读取；具体论文正文和补充材料需回到对应期刊官网核对 |

## 企业自定义 6A 案例

| 机构/来源 | 链接 | 适用主张 | 层级 | 访问提示与局限 |
| --- | --- | --- | --- | --- |
| 英威腾 | [6A 服务/管理案例](https://www.invt.com.cn/news-detail-1928-52) | 英威腾发布的企业自定义“6A”服务或管理体系案例 | vendor | 只能标 `vendor_claim/company_specific`，不能外推为统一行业标准、Six Sigma 或 API/铁路 6A |

## 访问安全与分层参考

| 主题 | 链接 | 用法与限制 |
| --- | --- | --- |
| 机器人规则 | [RFC 9309](https://www.rfc-editor.org/rfc/rfc9309.html) | 尊重 robots.txt，不将其当作绕过授权的障碍 |
| 限流状态 | [RFC 6585](https://www.rfc-editor.org/info/rfc6585/) | 429 等状态触发保守停止和人工替代 |
| HTTP 语义 | [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html) | 按状态码和方法处理请求 |
| HTTP 缓存 | [RFC 9111](https://www.rfc-editor.org/rfc/rfc9111.html) | 允许缓存、ETag、Last-Modified，减少重复请求 |
| 微信开发者文档 | [微信开放文档](https://developers.weixin.qq.com/doc/) | 本轮普通抓取失败且可见浏览器受安全策略阻止，登记 `manual_required`，不继续绕过 |
| Markdown 排版工具 | [doocs/md](https://github.com/doocs/md) | 仅用于说明排版是独立层；不复制代码或文案 |
| 全链路技能示例 | [wechat-skill](https://github.com/843645440/wechat-skill)、[wechat-article-pipeline-skill](https://github.com/jhwreal/wechat-article-pipeline-skill) | 仅比较公开的“研究—草稿—人工核对”原则，不写易变星标，不复制实现 |
| 其他写作技能示例 | [wechat-article-writer](https://github.com/wxhou/wechat-article-writer/blob/main/SKILL.md) | 仅作边界对照；本 skill 不虚构个人经历或踩坑故事 |
| 发布层示例 | [baoyu-post-to-wechat](https://github.com/JimLiu/baoyu-skills/blob/main/skills/baoyu-post-to-wechat/SKILL.md) | 仅说明发布层应与研究层分离；不自动发布 |
