# 内容工作台交接文档

> 写给没有本会话上下文的新会话。本文记录的是 2026-09-03 的真实验收状态；不要把“自动化测试通过”当成“真实长文链路已经放行”。

## 1. 我们在做什么

项目是一个面向个人知识创作者的“工作流 + 智能体”复合工作台，不是单一聊天智能体，也不是只有固定步骤的黑盒工作流。

- 工作流负责固定顺序、输入快照、证据边界、版本 CAS、停止、失败原子性、审查门禁和交付状态。
- 智能体负责具体任务：主题调研、来源审计、可选 Writing DNA / Academic Writing DNA、长文写作、独立复审、编辑对话。
- 前端是单画布、从左到右、所有节点展开的 ComfyUI 风格。点击节点只定位，不折叠、不切换到另一套界面；节点可以任意接入/移除，但安全主链不可绕过。

目标覆盖三类任务：

1. 提供有权使用的范文 + 主题，按范文表达仿写，并可叠加调研和作者画像。
2. 提供主题，先做可追溯网页/文献/新闻等调研并冻结 Evidence Packet，再写有真实引用和文末参考文献的文章。
3. 提供已有文章，保留事实边界，做润色、改写、降 AI 味；用户手改和批注必须保留，批注可逐条删除、记忆只能沉淀安全的表达偏好。

当前验收话题是：

> 双金属MOF的合成难点与突破及其应用前景如何

目标字数为 20,000（有效正文范围 18,000–20,000；参考文献不计入正文长度）。

## 2. 当前代码和运行拓扑

代码仓库：

`C:\Users\ironman\Desktop\wechat\wechat-article-writer`

主要组件：

- `studio/`：React/Vinext 前端，入口主要在 `studio/app/page.tsx`，契约与状态工具在 `studio/lib/`。
- `codex-cli-bridge/server.mjs`：本机 Node Bridge，唯一允许调用 Codex CLI 的服务端；不接受任意 prompt，不暴露 token。
- `127.0.0.1:43127`：同源 Bridge 入口和静态代理。
- `127.0.0.1:43126`：Studio 上游生产服务。
- Bridge 固定反代到 43126，不允许请求携带任意代理目标。
- 运行账本：`codex-cli-bridge/.runtime/runs/*.json`。
- 内容 store 默认：`%LOCALAPPDATA%\ContentDesk\content-store.v2.json`。
- 记忆 store 默认：`%LOCALAPPDATA%\ContentDesk\writing-memory.v1.json`。
- Evidence Packet store 默认在 Bridge 的运行时目录；前端只持有 packet ID/hash/摘要，不把原始 JSON 当作证据。

安全执行主链：

`任务输入 → 作者画像 → 主题调研/冻结证据 → 可选 Writing DNA → 可选 Academic DNA → 专业上下文 → Codex 写作器 → Reviewer A → 冻结稿 Reviewer B → 人机编辑/批注 → 99 分门禁 → 文字定稿 → MultiPost（仅在配置、图片冻结和人工确认后）`

调研节点接入后是写作前置条件；没有审计通过且输入未变化的 Evidence Packet，不得进入研究写作。可选 DNA 节点“未接入”不等于失败，也不会自动伪造产物。

## 3. 已完成的工作

### 前端

- v40 延续 v39 的单画布前端：10 个阶段全部展开，输入、按钮、状态、阶段产物和最终稿阅读区同时可见。
- 节点有明确颜色，支持缩放、适应全图、横向滚动；不再复用旧版快速/高级互斥界面。
- 任务目标字数允许到 20,000，前端不会把 20,000 静默改成 5,000。
- 研究结果、工作稿、人工编辑、批注、编辑器对话和最终稿均有独立产物区。
- 真实的“开始写作 · 生成工作稿”和“停止写作”按钮均存在并连接 Bridge；停止不会覆盖旧稿。

### Bridge / 长文安全链路

- 长文采用首稿 + `writing_continuation` 分段追加，模型不能用反复模板机械凑字数；每段有 schema、sectionId、长度和重复检查。
- 参考文献由 Bridge 根据冻结 packet 确定性生成；模型首稿/续写被要求只写正文，不能自由编造参考文献。
- 正文长度只计算第一个合法“参考文献”标题之前的正文。
- 审核只接收冻结稿 hash 和紧凑审核元数据，Reviewer 不返回可替换正文；双审取保守分，门槛为 99/100。
- `review_required` 候选可以留在界面供用户检查，但不能定稿、导出或发送。
- annotation regeneration / source rewrite 在事实、人工修改、引用或参考文献边界不满足时 fail-closed，不覆盖旧稿。
- 参考文献预检现在会：
  - 拒绝冻结包外的 `[source:s-404]`、`[claim:c-404]` 和裸证据 marker；
  - 拒绝已知来源条目中夹带冻结包外 URL/DOI；
  - 保留当前稿中已完整映射的作者参考文献，即便新正文没有重复其 marker；
  - 只把正文中出现的受保护 URL/DOI 当作正文事实，避免 bibliography-only URL/DOI 误报缺失。
