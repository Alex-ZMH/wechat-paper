/**
 * Uploads a local image as permanent material, suitable for obtaining a cover
 * thumb_media_id. Prints the returned media_id and URL; never prints tokens.
 * Usage: node upload-permanent-image.mjs <local-image-path>
 */
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { fail, getAccessToken, wechatPost } from './wechat-client.mjs'

const filePath = process.argv[2]
const mimeTypes = { '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

if (!filePath) {
  fail(new Error('Usage: node upload-permanent-image.mjs <local-image-path>'))
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
    const payload = await wechatPost('/cgi-bin/material/add_material?type=image', await getAccessToken(), form)

    if (typeof payload.media_id !== 'string') throw new Error('Upload succeeded but did not return a media_id.')
    console.log(JSON.stringify({ media_id: payload.media_id, url: payload.url ?? null }, null, 2))
  } catch (error) {
    fail(error)
  }
}
