# 原始 Writing DNA 工作区

这里仅保存你有权用于个人写作学习的本地语料与蒸馏产物。工作台不接受任意外部路径，也不会把语料上传到 Sites。

## 通用 Writing DNA

1. 把至少 20 篇完整的 `.md` 或 `.txt` 文章放入 `general/raw/`。
2. 在工作台选择“Writing DNA · 通用作者画像”，点击“重新检查语料”。
3. 点击“运行原始蒸馏”。Bridge 会完整执行 `skills/writing-dna-skill/SKILL.md`，生成 L1–L6 分层、元数据和 `Writing-DNA.md`。
4. 状态变为 ready 后，写作与复审都会重新读取原始 Skill、全部分层、`Writing-DNA.md` 和 5 篇相关原文；不会使用 compact/runtime profile。

## Academic Writing DNA

1. 把至少 1 篇 `.pdf`、`.docx`、`.md` 或 `.txt` 论文放入 `academic/raw/`。
2. 在工作台选择“Academic Writing DNA · 学术写作”，刷新状态并运行原始蒸馏。
3. 蒸馏执行原始 Academic Mode 1，写作与复审执行原始 Mode 2。只有 1 篇论文时，产物必须标明“演示模式”，不能把单篇表达误当稳定风格。

学术量化脚本用标准库即可处理 `.md/.txt/.docx` 和简单 PDF；安装 `pypdf` 可增强 PDF 提取，安装 `jieba` 可增强中文分词。缺少可选依赖时，原始 Skill 会显式说明并按其回退规则继续。

蒸馏、写作和复审不设模型墙钟截止时间。CLI 可用性、登录状态与页面健康检查仍使用短超时；语料不足、损坏、蒸馏产物不完整或已过期时，工作台必须拒绝 DNA 写作，不能静默退回普通规则。
