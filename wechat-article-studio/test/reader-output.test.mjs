import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const evaluation = resolve(ROOT, 'evaluation');
const readerMarkdown = resolve(evaluation, 'mof-solid-electrolyte-investor-article.md');
const readerHtml = resolve(evaluation, 'mof-solid-electrolyte-investor-article.html');
const readerDocx = resolve(evaluation, 'mof-solid-electrolyte-investor-article.docx');
const internalRuns = resolve(evaluation, 'real-writer-runs.json');
const internalAcceptance = resolve(evaluation, 'MOF-USER-ACCEPTANCE.md');

const forbidden = [
  'human_curated', 'realtime_research', 'sourceOrigin', 'claim:', 'source:',
  'review_required', 'candidate', 'Bridge', 'HTTP 504', 'research_timeout',
  'EvidencePacket', 'ArgumentMap', 'WriterRequest', 'WechatPackage', 'clientRunId', 'allReady',
];

function unzipXmlEntries(path) {
  const data = readFileSync(path);
  const eocd = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'DOCX must be a ZIP archive');
  const directorySize = data.readUInt32LE(eocd + 12);
  const directoryOffset = data.readUInt32LE(eocd + 16);
  const entries = [];
  let cursor = directoryOffset;
  const end = directoryOffset + directorySize;
  while (cursor < end) {
    assert.deepEqual([...data.subarray(cursor, cursor + 4)], [0x50, 0x4b, 0x01, 0x02]);
    const method = data.readUInt16LE(cursor + 10);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (name.endsWith('.xml')) {
      const localNameLength = data.readUInt16LE(localOffset + 26);
      const localExtraLength = data.readUInt16LE(localOffset + 28);
      const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = data.subarray(payloadStart, payloadStart + compressedSize);
      const xml = method === 8 ? inflateRawSync(compressed).toString('utf8') : compressed.toString('utf8');
      entries.push({ name, xml });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('reader Markdown and HTML hide internal audit fields and use reader citations', () => {
  const markdown = readFileSync(readerMarkdown, 'utf8');
  const html = readFileSync(readerHtml, 'utf8');
  for (const field of forbidden) {
    assert.equal(markdown.includes(field), false, `Markdown leaked ${field}`);
    assert.equal(html.includes(field), false, `HTML leaked ${field}`);
  }
  assert.match(markdown, /^# MOF 用于固态电解质，离商业化还有多远？$/mu);
  assert.match(markdown, /本文依据公开论文、综述、专利和企业资料整理，具体出处见文末。/u);
  assert.match(markdown, /\*\*摘要：\*\*/u);
  assert.match(markdown, /^## 参考文献$/mu);
  assert.doesNotMatch(markdown, /^## 来源与来源类型$/mu);
  assert.doesNotMatch(markdown, /\[S\d+\]/u);

  const [body, references] = markdown.split(/^## 参考文献$/mu);
  const referenceNumbers = [...references.matchAll(/^\[(\d+)\]/gmu)].map((match) => Number(match[1]));
  assert.deepEqual(referenceNumbers, Array.from({ length: referenceNumbers.length }, (_, index) => index + 1));
  assert.ok(referenceNumbers.length >= 10, 'reader reference list should retain all mapped sources');
  const citations = [...body.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]));
  assert.ok(citations.length > 0, 'body should contain mapped citations');
  assert.ok(citations.every((number) => referenceNumbers.includes(number)), 'body citation must map to a reference');
  assert.match(html, /<h1>MOF 用于固态电解质，离商业化还有多远？<\/h1>/u);
  assert.match(html, /摘要：/u);
  assert.match(html, /<h2>参考文献<\/h2>/u);
});

test('reader Word content hides internal audit fields and preserves article structure', () => {
  const xml = unzipXmlEntries(readerDocx).map((entry) => entry.xml).join('\n');
  for (const field of forbidden) assert.equal(xml.includes(field), false, `Word leaked ${field}`);
  assert.match(xml, /MOF 用于固态电解质/u);
  assert.match(xml, /参考文献/u);
  assert.match(xml, /\[1\] Yuan et al\./u);
  assert.match(xml, /w:fldCharType="begin"/u, 'Word footer keeps a real page-number field');
});

test('internal audit artifacts retain provenance and failure records', () => {
  const runs = JSON.parse(readFileSync(internalRuns, 'utf8'));
  const mof = runs.runs.find((run) => run.id === 'mof-solid-electrolyte');
  assert.ok(mof);
  assert.equal(mof.evidencePacket.sources[0].sourceOrigin, 'human_curated');
  assert.ok(mof.evidencePacket.sources[0].sourceId);
  assert.ok(mof.evidencePacket.claims[0].claimId);
  assert.ok(mof.writerRequest.clientRunId);
  assert.equal(mof.writerRequest.provider, 'codex-cli');
  assert.equal(mof.reviewReport.status, 'approved');

  const acceptance = readFileSync(internalAcceptance, 'utf8');
  for (const field of ['review_required', 'HTTP 504', 'research_timeout', 'clientRunId']) {
    assert.equal(acceptance.includes(field), true, `internal acceptance record lost ${field}`);
  }
});

test('public workbench renders four structured steps without raw audit JSON', () => {
  const preview = readFileSync(resolve(ROOT, 'public', 'index.html'), 'utf8');
  const script = readFileSync(resolve(ROOT, 'public', 'app.js'), 'utf8');
  for (const label of ['选题与要求', '资料与大纲', '写作与批注', '检查与下载']) assert.match(preview, new RegExp(label, 'u'));
  assert.doesNotMatch(preview, /<pre\b/iu, 'reader UI must not expose raw JSON panes');
  assert.doesNotMatch(preview, /textContent\s*=\s*JSON\.stringify\(/u, 'reader UI must not serialize internal payloads into visible panes');
  assert.match(script, /function renderInspector\(\)/u);
  assert.match(preview, /导入已有资料/u);
  assert.match(script, /api\/workspace\/latest/u);
  assert.match(script, /function saveChanges\(\)/u);
  assert.match(script, /fetch\('\/api\/export\/word'/u);
  assert.match(script, /function autoGrow\(el\)/u);
  assert.match(script, /if\(reason\)\{message\(reason\);return;\}/u);
  assert.match(preview, /id="top-status"/u, 'workflow feedback should remain visible on every step');
  const readerShell = preview.replace(/<style>[\s\S]*?<\/style>/u, '').split('<script>')[0];
  for (const field of ['human_curated', 'realtime_research', 'sourceOrigin', 'claimId', 'sourceId', 'review_required', 'Bridge', 'HTTP 504', 'research_timeout', 'EvidencePacket', 'ArgumentMap', 'WriterRequest', 'WechatPackage', 'clientRunId', 'allReady']) {
    assert.equal(readerShell.includes(field), false, `Workbench reader shell leaked ${field}`);
  }
});
