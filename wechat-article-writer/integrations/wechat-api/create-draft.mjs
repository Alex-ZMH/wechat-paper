/**
 * Creates a single article in the WeChat Official Account draft box.
 * It cannot publish or mass-send a message.
 * Usage: node create-draft.mjs <article-json-path>
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fail, getAccessToken, wechatPost } from './wechat-client.mjs'

function validateArticle(article) {
  if (!article || typeof article !== 'object' || Array.isArray(article)) {
    throw new Error('The article file must contain one JSON object.')
  }
  for (const field of ['title', 'content', 'thumb_media_id']) {
    if (typeof article[field] !== 'string' || !article[field].trim() || article[field].includes('replace-with')) {
      throw new Error(`Article field '${field}' must be a completed, non-empty string.`)
    }
  }
  if (!article.content.trimStart().startsWith('<')) {
    throw new Error("Article 'content' must be HTML. Convert the final Markdown/text to HTML before creating a draft.")
  }
}

const articlePath = process.argv[2]
if (!articlePath) {
  fail(new Error('Usage: node create-draft.mjs <article-json-path>'))
} else {
  try {
    const raw = await readFile(resolve(articlePath), 'utf8')
    const article = JSON.parse(raw)
    validateArticle(article)
    const payload = await wechatPost(
      '/cgi-bin/draft/add',
      await getAccessToken(),
      JSON.stringify({ articles: [article] }),
    )
    if (typeof payload.media_id !== 'string') throw new Error('Draft creation succeeded but did not return a draft media_id.')
    console.log(JSON.stringify({ draft_media_id: payload.media_id, status: 'created' }, null, 2))
  } catch (error) {
    fail(error)
  }
}
