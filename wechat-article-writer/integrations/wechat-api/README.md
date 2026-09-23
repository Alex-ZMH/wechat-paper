# 微信公众号 API 对接（本机安全起步）

这里是对接实际公众号的本机脚本，不是 bundle 的运行时依赖。它不会保存、打印或提交 `access_token`、AppSecret 或其他凭证。

## 1. 安全设置凭证

不要把 AppSecret 发到聊天、写入源码或提交 Git。仅在当前 PowerShell 窗口设置：

```powershell
$env:WECHAT_APP_ID = '你的 AppID'
$env:WECHAT_APP_SECRET = '你的 AppSecret'
```

也可以复制 `.env.example` 为本机 `.env`，但本项目的脚本不会自动加载 `.env`，从而避免把凭证意外带入命令行或打包过程。使用 `.env` 时，请由受信任的部署环境加载它。

## 2. 验证 API 凭证

在本目录运行：

```powershell
node get-access-token.mjs
```

成功时只显示授权是否通过和有效期，不显示令牌。若失败，请只保留错误码和错误信息用于排查，切勿附带 AppSecret 或完整请求地址。

## 3. 上传图片

封面需要永久图片素材的 `media_id`。先上传本地封面：

```powershell
node upload-permanent-image.mjs "C:\\path\\to\\cover.png"
```

将输出的 `media_id` 写入文章 JSON 的 `thumb_media_id`。正文配图使用：

```powershell
node upload-article-image.mjs "C:\\path\\to\\body-image.png"
```

将它返回的 `url` 放进 HTML 正文中的 `<img src="..." />`。

## 4. 创建草稿（不会发布）

复制 `article.example.json` 为你的本地文章 JSON，填入审核后的标题、摘要、HTML 正文和封面 `thumb_media_id`：

```powershell
Copy-Item article.example.json article.local.json
node create-draft.mjs article.local.json
```

脚本只会调用草稿创建接口；成功后在公众号后台的草稿箱查看、排版、预览和人工审核。它不包含群发或发布接口。

## 5. 接入草稿与发布前须知

凭证验证通过后，按照“上传素材 → 创建草稿 → 后台预览/人工审核”的顺序操作。不要自动群发或绕过人工审核。

实际可调用的接口取决于账号主体、认证状态、已获权限、IP 白名单、接口域名与微信公众平台当前规则。请在公众号后台确认这些配置后再连接生产流程。
