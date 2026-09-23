# Web fail-closed Rubric

- 403、429、CAPTCHA、登录或安全拦截分别记录为 `blocked` 或 `manual_required`。
- 立即停止绕过，给出官方替代来源或人工取回路径，并保留失败时间和截止日期。
- 开始取回前检查服务条款、版权/许可和 robots.txt；若明确禁止 AI 摄入/派生/自动处理，只保留链接与元数据，标 `manual_required`，不把正文或摘录输入模型。
- 不换代理、模拟指纹、复用 cookie，也不声称已经抓取完整资料。
