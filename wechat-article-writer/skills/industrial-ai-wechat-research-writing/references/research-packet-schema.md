# Research packet schema（v1）

校验器是标准库实现的结构校验，不替代人工判断。JSON 顶层字段如下：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `schema_version` | string | 固定 `industrial-research-packet.v1` |
| `packet_id` | string | 非空且在 packet 内稳定 |
| `topic` | string | 非空，写清问题而非只写产品名 |
| `content_type` | enum | `flash`、`tool_review`、`standard_analysis`、`deep_research`、`case_review` |
| `cutoff` | ISO date | 研究截止日 |
| `research_status` | enum | `complete`、`partial`、`blocked`、`manual_required` |
| `retrieval_status` | enum | 同上；可与 research_status 不同 |
| `sources` | array | 普通来源有唯一 `id`、`title`、`organization`、`url`、`source_level`、`access_status`、`usage_status`、`retrieved_at`；`user_material` 明确禁止 `url`（避免 signed URL/token 泄露），仅保留 material_id+hash 元数据；可选 `usage_notes`、`published_at`、`effective_at`、`version`；`partial` 来源还需 `coverage` 或 `evidence_scope` |
| `claims` | array | 每项有唯一 `id`、`text`、`kind`、`source_ids`；事实还需可用来源 |
| `uncertainties` | array | 每项有唯一 `id`、`text`，可选 `claim_ids` |

`source_level` 可取 `standard`、`government`、`official`、`research_institution`、`academic`、`industry_association`、`vendor`、`exchange`、`secondary`、`user_material`。`access_status` 可取 `accessible`、`partial`、`blocked`、`manual_required`（不要把研究总状态 `complete` 当作来源访问状态）。`usage_status` 必填，可取 `allowed`、`metadata_only`、`manual_required`、`unknown`；只有 `usage_status=allowed` 且 `access_status` 为 `accessible`/`partial` 的来源可支撑事实。其他状态只能保留 URL/标题等元数据或写入 uncertainty，不能把正文或摘录输入模型，也不能被 claim 当作内容证据。

`source_level=user_material` 是受控层级，适用于用户提供的报价、benchmark、测试记录、实验数据或本地论文 PDF。它禁止 `url`（包括 signed URL），只保留安全 material_id+hash 元数据；必须有安全 `material_id`、64 位十六进制 `sha256`、ISO `as_of`、`rights_confirmed=true`、`sensitivity_reviewed=true` 和 `usage_status=allowed` 才能支撑事实；`organization`、`title`、`retrieved_at` 仍必填，且事实 claim 的 `as_of` 不得晚于 packet `cutoff`。user-material source 只允许标量元数据字段：`id`、`title`、`organization`、`source_level`、`access_status`、`usage_status`、`retrieved_at`、`material_id`、`sha256`、`as_of`、`rights_confirmed`、`sensitivity_reviewed`、`usage_notes`、`material_kind`、`content_class`、`notes`、`coverage`、`evidence_scope` 及明确的布尔受保护标志（如 `contains_restricted_vasp_material`、`contains_credentials`）；未知字段、dict/list、绝对/UNC/file URI、本地路径、原始内容、凭证或秘密一律拒绝。`partial` user-material 只需写 `coverage`/`evidence_scope`，不使用 `evidence_quotes`。权利/敏感性不清或包含 VASP source、PP database、POTCAR/PAW dataset、修改内容、许可证凭证、账号和保密材料时，只能 `manual_required`/`metadata_only`，不能支撑 claim；可用 `contains_restricted_vasp_material=true` 或 `material_kind`/标题等元数据显式标记受保护材料。

`kind` 可取 `fact`、`definition`、`metric`、`case_result`、`vendor_claim`、`inference`、`opinion`。`fact`、`definition`、`metric`、`case_result` 必须有至少一个 `accessible` 或 `partial` 来源；厂商来源不能被标作独立证据。`vendor_claim` 必须含 `vendor`，至少引用一个可用的 `source_level=vendor` 来源，并把 `evidence_class` 写成 `vendor_claim`，不可写 `independent`。没有来源的 `inference`/`opinion` 可以通过，但必须提供 `evidence_class` 和简短 `basis`，让读者知道这是作者推理或建议而非事实。

当 `research_status` 或 `retrieval_status` 为 `complete` 时，packet 必须有非空 `sources` 与 `claims`，且至少一个来源为 `accessible`/`partial`。`partial`、`blocked`、`manual_required` 状态即使暂时没有来源或主张，也必须有 `uncertainties` 解释未覆盖范围、阻断原因或待人工核对项。若事实主张只由非 `user_material` 的 `partial` 来源支持，该来源必须写非空 `coverage`/`evidence_scope`，并在该 claim 的 `evidence_quotes` 中出现；`partial` user-material 只需 coverage/evidence_scope，禁止 evidence_quotes。`published_at`、`effective_at`、`version` 不清楚时可以留空，但必须在 `uncertainties` 中说明；截止日期之后发布的来源不能支撑截止日期内的事实 claim。

事实类 claim 不得混用可用厂商来源与独立来源来升级 provenance：非 `vendor_claim` 的事实、定义、指标或案例结果只要引用任何可用厂商来源就必须拆成独立 claim；`vendor_claim` 只引用厂商来源，需要独立核验时另建非厂商 claim。仅由可用厂商来源支撑的事实、定义、指标或案例结果必须标为 `vendor_claim`，不得改成独立事实。

引用 `user_material` 的事实 claim 必须使用严格字段集合 `id`、`text`、`kind`、`source_ids`、`evidence_class`（可选布尔 `independent_evidence=false`）；引用 user-material 的 `inference`/`opinion` 可另带标量 `basis`。所有这些 claim 都不得带未知字段、嵌套对象、原始内容/路径/凭证或 `evidence_quotes`；`inference`/`opinion` 同样必须 `evidence_class=user_material`、`independent_evidence=false`（如出现）且不得混其他 provenance。不得标 `independent` 或 `vendor_claim`，也不得与其他 source level 混成一条事实。claim 的 `text` 和 `basis` 同样不能出现受保护 VASP/PP/POTCAR/PAW/凭证词、超过 500 字或绝对/相对本地路径；正文应披露“用户提供，未独立核验”（如适用）。

非 `user_material` claim 可带 `evidence_quotes`，每个元素为 `{source_id, text}`。短摘录只为核对，建议不超过 240 个字符；校验器会拒绝空摘录、未知 source id 或超长摘录。user-material 原文只在外部人工核对，不进入 packet。正文应原创转述，不复制摘要、图表、图注或大段原文。

## 最小示例

```json
{
  "schema_version": "industrial-research-packet.v1",
  "packet_id": "demo-2026-01",
  "topic": "MES、MOM 与 APS 的边界",
  "content_type": "standard_analysis",
  "cutoff": "2026-01-31",
  "research_status": "complete",
  "retrieval_status": "complete",
  "sources": [{
    "id": "S1", "title": "Job Shop Scheduling", "organization": "Google for Developers",
    "url": "https://developers.google.com/optimization/scheduling/job_shop",
    "source_level": "official", "access_status": "accessible", "usage_status": "allowed", "retrieved_at": "2026-01-31"
  }],
  "claims": [{
    "id": "C1", "text": "Google 的 Job Shop 页面展示了带约束的排程建模。",
    "kind": "fact", "source_ids": ["S1"],
    "evidence_quotes": [{"source_id": "S1", "text": "Job Shop Scheduling"}]
  }],
  "uncertainties": []
}
```