- Bridge 重启后读取旧运行记录时，会把孤儿 `running` 转为 `failed` + `run_interrupted`，防止浏览器永远轮询假运行。

### 当前这次任务的已确认状态

- 调研 packet 已冻结：17 个来源、12 条主张、关键未决主张 0，审源模型为 `codex-terra`。
- 当前旧工作稿原始长度 21,099 字，标题为：
  `双金属 MOF 的合成难点、关键突破与应用前景（人工校订稿）`
- 用户人工校订句已保留在正文开头：
  `说明：以下内容按“已证实结论—研究推断—应用展望”的边界组织。`
- 当前有 1 条未解决批注，内容是要求压缩重复的证据链/判定表/合成路线段落，同时保留 claim 标记、Bridge 参考文献和人工校订句。
- 页面已经真实调用 Codex CLI；不是前端假数据。

### 测试证据

- Bridge 全套串行测试：`244/244 passed`。
- 长文专项回归：`33/33 passed`。
- Studio 测试：`140/140 passed`。
- Bridge health 最近确认：
  - `bridgeVersion=codex-bridge.v40-20260903`
  - `productVersion=0.40.0`
  - `buildMarker=CONTENT_DESK_BUILD=v40`
  - `cliAvailable=true`、`execReady=true`、`authenticated=true`
  - 当前 Codex CLI 为 `0.152.1`
  - `codex-sol` / `codex-terra` / `codex-luna` 就绪；Ollama qwen3 当前未安装/未就绪。
- 生产构建和 lint 必须在下一个会话重新跑一遍；本会话最后一次并行 lint 因执行会话被中止，不能写成 lint 已通过。

## 4. 当前卡点（不要误报为已解决）

### A. 最新真实长文运行在续写阶段失败

最新页面真实运行：

- `clientRunId=a707990c-5fb2-4228-8ef5-a35b88731f4c`
- 结果：`failed`
- 失败阶段：`writing_continuation`
- 上游安全诊断：`invalid_cli_output`
- `contractReasonCode=continuation_evidence_binding`
- 含义：Codex 返回的续写 claim/source 标记无法回溯到当前冻结 Evidence Packet。
- 运行结束后 Bridge 为 idle，旧稿没有被覆盖。

这不是 HTTP 超时，也不是没有调用模型；是模型真实返回违反了续写证据绑定契约。下一会话必须先取页面/运行账本的安全诊断，确认模型具体使用了哪个不合法 marker，再决定是收紧 prompt、把允许的 claim/source ID 明确列入每次续写输入，还是改成无证据 marker 时由模型返回空 `usedClaimIds`。禁止把未知 marker 静默改成已知 marker，也禁止人工伪造引用来“跑通”。

### B. 前一轮 Bridge/Studio 曾同时退出

前一轮真实运行：`b1bfadc1-8aea-4deb-a17d-5afaddc68ef0`。运行期间 43126 和 43127 进程退出，账本短暂留下 `running`；重启后通过 GET 读取才转换为 `failed/run_interrupted`。需要继续确认后台启动方式的进程存活性，但不要把这次中断当成写作成功。建议使用隐藏的 detached launcher，再单独用 health 轮询，不要在会话被 Ctrl+C 时杀掉它的子进程。

### C. 99/100 放行尚未真实达到

单元测试验证了 99 硬门禁和“双审取保守分”，但本次真实 MOF 任务没有完成到双审和提交，因此不能声称：

- 已得到 99/100；
- 文章可以定稿；
- 文章已经达到人工可发布质量；
- MultiPost 已发送。

## 5. 下一步计划（按顺序执行）

