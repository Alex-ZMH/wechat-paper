# MOF 选题真实用户验收记录

## 验收对象

任务：MOF（金属有机框架材料）用于固态电解质是否具备商业化前景。

目标输出：证据表、投资人研究报告、文章提纲、约 3000—5000 字中文公众号文章，以及 Markdown、HTML、Word 三种可读格式。

## 实时研究结果

1. Bridge `/health` 检查通过：已认证，`cliAvailable=true`，初始状态 `busy=false / stage=idle`。
2. 第一次完整研究请求返回 `HTTP 400 / invalid_request`，原因是传入了 Bridge 不接受的模型字符串 `gpt-5.6-luna`，因此没有产生证据包。
3. 第二次完整研究请求改用 Bridge 接受的 `codex-luna`，等待 `180000 ms` 后返回 `HTTP 504 / research_timeout`，消息为 `Bridge research timed out after 180000 ms`。
4. 超时后再次检查 Bridge：`busy=false / stage=idle`。没有将部分检索结果保存或写入文章。

内部运行标识：`clientRunId=mof-user-acceptance-luna-20260903`；该标识只用于审计和日志，不进入读者文章。

结论：本次验收未完成 Bridge `realtime_research`。所有后续论文、综述、专利和公司资料保持 `human_curated`，没有冒充实时研究来源。

## 交付物状态

- [MOF 证据表](./mof-solid-electrolyte-evidence.md)：已完成，来源和测试条件逐项列出，来源类型为 `human_curated`。
- [投资人研究报告](./mof-research-report.md)：已完成，包含技术路线、七项商业化评估、企业/专利分层、三情景和里程碑；状态为 `candidate / review_required`。
- [公众号文章提纲与正文](./mof-solid-electrolyte-investor-article.md)：正文去除实时研究假设后约 4991 字符，事实、推断和不确定性分开；状态为 `review_required`。
- [HTML](./mof-solid-electrolyte-investor-article.html)：已生成，可直接浏览。
- [Word](./mof-solid-electrolyte-investor-article.docx)：已生成，使用正式研究简报样式；本机未安装 LibreOffice，无法执行 `render_docx.py` 的 PNG 渲染，因此只完成结构性检查，未宣称通过视觉渲染门槛。

## 文章审查门槛

- 关键事实带来源编号 `[S1]`—`[S11]`，来源表包含发布日期、类型和链接。
- 事实、判断/推断和待验证项使用不同措辞；MOF-688 的 PC 溶剂化、综述二手数据、成本模型非报价均有明确限制。
- 没有图片、多平台发布或自动微信发布。
- 因实时研究服务失败，文章不能称为“实时研究版最终稿”，保留 `review_required` 状态；待实时研究成功并逐条审源后再升级。
