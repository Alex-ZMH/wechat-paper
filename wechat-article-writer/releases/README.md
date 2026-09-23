# Content Desk releases

产品版本、运行契约和文章版本是三套不同标识，禁止互相代替。

- 产品版本：面向用户的连续版本，例如 `v24` / `0.24.0`。
- 构建版本：Studio、Bridge 与启动器必须来自同一产品版本。
- Schema 版本：`content-desk.*.v1` 只在破坏兼容时升级。
- 内容版本：每篇文档独立使用 `documentId + revisionId + contentHash`。
- 适配器版本：例如 `multipost-desktop.v1`，与 MultiPost 应用版本分离。

每个公开版本必须留下 manifest、变更说明、源码提交或标签、测试记录和部署映射。旧版本先进入 `legacy/` 隔离，再删除确认无运行价值的重复构建目录；不得删除正文、记忆、DNA、导出清单或发布回执。

