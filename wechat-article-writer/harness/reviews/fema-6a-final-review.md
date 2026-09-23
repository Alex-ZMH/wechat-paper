# FEMA/FMEA 与 6A 补全终审

评审日期：2026-08-26  
结论：可交付；无 P0、无 P1，保留 1 项已披露的非阻塞 P2。  
独立评分：98/100。

## 终审门禁

- 制造质量强语境下透明把 FEMA 规范为 FMEA；灾害/应急 FEMA 不误改。
- 企业内部 FEMA 缺少制度原文时只追问并停止，不编定义、步骤或评分。
- FMEA 七步、DFMEA/PFMEA、FMEA-MSR 与 8D 边界正确；FMEA-MSR 首次给出 `Supplemental FMEA for Monitoring and System Response` 及中文说明。
- 6A 按 6σ、API Spec 6A、铁路机车 6A 和企业自定义四条路线分流；无语境不猜。
- API 版本、Addendum、Errata 只作带截止日期的线索，不声称永久最新。
- 企业自定义 6A 只作厂商/企业自有主张，不外推为行业标准。
- AIAG/VDA、API 等付费内容只作导航和原创概括，不复制或摄入受限正文。

## 验证证据

- JSON：62/62 可解析。
- `quick_validate.py`：UTF-8 模式通过。
- research packet validator：7/7 unittest 通过。
- Python 编译检查与独立 AST 检查：通过。
- MatterAI Bundle validate：通过。
- fake eval：17/17，仅代表结构和字符串断言通过。
- 9 个 FEMA/6A 定向场景均取得真实 Luna 通过样本；冻结规则主批为 7/9，两个同义词断言修正后单独复跑 2/2。
- 自然正确否定句回归：6/6，不再被 `mustNotContain` 误杀。
- `git diff --check`：通过；工作区测试报告残留为 0。

## 已知 P2

MatterAI 当前只自动执行 `mustContain`、`mustNotContain` 和 tool-call 断言，不会自动把 rubric 作为模型裁判。因此 fake/real harness 的通过不能单独称为“自动语义验收”。本轮由独立评审智能体按 rubric 对实际规则与回答进行语义终审；后续若要全自动验收，应增加独立 rubric judge，而不是继续堆叠子字符串否定规则。

## 权威抽查入口

- [AIAG/VDA FMEA 手册与七步背景](https://www.aiag.org/training-and-resources/manuals/details/FMEAAV-1)
- [ASQ 8D](https://asq.org/quality-resources/eight-disciplines-8d)
- [ASQ DMAIC](https://asq.org/quality-resources/dmaic)
- [API Spec 6A](https://www.api.org/products-and-services/standards/important-standards-announcements/spec-6a)
- [API 更新记录](https://www.api.org/products-and-services/api-monogram-and-apiqr/latest-updates)
- [国家铁路局：机车车载安全防护系统（6A 系统）](https://www.nra.gov.cn/ztzl/hd/cxdh/cxcg/tkjj/201705/t20170502_146749.shtml)
- [FEMA 官方定义](https://www.fema.gov/node/404557)
