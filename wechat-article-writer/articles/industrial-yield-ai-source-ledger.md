# 《良率不是一个质检指标》来源核验台账

检索与核验日期：2026-08-07。网页可访问不等于可外推；本文以“直接支持/背景支持/部署事实”标注边界。

| 编号 | 来源 | 类型 | 支持等级 | 文中允许使用的结论 |
| --- | --- | --- | --- | --- |
| 1 | Nature Communications, *Challenges and opportunities for high-quality battery production at scale* | 同行评议 Perspective | 背景/直接 | 电池规模化质量与检验成本、吞吐、污染和产品谱系强关联；文中保留原文的特定成本示例而不外推。 |
| 2 | npj Computational Materials, *Composition and state prediction of lithium-ion cathode…* | 同行评议研究 | 直接（研究条件） | SEM 图像结合 CNN 可用于正极成分/状态分类；不得写为量产良率提升。 |
| 3 | Nature Research, *Controlling complexity inside batteries* | 机构内容/背景 | 背景 | 隔膜的安全和离子传输功能；不作为性能或商业数据来源。 |
| 4 | Communications Materials, *Impact of solid-electrolyte interphase reformation…* | 同行评议研究 | 直接（研究条件） | ML 辅助分割可支持硅基电极微结构失效分析。 |
| 5 | Nature, *Autonomous closed-loop framework for reproducible perovskite solar cells* | 同行评议研究 | 直接（特定平台） | 自动闭环研发/制备路线可行；所有性能与重复性数字仅限该研究条件。 |
| 6 | npj Computational Materials, *Automated and Scalable SEM Image Analysis…* | 同行评议研究 | 直接（研究条件） | 深度分割可量化钙钛矿缺陷/晶粒指标；量产泛化仍需企业自己验证。 |
| 7 | Nature Reviews Clean Technology, *Taking perovskite photovoltaics from promise to product* | 同行评议 Perspective | 背景 | 商业化仍受规模化、可靠性与系统级因素限制。 |
| 8–9 | NIST IRDS Metrology；NIST defect-metrology ML paper | 政府研究/论文 | 直接/背景 | 量测、缺陷检测、过程控制与良率联系紧密；阈值应按误判代价设计。 |
| 10–11 | NASA AFP inspection paper；NASA HiCAM | 研究/政府项目 | 直接/部署方向 | 复材制造适合“检测+人工复核”的闭环，不支持自治放行。 |
| 12–13 | 国家航天局行动计划；工信部低空基础设施意见 | 政策原文 | 部署/政策事实 | 智能制造、总装测试、数据和安全是产业方向；不构成项目收益证明。 |
| 14 | DHL Computer Vision logistics use cases | 企业技术材料 | 部署/技术限制 | 3D 视觉和 AI 可用于识别分拣，同时受反光、堆叠、污损标签限制。 |
| 15 | 天津经开区关于一汽-大众天津分公司黑灯物流 | 政府转载企业案例 | 部署事实 | 10 套视觉、153 台 AMR 为该公开案例的实施事实；不得泛化为行业 ROI。 |

## 内部数据的最低验证门槛

1. 原始数据由设备/系统直接导出，保留不可改写的时间戳与批次主键。
2. 每个质量标签标明来源：在线仪器、人工复核、破坏性分析或客户反馈。
3. 模型验证按时间和设备切分，单独报告漏检、误杀、拒判和人工接管率。
4. 财务归因必须与基线、排产变化、物料变化和质量措施分开记录；不得将相关性写成因果收益。
