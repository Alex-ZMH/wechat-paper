# 可解释编辑放行门禁 Rubric（v31）

当前状态：`uncalibrated_local_candidate`。阈值按产品要求固定为 99，但在版本化金标集和真人盲评完成前，它只能是未校准编辑分，不能作为“真人概率”“无 AI 味证明”或公开发布质量承诺。

## 评分结构

只把分数当作编辑质量记录，不把它描述成“真人概率”或 AI 检测器结果。每位 reviewer 必须在 `qualityReview.editorialScore` 返回：

- `factualBoundaries` 事实与边界：25 分；
- `specificActionability` 具体与可执行：25 分；
- `authorVoiceContinuation` 作者声音延续：20 分；
- `antiTemplateVariation` 反模板与句式变化：20 分；
- `mobileClarity` 移动端清晰度：10 分。

每项都包含 `score`、固定 `max`、扣分 `reasons` 和对应文本证据；`deductions` 逐项给出 `dimension`、`points`、`reason` 与证据。`total` 必须等于五项之和，扣分之和必须等于 `100-total`，`threshold` 固定为 99。

## 通过条件

1. Reviewer A 可修订候选稿并评分；随后冻结稿件哈希。Reviewer B 必须只审核相同冻结稿，任何正文差异都使本次审核无效。
2. 两次隔离调用均 `total >= 99`，各分项、扣分算术和文本证据一致；Reviewer B 不得读取 Reviewer A 的分数、issues、reasons 或 passed。最终编辑放行分逐维取 Reviewer A、Reviewer B 与确定性规则的最保守结果，不取平均，也不能在同分时丢掉任一方的扣分。
3. 两次 `qualityReview.passed=true`、issues 为空、所有质量检查为 true。
4. 服务端确定性扫描无空泛开场、虚构经历、夸张保证、无来源权威、机械结构、未授权数字/链接/型号或作者修改回流。
5. `currentDraft` 的数字、引语、专名、URL、用户手改和活动批注回执均通过不变量检查。
6. 虚构事实、来源、客户、亲历或数据，丢失人工修改或活动批注，模板壳，来源越界，以及无证据的 100 分均为硬否决，不能靠其他分项抵消。

任何一项失败都进入 `review_required` 或返回可解释的 `review_failed`，保留原稿，不覆盖工作台当前版本。即使模型自报 100 分，也不能绕过确定性硬门禁。

## 名称与边界

界面统一称“编辑放行分”。它不判断文字是否由 AI 生成，也不证明作者身份。外部 AI detector 只能记录为旁证；不得为了迎合 detector 故意加入错别字、语法噪声、虚构经历或破坏专业术语。

## 校准门禁

- benchmark manifest 至少包含真人优稿、模板模型稿、专业事实稿、必要编号列表、公式/型号/单位、短文/长文和对抗稿，并锁定文本 hash、标签、rubric hash 与模型配置。
- 人工评审看不到模型名和模型分数；保留排序、缺陷标签和分歧，不用“是不是 AI 写的”作真值。
- 发布前报告硬否决误放行率、误拒率、评分方差、99/100 饱和率和 A/B 分歧；硬否决误放行必须为 0。
- 未完成时，所有候选稿保持需要人工确认，release manifest 状态只能是 `local_candidate`。
