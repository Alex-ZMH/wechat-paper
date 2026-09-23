# 去模板化写作 Skill 调研记录

本项目只吸收可验证的编辑原则，不复制第三方代码、语料、提示词或成段文案。调研结论以原仓库、论文和许可证为准；“人工感编辑评分”衡量当前稿是否达到可提交的编辑质量，不表示“真人概率”，也不承诺绕过检测器。

## 对照资源

| 资源 | 真实用途与许可判断 | 本项目采用 | 本项目不采用 |
| --- | --- | --- | --- |
| [Hello-SimpleAI/chatgpt-comparison-detection](https://github.com/Hello-SimpleAI/chatgpt-comparison-detection) / [HC3 论文](https://arxiv.org/abs/2301.07597) | 2023 年 HC3 中英问答语料与分类器研究，不是内容生成 Skill；数据来源条款混合，仓库根目录未见统一代码许可证 | 仅把“分类器不能替代编辑质量评审”作为边界提醒 | 不复制语料/代码，不把域内分类概率当作公众号稿的 95 分质量门槛 |
| [hannsxpeter/humanizer](https://github.com/hannsxpeter/humanizer/blob/main/SKILL.md) | MIT；强调先识别作者声音、结构优先于同义词替换、不得发明事实 | 作者声音延续、意义回查、最小有效改写 | 不照搬英文标点或词表规则 |
| [thekozugroup/humanizer](https://github.com/thekozugroup/humanizer/blob/main/SKILL.md) | MIT；将确定性模式扫描与语义复审分层 | 重写后重扫、重复/同构句诊断 | 不强塞数字、日期或固定长短句配比 |
| [ashgreat/humanizer](https://github.com/ashgreat/humanizer/blob/main/SKILL.md) | MIT；偏学术英文，强调保留数字、引用和定义术语 | 保护事实、引用和术语；删除空洞路标句 | 不把长句、专业术语或三项列举单独判成 AI 痕迹 |
| [Aboudjem/humanizer-skill](https://github.com/Aboudjem/humanizer-skill/blob/main/skills/humanizer/SKILL.md) | MIT；使用多类 pattern 和迭代复查，内置分数属于启发式密度 | 引用/代码保护、模式聚类、有限轮次复查 | 不把启发式分数包装成真人概率，不接受同一模型无证据抬分 |
| [keez97/humanizer](https://github.com/keez97/humanizer/blob/main/SKILL.md) | MIT；强调硬软证据分层和防过拟合 | 只修复成簇问题，分析稿保留不确定性，禁止编造 | 不照搬英文 contractions、句长阈值或故意制造难读句 |

## 落到工作台的原创规则

1. 先锁定事实、数字、引用、定义术语、用户手改和活动批注，再做结构与语气修改。
2. 确定性扫描只负责可观察问题：模板开场、假亲历、夸张保证、模糊权威、同构标题、重复句段、未授权事实和作者修改丢失；它不推断作者身份。
3. 独立复审按事实边界、具体可执行、作者声音延续、反模板与句式变化、移动端清晰度五项解释扣分。总分和扣分必须算术一致，第二阶段低于 95 分不覆盖原稿。
4. 即使模型自报 100 分，事实漂移、漏批注、丢手改或确定性硬问题仍直接否决。
5. 外部导入稿把原文当作上一稿、用户修改当作当前权威稿；不为了“像人”改变原主张，也不补写原文没有的经历、数据或来源。

## 适用边界

短文本、标题或条目可做问题诊断，但不能把单次总分解释为统计置信度。工业和科研稿还必须经过本项目的证据授权、系统边界、因果强度和行动权限检查；去模板化不能覆盖专业错误。
