# 来源与主张规则

## 来源分级

`A`：标准原文、政府数据、原始论文、公开数据集、交易所披露。

`B`：独立研究机构、同行评议综述、可靠行业协会。

`C`：厂商官网、厂商案例自述、媒体报道。可证明“发布者声称了什么”，不能
单独证明独立效果、普遍性能或 ROI。

`U`：来源不明、访问受阻、日期或许可无法核验。

每个 source 都要记录 `sourceType`、`authority`、`accessStatus`、
`usageStatus`、`accessedAt`；允许正文使用的 source 必须是
`accessStatus=accessible|partial` 且 `usageStatus=allowed`。`partial` 必须
说明 coverage；`blocked`/`manual_required` 只留元数据并进入 uncertainty。

## 主张类型

- `fact`、`definition`、`metric`、`case_result`：必须绑定可用来源和 evidence 摘录。
- `vendor_claim`：必须引用 `sourceType=vendor`，并明确是厂商主张。
- `inference`、`opinion`：写 `basis`，不得伪装成来源事实。

来源冲突不静默选边：主张使用 `confidence=disputed` 或 `status=mixed`，在
`uncertainties` 写明冲突、版本、地区或时间范围，并给出下一步核对动作。

## 访问安全

遇到登录、付费墙、验证码、robots 限制、401/403/412/429 或页面明确禁止自动
处理时停止；不换代理、不模拟指纹、不复用 cookie。对 VASP 源码、PP/POTCAR、
许可证凭证、账号和保密材料，只能登记为人工核对，不输入模型。

