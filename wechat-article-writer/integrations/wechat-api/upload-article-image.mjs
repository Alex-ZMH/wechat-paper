/**
 * Uploads a local image for use inside an article's HTML content.
 * Usage: node upload-article-image.mjs <local-image-path>
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { fail, getAccessToken, wechatPost } from './wechat-client.mjs'

const filePath = process.argv[2]
const mimeTypes = { '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

if (!filePath) {
  fail(new Error('Usage: node upload-article-image.mjs <local-image-path>'))
} else {
  try {
    const absolutePath = resolve(filePath)
    const fileInfo = await stat(absolutePath)
    if (!fileInfo.isFile()) throw new Error('The supplied image path is not a file.')
    const type = mimeTypes[extname(absolutePath).toLowerCase()]
    if (!type) throw new Error('Supported image extensions: .jpg, .jpeg, .png, .gif, .webp')

    const data = await readFile(absolutePath)
    const form = new FormData()
    form.set('media', new Blob([data], { type }), basename(absolutePath))
    const payload = await wechatPost('/cgi-bin/media/uploadimg', await getAccessToken(), form)
    if (typeof payload.url !== 'string') throw new Error('Upload succeeded but did not return an image URL.')
    console.log(JSON.stringify({ url: payload.url }, null, 2))
  } catch (error) {
    fail(error)
  }
}
