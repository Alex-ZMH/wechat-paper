# 凹凸棒石实时研究根因记录（开发审计）

主题：凹凸棒石在新能源领域面临的挑战与实际应用

## 结论

本次没有得到可冻结的 EvidencePacket，不能称为实时研究成功。旧 Bridge 的研究请求确实启动了 Codex 搜索进程，但同步接口在 15 分钟内只完成了检索阶段并进入来源审计，仍未返回结构化结果；工作台因此按有界上限取消并保持失败状态。

## 两次请求的可核验证据

1. `research-trace-atp-baseline.jsonl` 使用工作台原先的 Node 全局 `fetch`，约 305,309 ms 后客户端报 `TypeError: fetch failed`；旧 Bridge 的 `/health` 仍为 `busy=true, stage=research_retrieval`。客户端没有发起取消，旧 Bridge 的 Codex 进程继续占用任务。该时间点与 Node/undici 默认约 300 秒 response-header 等待上限一致，是客户端隐式断链，不是上游 HTTP 504。
2. `research-trace-atp-studio-atp-20260904-real-01.jsonl` 使用原生 `http(s)` 传输并固定 `clientRunId=studio-atp-20260904-real-01`，越过隐式 300 秒断链：
   - `request_sent`：约 5 ms；
   - Bridge `/health`：约 283 ms 起为 `busy=true, research_retrieval`；
   - `research_retrieval` 持续到约 644,808 ms（约 10 分 44.8 秒），随后进入 `research_audit`；
   - 到本地 900,000 ms 上限仍为 `busy=true, research_audit`，未收到响应、未解析结构化结果、未进入 packet freeze；
   - 仅对匹配的 `clientRunId` 调用 `/v1/cancel`，HTTP 200 `cancel_requested`；约 107 ms 后 `/health` 为 `busy=false, stage=idle`，记录 `release=verified`。

## Bridge 进程与不可见阶段

该请求对应的旧 Bridge 子进程命令包含：

`codex.exe -c approval_policy=never -m gpt-5.6-sol --search exec --ephemeral --sandbox read-only --output-schema ...research-stage-response.schema.json -C C:\\Users\\ironman\\Documents\\公众号\\wechat-article-writer`

旧 Bridge 健康接口只返回全局 `busy/stage`，不返回研究任务的 clientRunId、检索 URL、资料读取事件或审计明细；CLI stderr 和临时 `response.json` 在进程结束前也没有可读内容。因此检索内部到底卡在某个来源、模型工具还是审源前序，当前只能标记为“不可观测”，不能臆测为具体供应商或网络故障。

进程观察补充：该命令对应 `codex.exe` PID 149836，启动时间约为本次请求的 `2026-09-04T04:02:22Z`；900 秒取消后 `/health` 在约 107 ms 内回到 `busy=false, stage=idle`，随后该 PID 已不存在。旧 Bridge 没有独立的 child-exit 事件接口，因此这里把“PID 消失 + Bridge idle”记录为可观察的退出/释放证据，而不是声称拿到了 CLI 的退出码或内部 stderr。

## 修复范围

- 工作台适配器新增结构化 `onTrace`/`onProgress` 事件、profile/provider 映射回执、HTTP 504 与本地 timeout 分类、无效 JSON/来源审计/模型启动/Bridge 不可达分类。
- 默认使用原生 `http(s)` 传输，避免 Node 全局 `fetch` 的隐式约 300 秒 response-header 断链；仍由显式 AbortSignal 保持有界等待。
- 健康阶段只在请求前观察到 idle、随后匹配 idle→busy，或 Bridge 回显相同 clientRunId 时推送进度；预先 busy 的其他任务不归属、不取消。
- 取消请求只携带本次 `clientRunId`；收到匹配 `cancel_requested` 后再验证 `/health` 回到 idle。失败或未匹配时保留 `not_owned/not_verified`，不宣称已释放。

## 未解决阻塞

旧 Bridge 仍是同步 `/v1/research`，没有可查询的异步结果或中间证据缓存。仅修改工作台无法让 10 分钟以上的检索/审源变成可恢复任务；若要降低重跑成本，需要旧 Bridge 提供带 clientRunId 的异步 job/result 接口或阶段日志。这超出本项目及本次适配器改动范围，未擅自修改旧项目。
