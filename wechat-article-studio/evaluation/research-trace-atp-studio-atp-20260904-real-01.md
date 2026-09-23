# 凹凸棒石研究运行内部追踪（studio-atp-20260904-real-01）

- 主题：凹凸棒石在新能源领域面临的挑战与实际应用
- 开始：2026-09-04T04:02:22.629Z
- 结束：2026-09-04T04:17:24.587Z
- 总耗时：901960 ms
- 结果：failed

## 阶段时间线

- request_received（0 ms，2026-09-04T04:02:22.636Z）
- request_sent（5 ms，2026-09-04T04:02:22.641Z）
- research_retrieval（283 ms，2026-09-04T04:02:22.910Z）
- research_audit（644808 ms，2026-09-04T04:13:07.435Z）
- research_cancel（900009 ms，2026-09-04T04:17:22.645Z）
- idle（900009 ms，2026-09-04T04:17:22.756Z）
- client_timeout（900121 ms，2026-09-04T04:17:22.757Z）
- request_finished（900122 ms，2026-09-04T04:17:22.758Z）

## 错误/取消记录

- 2026-09-04T04:17:22.662Z cancel_response: {"attempted":true,"attemptedAt":"2026-09-04T04:17:22.645Z","status":"accepted","httpStatus":200,"code":"cancel_requested","matchedClientRunId":true,"body":{"ok":true,"status":"cancelling","code":"cancel_requested","stage":"research_audit","clientRunId":"studio-atp-20260904-real-01"}}
- 2026-09-04T04:17:22.662Z cancel_response: {"attempted":true,"attemptedAt":"2026-09-04T04:17:22.645Z","status":"accepted","httpStatus":200,"code":"cancel_requested","matchedClientRunId":true,"body":{"ok":true,"status":"cancelling","code":"cancel_requested","stage":"research_audit","clientRunId":"studio-atp-20260904-real-01"}}
- 2026-09-04T04:17:22.756Z cancel_release_health: {"timestamp":"2026-09-04T04:17:22.756Z","elapsedMs":900009,"event":"cancel_release_health","schemaVersion":"wechat-article-studio.research-trace.v1","baseUrl":"http://127.0.0.1:43127","timeoutMs":900000,"profileMapping":{"writer":{"requested":"codex-sol","mapped":{"provider":"codex-cli","model":"gpt-5.6-sol"}},"reviewer":{"requested":"codex-sol","mapped":{"provider":"codex-cli","model":"gpt-5.6-sol"}}},"topic":"凹凸棒石在新能源领域面临的挑战与实际应用","stage":"idle","endpoint":"http://127.0.0.1:43127/health","httpStatus":200,"busy":false}
- 2026-09-04T04:17:22.756Z cancel_release_health: {"timestamp":"2026-09-04T04:17:22.756Z","elapsedMs":900009,"event":"cancel_release_health","schemaVersion":"wechat-article-studio.research-trace.v1","baseUrl":"http://127.0.0.1:43127","timeoutMs":900000,"profileMapping":{"writer":{"requested":"codex-sol","mapped":{"provider":"codex-cli","model":"gpt-5.6-sol"}},"reviewer":{"requested":"codex-sol","mapped":{"provider":"codex-cli","model":"gpt-5.6-sol"}}},"topic":"凹凸棒石在新能源领域面临的挑战与实际应用","stage":"idle","endpoint":"http://127.0.0.1:43127/health","httpStatus":200,"busy":false}
- 2026-09-04T04:17:22.757Z error: {"name":"ContractError","code":"research_timeout","message":"Bridge research timed out after 900000 ms"}
- 2026-09-04T04:17:22.757Z error: {"name":"ContractError","code":"research_timeout","message":"Bridge research timed out after 900000 ms"}
- 2026-09-04T04:17:22.759Z research_error: {"name":"ContractError","code":"research_timeout","message":"Bridge research timed out after 900000 ms","details":{"timeoutMs":900000,"classification":"studio_timeout","phase":"client_timeout","clientRunId":"studio-atp-20260904-real-01","cancel":{"attempted":true,"attemptedAt":"2026-09-04T04:17:22.645Z","status":"accepted","httpStatus":200,"code":"cancel_requested","matchedClientRunId":true,"body":{"ok":true,"status":"cancelling","code":"cancel_requested","stage":"research_audit","clientRunId":"studio-atp-20260904-real-01"},"release":{"status":"released","last":{"httpStatus":200,"busy":false,"stage":"idle"}}}}}

该文件为开发端审计记录；不得作为读者文章内容。
