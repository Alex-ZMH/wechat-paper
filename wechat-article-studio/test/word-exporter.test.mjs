import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

import { exportWordDocument, runPipeline, sampleInput } from '../src/index.mjs'

const forbidden = [
  'human_curated', 'realtime_research', 'sourceOrigin', 'claim:', 'source:', 'candidate', 'claimId', 'sourceId',
  'review_required', 'Bridge', 'HTTP 504', 'research_timeout', 'EvidencePacket',
  'ArgumentMap', 'WriterRequest', 'WechatPackage', 'clientRunId', 'allReady',
]

function xmlEntries(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  assert.ok(eocd >= 0, 'DOCX must be a ZIP archive')
  const size = buffer.readUInt32LE(eocd + 12)
  const offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  let cursor = offset
  const end = offset + size
  while (cursor < end) {
    assert.deepEqual([...buffer.subarray(cursor, cursor + 4)], [0x50, 0x4b, 0x01, 0x02])
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = buffer.subarray(payloadStart, payloadStart + compressedSize)
    if (name.endsWith('.xml')) {
      entries.push({ name, xml: (method === 8 ? inflateRawSync(compressed) : compressed).toString('utf8') })
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

test('unified Word export emits a reader document with mapped citations', async () => {
  const result = runPipeline(sampleInput)
  const exported = await exportWordDocument(result)
  assert.equal(exported.contentType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  assert.match(exported.fileName, /\.docx$/u)
  assert.doesNotMatch(exported.fileName, /review_required|candidate/iu)

  const xml = xmlEntries(exported.buffer).map(({ xml }) => xml).join('\n')
  for (const field of forbidden) assert.equal(xml.includes(field), false, `Word leaked ${field}`)
  assert.match(xml, /w:ascii="Microsoft YaHei"/u)
  assert.match(xml, /w:eastAsia="Microsoft YaHei"/u)
  assert.match(xml, /w:pStyle w:val="Title"/u)
  assert.match(xml, /w:pStyle w:val="Heading1"/u)
  assert.match(xml, /w:pStyle w:val="Reference"/u)
  assert.match(xml, /w:firstLine="480"/u, 'body paragraphs use a true two-character indent')
  assert.match(xml, /w:firstLineChars="200"/u, 'body paragraphs carry a character-based two-character indent')
  assert.match(xml, /w:line="360"/u, 'body paragraphs use 1.5 line spacing')
  assert.match(xml, /\[1\]/u)
  assert.match(xml, /Studio Research Notes/u)
  assert.match(xml, /w:fldCharType="begin"/u, 'footer keeps a real page-number field')

  // The base Normal style must not carry a character indent: Word inherits
  // style paragraph properties, so putting firstLineChars on Normal shifts
  // Heading/List/Reference paragraphs even when their twip indent is zero.
  // Body paragraphs set firstLineChars directly and are covered above.
  const stylesXml = xmlEntries(exported.buffer).find(({ name }) => name === 'word/styles.xml')?.xml ?? ''
  const normalStyle = stylesXml.match(/<w:style[^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/u)?.[0] ?? ''
  const heading1Style = stylesXml.match(/<w:style[^>]*w:styleId="Heading1"[\s\S]*?<\/w:style>/u)?.[0] ?? ''
  assert.ok(normalStyle, 'Normal style should be present')
  assert.ok(heading1Style, 'Heading 1 style should be present')
  assert.doesNotMatch(normalStyle, /w:firstLineChars=/u, 'Normal style has no inherited character indent')
  assert.doesNotMatch(heading1Style, /w:firstLineChars=/u, 'Heading 1 has no inherited character indent')

  // Built-in heading styles ship with major/minor East-Asia theme fonts.
  // Explicit YaHei slots must be present without any competing *Theme slot,
  // otherwise Word may render Chinese headings as MS Gothic.
  for (const styleId of ['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3', 'ListBullet', 'ListNumber', 'Reference', 'TitleChar', 'SubtitleChar', 'Heading1Char', 'Heading2Char', 'Heading3Char', 'HeaderChar', 'FooterChar']) {
    const style = stylesXml.match(new RegExp(`<w:style[^>]*w:styleId="${styleId}"[\\s\\S]*?<\\/w:style>`, 'u'))?.[0] ?? ''
    assert.ok(style, `${styleId} style should be present`)
    assert.doesNotMatch(style, /w:(?:asciiTheme|hAnsiTheme|eastAsiaTheme|cstheme|csTheme)=/u, `${styleId} has no theme font override`)
    assert.match(style, /w:rFonts[^>]*w:ascii="Microsoft YaHei"[^>]*w:hAnsi="Microsoft YaHei"[^>]*w:eastAsia="Microsoft YaHei"[^>]*w:cs="Microsoft YaHei"/u, `${styleId} explicitly sets YaHei`)
  }
  const docDefaults = stylesXml.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/u)?.[0] ?? ''
  assert.ok(docDefaults, 'document defaults should be present')
  assert.doesNotMatch(docDefaults, /w:(?:asciiTheme|hAnsiTheme|eastAsiaTheme|cstheme|csTheme)=/u, 'document defaults have no theme font override')
  assert.match(docDefaults, /w:rFonts[^>]*w:ascii="Microsoft YaHei"[^>]*w:hAnsi="Microsoft YaHei"[^>]*w:eastAsia="Microsoft YaHei"[^>]*w:cs="Microsoft YaHei"/u, 'document defaults explicitly set YaHei')
})

test('Word export uses an ordinary title filename regardless of old approval options', async () => {
  const result = runPipeline(sampleInput)
  const reviewCopy = await exportWordDocument({ ...result, reviewReport: { status: 'approved' } })
  assert.doesNotMatch(reviewCopy.fileName, /_审阅稿\.docx$/u)

  const truthyString = await exportWordDocument({ ...result, reviewReport: { status: 'approved' } }, { finalized: 'true' })
  assert.equal(truthyString.fileName, reviewCopy.fileName)

  const finalized = await exportWordDocument({ ...result, reviewReport: { status: 'review_required' } }, { finalized: true })
  assert.equal(finalized.fileName, reviewCopy.fileName)
})

test('non-approved historical reviews do not affect reader-facing filename', async () => {
  const result = runPipeline(sampleInput)
  const review = { ...result.reviewReport, status: 'review_required' }
  const exported = await exportWordDocument({ ...result, reviewReport: review, review })
  assert.doesNotMatch(exported.fileName, /_审阅稿\.docx$/u)
  const xml = xmlEntries(exported.buffer).map(({ xml }) => xml).join('\n')
  assert.doesNotMatch(xml, /review_required/iu)
})

test('reader export fails closed when an internal marker reaches article text', async () => {
  const result = runPipeline(sampleInput)
  const draft = structuredClone(result.draft)
  draft.title = '不应导出的 Bridge 标记'
  await assert.rejects(
    () => exportWordDocument({ ...result, draft }),
    (error) => error.code === 'word_export_reader_fields',
  )
})

test('reader safety rejects known QA contamination but keeps natural bridge prose', async () => {
  const result = runPipeline(sampleInput)
  const natural = structuredClone(result.draft)
  natural.title = 'Bridge architecture 的产业化路径'
  const exported = await exportWordDocument({ ...result, draft: natural })
  assert.doesNotMatch(exported.fileName, /_审阅稿\.docx$/u)

  const contaminated = structuredClone(result.draft)
  contaminated.sections[0].paragraphs[0].text += '（浏览器人工编辑验收）'
  await assert.rejects(
    () => exportWordDocument({ ...result, draft: contaminated }),
    (error) => error.code === 'word_export_reader_fields',
  )
})

test('reader export rejects stale typed citations instead of deleting normal text', async () => {
  const result = runPipeline(sampleInput)
  const draft = structuredClone(result.draft)
  draft.sections[0].paragraphs[0].text = '这段文字被重新绑定到结构化论点。[99]'
  await assert.rejects(
    () => exportWordDocument({ ...result, draft }),
    (error) => error.code === 'word_export_reader_fields' && /citation does not match/iu.test(error.message),
  )
})

test('internal [S1] citation resolves through its exact source ID', async () => {
  const result = runPipeline(sampleInput)
  const packet = structuredClone(result.evidencePacket)
  packet.sources[0].sourceId = 'S1'
  packet.sources[1].sourceId = 'S2'
  packet.claims[0].evidenceIds = ['S1']
  packet.claims[1].evidenceIds = ['S2']
  const draft = structuredClone(result.draft)
  draft.sections[0].paragraphs[0].text = '依据内部来源标记[S1]，这段事实可以核对。'
  const exported = await exportWordDocument({ ...result, draft, evidencePacket: packet })
  const xml = xmlEntries(exported.buffer).map(({ xml }) => xml).join('\n')
  assert.match(xml, /\[1\]/u)
  assert.doesNotMatch(xml, /\[S1\]/u)
})

test('internal [S1] markers in structured title, lead, and headings map to reader references', async () => {
  const result = runPipeline(sampleInput)
  const packet = structuredClone(result.evidencePacket)
  packet.sources[0].sourceId = 'S1'
  packet.claims[0].evidenceIds = ['S1']
  const draft = structuredClone(result.draft)
  draft.title = '依据[S1]的产业判断'
  draft.lead = '导语中的来源标记[S1]也应转换。'
  draft.sections[0].heading = '技术依据[S1]'
  const exported = await exportWordDocument({ ...result, draft, evidencePacket: packet })
  const xml = xmlEntries(exported.buffer).map(({ xml }) => xml).join('\n')
  assert.match(xml, /依据\[1\]的产业判断/u)
  assert.match(xml, /导语中的来源标记\[1\]也应转换/u)
  assert.match(xml, /技术依据\[1\]/u)
  assert.doesNotMatch(xml, /\[S1\]/u)
})

test('package-only reader fallback maps exact [S1] tokens without exposing internals', async () => {
  const exported = await exportWordDocument({
    wechatPackage: {
      metadata: { title: '资料摘要' },
      bodyMarkdown: '# 资料摘要\n\n## 研究结论\n\n这是一条可核对的结论[S1]。',
    },
    evidencePacket: {
      sources: [{ sourceId: 'S1', title: '公开资料', excerpt: '结论摘录', url: 'https://example.test/source' }],
      claims: [],
    },
  })
  const xml = xmlEntries(exported.buffer).map(({ xml }) => xml).join('\n')
  assert.match(xml, /\[1\]/u)
  assert.doesNotMatch(xml, /\[S1\]/u)
})

test('structured list markers become real Word list paragraphs without body indent', async () => {
  const exported = await exportWordDocument({
    draft: {
      title: '列表格式检查',
      digest: '摘要',
      lead: '导语',
      sections: [{
        heading: '要点',
        paragraphs: [
          { text: '- 第一项', claimIds: [] },
          { text: '2. 第二项', claimIds: [] },
        ],
      }],
      closingCta: '结语',
    },
    evidencePacket: { sources: [], claims: [] },
    reviewReport: { status: 'review_required' },
  })
  const xml = xmlEntries(exported.buffer).map(({ xml }) => xml).join('\n')
  assert.match(xml, /w:pStyle w:val="ListBullet"/u)
  assert.match(xml, /w:pStyle w:val="ListNumber"/u)
})
