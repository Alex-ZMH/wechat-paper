/**
 * Converts this bundle's editorial Markdown into conservative WeChat-ready HTML.
 * Usage:
 *   node markdown-to-wechat-article.mjs <input.md> <output.json> <thumb-media-id> <images.json>
 *
 * images.json is an object mapping Markdown image paths to WeChat image URLs.
 * This script does not call the WeChat API and never accesses credentials.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderInline(value) {
  const escaped = escapeHtml(value)
  return escaped
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, source) => `{{IMAGE:${source}}}`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" style="color:#576b95;text-decoration:underline;">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="padding:1px 4px;background:#f5f5f5;border-radius:3px;">$1</code>')
}

function parseFrontMatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  const metadata = {}
  if (!match) return { metadata, body: source }
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator > 0) metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { metadata, body: source.slice(match[0].length) }
}

function renderMarkdown(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const output = []
  let paragraph = []
  let list = null
  let quote = []
  let inCode = false
  let code = []

  function flushParagraph() {
    if (paragraph.length) {
      output.push(`<p style="margin:0 0 18px;line-height:1.9;color:#222;font-size:16px;">${renderInline(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  function flushList() {
    if (list) {
      output.push(`<${list.type} style="margin:0 0 18px;padding-left:24px;line-height:1.85;color:#222;font-size:16px;">${list.items.map((item) => `<li style="margin:6px 0;">${renderInline(item)}</li>`).join('')}</${list.type}>`)
      list = null
    }
  }
  function flushQuote() {
    if (quote.length) {
      output.push(`<blockquote style="margin:0 0 18px;padding:12px 16px;border-left:4px solid #5e8c6a;background:#f6faf6;color:#496052;line-height:1.85;">${renderInline(quote.join(' '))}</blockquote>`)
      quote = []
    }
  }
  function flushCode() {
    if (code.length) {
      output.push(`<pre style="margin:0 0 18px;padding:12px;overflow:auto;background:#f6f7f8;color:#30343a;font-size:13px;line-height:1.65;white-space:pre-wrap;">${escapeHtml(code.join('\n'))}</pre>`)
      code = []
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false } else { flushParagraph(); flushList(); flushQuote(); inCode = true }
      continue
    }
    if (inCode) { code.push(line); continue }
    if (!line.trim()) { flushParagraph(); flushList(); flushQuote(); continue }
    if (line === '---') { flushParagraph(); flushList(); flushQuote(); output.push('<hr style="border:0;border-top:1px solid #e6e6e6;margin:30px 0;"/>'); continue }
    const heading = line.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      flushParagraph(); flushList(); flushQuote()
      const level = heading[1].length
      if (level === 1) continue
      const styles = level === 2
        ? 'margin:34px 0 16px;font-size:21px;line-height:1.45;color:#193b28;font-weight:700;'
        : 'margin:24px 0 12px;font-size:18px;line-height:1.5;color:#2c573d;font-weight:700;'
      output.push(`<h${level} style="${styles}">${renderInline(heading[2])}</h${level}>`)
      continue
    }
    const image = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
    if (image) {
      flushParagraph(); flushList(); flushQuote()
      output.push(`{{IMAGE:${image[2]}}}`)
      continue
    }
    if (line.startsWith('> ')) { flushParagraph(); flushList(); quote.push(line.slice(2)); continue }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    const ordered = line.match(/^\d+\.\s+(.+)$/)
    if (bullet || ordered) {
      flushParagraph(); flushQuote()
      const type = ordered ? 'ol' : 'ul'
      if (!list || list.type !== type) { flushList(); list = { type, items: [] } }
      list.items.push((bullet || ordered)[1])
      continue
    }
    if (line.startsWith('|') && line.endsWith('|')) {
      flushParagraph(); flushList(); flushQuote()
      const table = []
      while (index < lines.length && lines[index].startsWith('|') && lines[index].endsWith('|')) {
        const cells = lines[index].slice(1, -1).split('|').map((cell) => cell.trim())
        if (!cells.every((cell) => /^:?-{3,}:?$/.test(cell))) table.push(cells)
        index += 1
      }
      index -= 1
      if (table.length) {
        const header = table.shift()
        output.push(`<table style="width:100%;margin:0 0 18px;border-collapse:collapse;font-size:13px;line-height:1.6;"><thead><tr>${header.map((cell) => `<th style="padding:8px;border:1px solid #dfe8e1;background:#eef5ef;text-align:left;">${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${table.map((row) => `<tr>${row.map((cell) => `<td style="padding:8px;border:1px solid #dfe8e1;vertical-align:top;">${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      }
      continue
    }
    paragraph.push(line.trim())
  }
  flushParagraph(); flushList(); flushQuote(); flushCode()
  return output.join('\n')
}

const [inputPath, outputPath, thumbMediaId, imageMapPath] = process.argv.slice(2)
if (!inputPath || !outputPath || !thumbMediaId || !imageMapPath) {
  console.error('Usage: node markdown-to-wechat-article.mjs <input.md> <output.json> <thumb-media-id> <images.json>')
  process.exitCode = 1
} else {
  try {
    const { metadata, body } = parseFrontMatter(await readFile(resolve(inputPath), 'utf8'))
    const imageMap = JSON.parse(await readFile(resolve(imageMapPath), 'utf8'))
    let content = renderMarkdown(body)
    content = content.replace(/\{\{IMAGE:([^}]+)\}\}/g, (_, source) => {
      const url = imageMap[source]
      if (!url) throw new Error(`No uploaded WeChat URL supplied for image: ${source}`)
      return `<figure style="margin:24px 0;text-align:center;"><img src="${escapeHtml(url)}" alt="" style="display:block;width:100%;height:auto;border-radius:3px;"/></figure>`
    })
    const article = {
      title: metadata.title || basename(inputPath, '.md'),
      author: metadata['作者'] || metadata.author || '',
      digest: metadata.digest || '一篇关于 AI、人和责任边界的思考。',
      content,
      content_source_url: '',
      thumb_media_id: thumbMediaId,
      show_cover_pic: 0,
      need_open_comment: 1,
      only_fans_can_comment: 0,
    }
    await writeFile(resolve(outputPath), `${JSON.stringify(article, null, 2)}\n`, 'utf8')
    console.log(`Created WeChat draft payload: ${resolve(outputPath)}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
