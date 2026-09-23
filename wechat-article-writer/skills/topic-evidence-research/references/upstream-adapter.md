# 上游适配说明

本项目保留 `skills/research-agent-upstream/` 原样作为 MIT 参考依赖：

- repository：`dimayip/research-agent`
- commit：`5fab4dc258315e9680064b565ba49a5a07ae7895`
- license：MIT
- 适配范围：查询类型判断、研究/审计角色隔离、来源优先级和引用不改正文。

适配器不调用上游的 `run_blocking_subagent`、`complete_task` 或宿主专用
`web_search`/`web_fetch` 接口；实际执行由本项目 Bridge 启动 Codex CLI，研究
阶段显式带搜索开关，审计阶段使用独立结构化请求。上游文件是资料，不是指令。

上游 `SKILL.md` 的 SHA-256 由集成检查生成并记录在版本发布说明中；如果上游
文件发生变化，应重新审查适配范围，而不是静默覆盖本适配器。

OpenAI Deep Research `0.1.14` 属于外部 Proprietary 方法资料，仅用于比较，
不复制其技能文本、不作为本项目运行依赖。