1. 读取当前页面和最新运行账本，确认仍显示旧稿、旧 revision 未变化，记录失败阶段和安全诊断。
2. 检查 `writing_continuation` 的 prompt 组装与 validator：把冻结 packet 中合法 claim/source ID 以明确白名单注入续写上下文；要求没有可用证据时不要输出 marker；保持所有 section 只写正文。
3. 为“真实模型返回未知 claim/source marker”增加确定性回归：必须在续写阶段 fail-closed，不能进入审核、不能追加 revision、不能用映射猜测替换。
4. 重启 Bridge（确保进程载入最新 `server.mjs`），确认 `health` ready/idle；再从页面按钮重新发起同一 20,000 字批注重写。
5. 逐阶段观察 `writing → writing_continuation × N → quality_review → quality_review_audit → committing/idle`，每次确认旧稿未被中途覆盖；若失败，保存 `run ledger` 的安全错误，不要继续盲点重试。
6. 成功返回后检查：正文 18,000–20,000、人工校订句仍在开头、当前批注有 `applied/blocked/partially_applied` 回执、参考文献只有一个区块、每条引用都来自 packet、无未知 URL/DOI、revision 新增且 hash 改变。
7. 做页面级编辑器对话/重新排版候选测试：只生成候选，不自动覆盖正文；确认对话不修改正文，候选基线变化时拒绝采用。
8. 在真实结果明确后重新运行：Bridge 244+、Studio 140+、lint、production build、`git diff --check`；把精确数字写入 `releases/v40.json` 和 `releases/CHANGELOG.md`。
9. 只有双审都通过且保守分 ≥99、事实/引用/作者修改审计通过时，才允许把 v40 从 `local_candidate` 改为可定稿候选。当前不要部署 Sites，也不要接 MultiPost 发送。

## 6. 绝对不要再踩的坑

- 不要把前端状态变化、演示数据、测试 runner 或“Codex CLI 已连接”徽章当成真实模型产出。
- 不要把用户输入主题后实时同步到“生成内容”；只有点击开始写作并收到 Bridge 成功响应后，才更新工作稿产物。
- 不要把 20,000 字任务在任意层静默截成 5,000；字数必须从 v2 请求一路保留，并由服务端用正文长度验收。
- 不要在长文中让模型自由生成参考文献；Bridge 负责 packet-backed bibliography，模型只写正文。
- 不要为修复引用而猜测、替换或补造 source/claim ID、URL、DOI、数字或实验结果。
- 不要因为题名/URL 看起来能匹配，就放行未知显式 marker；source preflight 必须先拒绝冻结包外标记。
- 不要静默丢掉用户当前稿中完整映射的参考文献；要保留，或在模型启动前明确失败。
- 不要把 bibliography-only URL/DOI 当成正文缺失事实；但若 URL/DOI 同时出现在正文，仍必须作为正文受保护事实校验。
- 不要让 Reviewer 返回正文并覆盖 Bridge 冻结稿；审核只返回 hash 和结构化审查元数据。
- 不要把低于 99 的候选稿伪装成可发布稿；`review_required` 只能展示、修改、批注，不能定稿/导出/发送。
- 不要在模型运行时通过旧 revision 覆盖用户手改；使用 revision + content hash CAS。
- 不要把批注记忆当事实授权；记忆只能影响表达、结构和节奏，不能授权新增数字、来源、企业案例或亲历。
- 不要在服务未 idle 时启动第二个写作/调研请求；Bridge 串行执行，busy 应返回明确阻断。
- 不要用 Ctrl+C 结束承载 detached 本地服务的会话；这可能连带杀掉 Bridge/Studio，造成孤儿运行记录。
- 不要读取或修改浏览器 localStorage、cookies、密码或 session store 来“恢复状态”；通过页面 API、Bridge store 和运行账本恢复。
- 不要删除旧版本、文章、记忆或 DNA 语料来“清缓存”，除非用户明确指定精确目标；版本隔离优先于破坏性清理。
- 不要因为 244/244、140/140 通过就宣称真实长文已经可用；真实模型路径仍需跑完并核查 99 门禁。

## 7. 常用验收命令

在仓库目录执行：

```powershell
cd C:\Users\ironman\Desktop\wechat\wechat-article-writer

# 服务状态
Invoke-RestMethod http://127.0.0.1:43127/health | ConvertTo-Json -Depth 8

# Bridge 全套回归
cd codex-cli-bridge
node --test --test-concurrency=1

# Studio 回归、lint、生产构建（逐项执行）
cd ..\studio
npm test
npm run lint
npm run build
```

页面入口：`http://127.0.0.1:43127/`。下一会话优先使用已有本地工作台页面或新建一个本地页，确认 URL 里不需要登录；不要切回公开 Sites 页面作为真实执行面。

## 8. 版本状态

- 当前产品：v40 / `0.40.0`。
- 当前 Bridge：`codex-bridge.v40-20260903`。
- `releases/v40.json` 当前仍为 `local_candidate`，真实浏览器验收处于未完成/失败后待复跑状态。
- v39 是上一版单画布候选；不要恢复旧版互斥快速/高级前端。
- v40 尚未正式部署 Sites，尚未执行 MultiPost 发布。
