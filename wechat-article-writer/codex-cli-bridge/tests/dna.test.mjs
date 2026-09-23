import assert from 'node:assert/strict';
import { request } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
 buildCodexExecArgs,
 buildDnaDistillPrompt,
  ACADEMIC_DNA_ISSUE_CODES,
 createBridgeServer,
  getDnaStatus,
  replaceDnaWorkspaceTransaction,
  runDnaDistill,
  validateDnaDistillResponse,
} from '../server.mjs';

async function tempProject() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-test-'));
}

async function writeFile(root, relative, content = 'x') {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

async function prepareWriting(root, count = 20) {
  await writeFile(root, 'skills/writing-dna-skill/SKILL.md', 'original writing skill');
  for (let index = 0; index < count; index += 1) {
    await writeFile(root, `writing-dna-workspace/general/raw/article-${index}.md`, `article ${index} ` + '这是一篇用于 DNA 蒸馏的完整文章段落，包含足够的上下文、结构和表达样本。'.repeat(4));
  }
}

async function prepareAcademic(root) {
  await writeFile(root, 'skills/academic-writing-dna-skill/SKILL.md', 'original academic skill');
  await writeFile(root, 'writing-dna-workspace/academic/raw/paper.md', 'paper ' + '这是一篇用于学术 DNA 演示模式的完整论文文本片段，包含方法、结果、限制与讨论。'.repeat(4));
}

const ACADEMIC_DNA_ARTIFACT = '# Academic-Writing-DNA\n> 演示模式 — 仅 1 篇\n'
  + Array.from({ length: 7 }, (_, index) => `## L${index}\n完整内容。`).join('\n')
  + '\n## 使用说明\n### 适用场景\n同类论文。\n### 不适用\n短篇科普。\n## 边界\n不得冒充原作者。\n'
  + 'x'.repeat(250);

function academicArtifactVariant({ omit = [], demo = true, placeholder = false } = {}) {
  const sections = [];
  if (!omit.includes('title')) sections.push('# Academic-Writing-DNA');
  if (demo) sections.push('> 演示模式 — 仅 1 篇');
  for (let level = 0; level <= 6; level += 1) {
    if (!omit.includes(`L${level}`)) sections.push(`## L${level}\n完整内容。`);
  }
  if (!omit.includes('usage_section')) sections.push('## 使用说明');
  if (!omit.includes('applicable_subsection')) sections.push('### 适用场景\n同类论文。');
  if (!omit.includes('inapplicable_subsection')) sections.push('### 不适用\n短篇科普。');
  if (!omit.includes('boundary')) sections.push('## 边界\n不得冒充原作者。');
  if (placeholder) sections.push('[Target Name]');
  const text = sections.join('\n');
  return `${text}\n${'x'.repeat(Math.max(250 - text.length, 0))}`;
}

function metadataRecord(index) {
  return JSON.stringify({
    title: `Article ${index}`,
    date: '2026-01-01',
    author: 'Author',
    column: 'Column',
    article_type: '观察',
    topic_tags: ['AI'],
    hook_type: '问题式',
    structure_pattern: '总-分-总',
    source_types: ['一手素材'],
    word_count: 100,
    notable: '',
  });
}

const WRITING_LAYER_NAMES = ['Writing-DNA.md', '语言DNA.md', '文章结构模板.md', '写作视角与认知框架.md', '视觉风格指南.md'];

function writingOutputFiles(metadataCount = 20) {
  return [...WRITING_LAYER_NAMES, ...Array.from({ length: metadataCount }, (_, index) => `_meta/article-${index}.json`)];
}

async function prepareWritingArtifacts(root, metadataCount = 20) {
  await writeFile(root, 'writing-dna-workspace/general/Writing-DNA.md', '# Writing-DNA\n\n## 语言\n语言规则与词频。'.repeat(8) + '\n## 结构\n结构模板与开头结尾。'.repeat(8) + '\n## 认知\n认知视角与命题。'.repeat(8) + '\n## 视觉\n视觉排版与节奏。'.repeat(8));
  await writeFile(root, 'writing-dna-workspace/general/语言DNA.md', '# 语言DNA\n语言词频、句长和标点规则。'.repeat(8));
  await writeFile(root, 'writing-dna-workspace/general/文章结构模板.md', '# 文章结构模板\n开头、结构、结尾与模板。'.repeat(8));
  await writeFile(root, 'writing-dna-workspace/general/写作视角与认知框架.md', '# 写作视角与认知框架\n视角、认知、命题和素材。'.repeat(8));
  await writeFile(root, 'writing-dna-workspace/general/视觉风格指南.md', '# 视觉风格指南\n视觉、配图、排版与节奏。'.repeat(8));
  for (let index = 0; index < metadataCount; index += 1) {
    await writeFile(root, `writing-dna-workspace/general/_meta/article-${index}.json`, metadataRecord(index));
  }
}

async function prepareWritingStage(context, metadataCount = 20) {
  await prepareWritingArtifacts(context.stageRoot, metadataCount);
  return writingOutputFiles(metadataCount);
}

function httpJson(port, requestPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (encoded) req.end(encoded); else req.end();
  });
}

async function withServer(options, callback) {
  const server = createBridgeServer({ port: 0, ...options });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await callback(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test('DNA status enforces corpus, complete writing layers, metadata coverage, and stale detection', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root, 19);
    let status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.corpusCount, 19);
    assert.equal(status.modes.writing.ready, false);
    await writeFile(root, 'writing-dna-workspace/general/raw/article-19.md', 'article 19 ' + '这是一篇用于 DNA 蒸馏的完整文章段落，包含足够的上下文、结构和表达样本。'.repeat(4));
    const layers = ['Writing-DNA.md', '语言DNA.md', '文章结构模板.md', '写作视角与认知框架.md', '视觉风格指南.md'];
    await writeFile(root, 'writing-dna-workspace/general/Writing-DNA.md', '# Writing-DNA\n\n## 语言\n语言规则与词频。'.repeat(8) + '\n## 结构\n结构模板与开头结尾。'.repeat(8) + '\n## 认知\n认知视角与命题。'.repeat(8) + '\n## 视觉\n视觉排版与节奏。'.repeat(8));
    await writeFile(root, 'writing-dna-workspace/general/语言DNA.md', '# 语言DNA\n语言词频、句长和标点规则。'.repeat(8));
    await writeFile(root, 'writing-dna-workspace/general/文章结构模板.md', '# 文章结构模板\n开头、结构、结尾与模板。'.repeat(8));
    await writeFile(root, 'writing-dna-workspace/general/写作视角与认知框架.md', '# 写作视角与认知框架\n视角、认知、命题和素材。'.repeat(8));
    await writeFile(root, 'writing-dna-workspace/general/视觉风格指南.md', '# 视觉风格指南\n视觉、配图、排版与节奏。'.repeat(8));
    for (let index = 0; index < 20; index += 1) await writeFile(root, `writing-dna-workspace/general/_meta/article-${index}.json`, metadataRecord(index));
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, true);
    assert.equal(status.modes.writing.workspace, 'writing-dna-workspace/general');
    await writeFile(root, 'writing-dna-workspace/general/raw/article-0.md', 'new article ' + '内容变化使旧 DNA 失效并要求重新蒸馏。'.repeat(20));
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DNA status uses the flattened academic skill path and academic artifact', async () => {
  const root = await tempProject();
  try {
    await prepareAcademic(root);
    let status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.academic.corpusCount, 1);
    assert.equal(status.modes.academic.ready, false);
    await writeFile(root, 'writing-dna-workspace/academic/Academic-Writing-DNA.md', ACADEMIC_DNA_ARTIFACT);
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.academic.ready, true);
    assert.equal(status.modes.academic.workspace, 'writing-dna-workspace/academic');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('empty, tiny, invalid UTF-8, and corrupt document inputs do not count as corpus', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root, 0);
    await writeFile(root, 'writing-dna-workspace/general/raw/empty.md', '');
    await writeFile(root, 'writing-dna-workspace/general/raw/tiny.txt', 'x');
    await fs.writeFile(path.join(root, 'writing-dna-workspace/general/raw/bad.md'), Buffer.from([0xc3, 0x28]));
    await prepareAcademic(root);
    await fs.rm(path.join(root, 'writing-dna-workspace/academic/raw/paper.md'));
    await writeFile(root, 'writing-dna-workspace/academic/raw/bad.pdf', '%PDF-1.7');
    await fs.writeFile(path.join(root, 'writing-dna-workspace/academic/raw/bad.docx'), Buffer.from('PK\x03\x04not-a-zip'));
    const status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.corpusCount, 0);
    assert.equal(status.modes.academic.corpusCount, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('writing metadata requires raw correspondence and fields while accepting 80 percent coverage', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    await prepareWritingArtifacts(root, 16);
    let status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, true);
    await writeFile(root, 'writing-dna-workspace/general/_meta/article-16.json', metadataRecord(16).replace('"word_count":100', '"word_count":0'));
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('duplicate nested raw basenames cannot reuse one metadata record', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    await writeFile(root, 'writing-dna-workspace/general/raw/nested/article-0.md', '重复文件名但独立文章。'.repeat(12));
    await prepareWritingArtifacts(root, 17);
    const status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.corpusCount, 21);
    assert.equal(status.modes.writing.ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('academic DNA requires L0-L6, applicability/boundaries, and one-paper demo marking', async () => {
  const root = await tempProject();
  try {
    await prepareAcademic(root);
    const incomplete = '# Academic-Writing-DNA\n> 演示模式 — 仅 1 篇\n## L0\n## L1\n## L2\n## L3\n## L4\n## L5\n## L6\n## 适用场景\n## 不适用\n## 边界\n' + 'x'.repeat(250);
    await writeFile(root, 'writing-dna-workspace/academic/Academic-Writing-DNA.md', incomplete);
    let status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.academic.ready, false);
    await writeFile(root, 'writing-dna-workspace/academic/Academic-Writing-DNA.md', ACADEMIC_DNA_ARTIFACT);
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.academic.ready, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DNA prompts require full original skill/support reads without writing during article stages', () => {
  const writing = buildDnaDistillPrompt('writing');
  assert.match(writing, /skills\/writing-dna-skill\/SKILL\.md/);
  assert.match(writing, /全部 raw/);
  assert.match(writing, /5 篇相关 raw/);
  const academic = buildDnaDistillPrompt('academic');
  assert.match(academic, /Academic Mode 1/);
  assert.match(academic, /Academic-Writing-DNA\.md/);
});

test('academic DNA audit returns stable issues without exposing artifact content or paths', async () => {
  const root = await tempProject();
  const artifact = 'writing-dna-workspace/academic/Academic-Writing-DNA.md';
  try {
    await prepareAcademic(root);
    let status = await getDnaStatus({ projectRoot: root });
    assert.deepEqual(status.modes.academic.issues, ['missing_file']);

    const cases = [
      ['title', { omit: ['title'] }],
      ['L0', { omit: ['L0'] }],
      ['L1', { omit: ['L1'] }],
      ['L2', { omit: ['L2'] }],
      ['L3', { omit: ['L3'] }],
      ['L4', { omit: ['L4'] }],
      ['L5', { omit: ['L5'] }],
      ['L6', { omit: ['L6'] }],
      ['usage_section', { omit: ['usage_section'] }],
      ['applicable_subsection', { omit: ['applicable_subsection'] }],
      ['inapplicable_subsection', { omit: ['inapplicable_subsection'] }],
      ['boundary', { omit: ['boundary'] }],
      ['demo_marker', { demo: false }],
      ['unresolved_placeholder', { placeholder: true }],
    ];
    for (const [expected, options] of cases) {
      await writeFile(root, artifact, academicArtifactVariant(options));
      status = await getDnaStatus({ projectRoot: root });
      assert.equal(status.modes.academic.ready, false);
      assert.ok(status.modes.academic.issues.includes(expected), `${expected} issue missing`);
      assert.ok(status.modes.academic.issues.every((code) => ACADEMIC_DNA_ISSUE_CODES.includes(code)));
      assert.equal(JSON.stringify(status.modes.academic).includes(root), false);
    }

    await writeFile(root, artifact, ACADEMIC_DNA_ARTIFACT);
    await fs.utimes(path.join(root, artifact), new Date(0), new Date(0));
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.academic.ready, false);
    assert.deepEqual(status.modes.academic.issues, ['stale']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('DNA exec opts skip the Git trust check only for the staged distillation run', () => {
  const dnaArgs = buildCodexExecArgs({
    outputSchema: 'dna-schema.json',
    outputPath: 'dna-response.json',
    cwd: 'C:/temp/content-desk-dna-stage',
    sandbox: 'workspace-write',
    skipGitRepoCheck: true,
  });
  assert.deepEqual(dnaArgs, [
    '-c',
    'approval_policy=never',
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--sandbox',
    'workspace-write',
    '--output-schema',
    'dna-schema.json',
    '-o',
    'dna-response.json',
    '-C',
    'C:/temp/content-desk-dna-stage',
    '-',
  ]);
  assert.equal(dnaArgs.filter((arg) => arg === '--skip-git-repo-check').length, 1);

  const writingArgs = buildCodexExecArgs({
    outputSchema: 'content-schema.json',
    outputPath: 'content-response.json',
    cwd: 'C:/project',
    sandbox: 'read-only',
  });
  assert.deepEqual(writingArgs, [
    '-c',
    'approval_policy=never',
    'exec',
    '--ephemeral',
    '--sandbox',
    'read-only',
    '--output-schema',
    'content-schema.json',
    '-o',
    'content-response.json',
    '-C',
    'C:/project',
    '-',
  ]);
  assert.equal(writingArgs.includes('--skip-git-repo-check'), false);
});

test('Academic DNA accepts workspace-relative and project-prefixed output paths', async () => {
  const declarations = [
    'Academic-Writing-DNA.md',
    'writing-dna-workspace/academic/Academic-Writing-DNA.md',
  ];
  for (const declaredFile of declarations) {
    const root = await tempProject();
    try {
      await prepareAcademic(root);
      const result = await runDnaDistill('academic', {
        projectRoot: root,
        runner: async (_prompt, context) => {
          await writeFile(context.stageWorkspace, 'Academic-Writing-DNA.md', ACADEMIC_DNA_ARTIFACT);
          return {
            schemaVersion: 'codex.dna.distill.v1',
            status: 'succeeded',
            mode: 'academic',
            summary: 'ok',
            outputFiles: [declaredFile],
          };
        },
      });
      assert.equal(result.status.modes.academic.ready, true);
      assert.equal(
        await fs.readFile(path.join(root, 'writing-dna-workspace/academic/Academic-Writing-DNA.md'), 'utf8'),
        ACADEMIC_DNA_ARTIFACT,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('DNA output paths reject another mode workspace, traversal, and absolute paths', async () => {
  const declarations = [
    'writing-dna-workspace/general/Academic-Writing-DNA.md',
    '../Academic-Writing-DNA.md',
    'C:/outside/Academic-Writing-DNA.md',
  ];
  for (const declaredFile of declarations) {
    const root = await tempProject();
    try {
      await prepareAcademic(root);
      await assert.rejects(
        runDnaDistill('academic', {
          projectRoot: root,
          runner: async (_prompt, context) => {
            await writeFile(context.stageWorkspace, 'Academic-Writing-DNA.md', ACADEMIC_DNA_ARTIFACT);
            return {
              schemaVersion: 'codex.dna.distill.v1',
              status: 'succeeded',
              mode: 'academic',
              summary: 'invalid path',
              outputFiles: [declaredFile],
            };
          },
        }),
        /(?:错误 workspace|不安全的输出路径|不符合契约)/u,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('DNA response validation normalizes a project-prefixed output path before stage comparison', () => {
  const response = validateDnaDistillResponse({
    schemaVersion: 'codex.dna.distill.v1',
    status: 'succeeded',
    mode: 'academic',
    summary: 'ok',
    outputFiles: ['writing-dna-workspace/academic/Academic-Writing-DNA.md'],
  }, 'academic');
  assert.deepEqual(response.outputFiles, ['Academic-Writing-DNA.md']);
});

test('isolated DNA distillation copies only staged workspace output into fixed project workspace', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    const rawPath = path.join(root, 'writing-dna-workspace/general/raw/article-0.md');
    const rawBefore = await fs.readFile(rawPath);
    const result = await runDnaDistill('writing', {
      projectRoot: root,
      runner: async (_prompt, context) => {
        const outputFiles = await prepareWritingStage(context);
        return {
          schemaVersion: 'codex.dna.distill.v1',
          status: 'succeeded',
          mode: 'writing',
          summary: 'ok',
          outputFiles,
        };
      },
    });
    assert.equal(result.status.modes.writing.ready, true);
    assert.equal(result.status.modes.writing.workspace, 'writing-dna-workspace/general');
    assert.match(await fs.readFile(path.join(root, 'writing-dna-workspace/general/Writing-DNA.md'), 'utf8'), /^# Writing-DNA/u);
    assert.deepEqual(await fs.readFile(rawPath), rawBefore);
    assert.equal(await fs.access(path.join(root, 'skills/writing-dna-skill/SKILL.md')).then(() => true), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('artifact collection failure happens before DNA swap and preserves the previous workspace', async () => {
  const root = await tempProject();
  try {
    await prepareAcademic(root);
    const oldArtifact = '# old academic DNA';
    await writeFile(root, 'writing-dna-workspace/academic/Academic-Writing-DNA.md', oldArtifact);
    await assert.rejects(
      runDnaDistill('academic', {
        projectRoot: root,
        runner: async (_prompt, context) => {
          await writeFile(context.stageWorkspace, 'Academic-Writing-DNA.md', ACADEMIC_DNA_ARTIFACT);
          return {
            schemaVersion: 'codex.dna.distill.v1',
            status: 'succeeded',
            mode: 'academic',
            summary: 'collector failure',
            outputFiles: ['Academic-Writing-DNA.md'],
          };
        },
        artifactCollector: async () => {
          throw new Error('collector broke before commit');
        },
      }),
      /collector broke before commit/u,
    );
    assert.equal(
      await fs.readFile(path.join(root, 'writing-dna-workspace/academic/Academic-Writing-DNA.md'), 'utf8'),
      oldArtifact,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('transaction validation failure restores the old workspace byte-for-byte', async () => {
  const root = await tempProject();
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-stage-test-'));
  try {
    await writeFile(root, 'writing-dna-workspace/general/raw/article.md', 'authoritative raw');
    await writeFile(root, 'writing-dna-workspace/general/Writing-DNA.md', 'old dna');
    await writeFile(root, 'writing-dna-workspace/general/language-dna.md', 'old english layer');
    await writeFile(stage, 'Writing-DNA.md', 'new dna');
    await assert.rejects(
      replaceDnaWorkspaceTransaction(
        root,
        { workspaceRelative: 'writing-dna-workspace/general' },
        stage,
        { validate: async () => { throw new Error('forced validation failure'); } },
      ),
      /forced validation failure/,
    );
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/Writing-DNA.md'), 'utf8'), 'old dna');
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/language-dna.md'), 'utf8'), 'old english layer');
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/raw/article.md'), 'utf8'), 'authoritative raw');
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('successful transaction removes stale alternate-language output but preserves raw', async () => {
  const root = await tempProject();
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dna-stage-test-'));
  try {
    await writeFile(root, 'writing-dna-workspace/general/raw/article.md', 'authoritative raw');
    await writeFile(root, 'writing-dna-workspace/general/language-dna.md', 'stale english layer');
    await writeFile(stage, 'Writing-DNA.md', 'new dna');
    await replaceDnaWorkspaceTransaction(root, { workspaceRelative: 'writing-dna-workspace/general' }, stage);
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/Writing-DNA.md'), 'utf8'), 'new dna');
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/raw/article.md'), 'utf8'), 'authoritative raw');
    await assert.rejects(fs.access(path.join(root, 'writing-dna-workspace/general/language-dna.md')));
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('staged raw mutation or undeclared output rejects publication and preserves old DNA', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    await writeFile(root, 'writing-dna-workspace/general/raw/diagram.png', 'image attachment v1');
    await writeFile(root, 'writing-dna-workspace/general/Writing-DNA.md', 'old dna');
    await assert.rejects(
      runDnaDistill('writing', {
        projectRoot: root,
        runner: async (_prompt, context) => {
          const outputFiles = await prepareWritingStage(context);
          await fs.appendFile(path.join(context.corpusPath, 'diagram.png'), 'mutated');
          return { schemaVersion: 'codex.dna.distill.v1', status: 'succeeded', mode: 'writing', summary: 'mutated', outputFiles };
        },
      }),
      /发生变化/,
    );
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/Writing-DNA.md'), 'utf8'), 'old dna');

    await assert.rejects(
      runDnaDistill('writing', {
        projectRoot: root,
        runner: async (_prompt, context) => {
          const outputFiles = await prepareWritingStage(context);
          await writeFile(context.stageWorkspace, 'undeclared.tmp', 'extra');
          return { schemaVersion: 'codex.dna.distill.v1', status: 'succeeded', mode: 'writing', summary: 'extra', outputFiles };
        },
      }),
      /未声明或漏声明/,
    );
    assert.equal(await fs.readFile(path.join(root, 'writing-dna-workspace/general/Writing-DNA.md'), 'utf8'), 'old dna');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('changing a raw image or attachment makes existing DNA stale', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    await writeFile(root, 'writing-dna-workspace/general/raw/diagram.png', 'image attachment v1');
    await prepareWritingArtifacts(root);
    let status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(root, 'writing-dna-workspace/general/raw/diagram.png', 'image attachment v2');
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('changing original skill support after distillation makes DNA stale', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    await writeFile(root, 'skills/writing-dna-skill/docs/rules.md', 'original support');
    await prepareWritingArtifacts(root);
    let status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, true);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await writeFile(root, 'skills/writing-dna-skill/docs/rules.md', 'updated support');
    status = await getDnaStatus({ projectRoot: root });
    assert.equal(status.modes.writing.ready, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('incomplete staged DNA never overwrites the fixed workspace', async () => {
  const root = await tempProject();
  try {
    await prepareWriting(root);
    await writeFile(root, 'writing-dna-workspace/general/Writing-DNA.md', 'existing dna');
    await assert.rejects(
      runDnaDistill('writing', {
        projectRoot: root,
        runner: async (_prompt, context) => {
          await writeFile(context.stageWorkspace, 'Writing-DNA.md', 'incomplete replacement');
          return {
            schemaVersion: 'codex.dna.distill.v1',
            status: 'succeeded',
            mode: 'writing',
            summary: 'incomplete',
            outputFiles: ['Writing-DNA.md'],
          };
        },
      }),
      /阶段产物不完整/,
    );
    assert.equal(
      await fs.readFile(path.join(root, 'writing-dna-workspace/general/Writing-DNA.md'), 'utf8'),
      'existing dna',
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('content rejects an unready dnaMode before invoking Codex', async () => {
  const root = await tempProject();
  let calls = 0;
  try {
    await prepareWriting(root, 0);
    await withServer({
      projectRoot: root,
      runner: async () => { calls += 1; throw new Error('must not run'); },
    }, async (port) => {
      const response = await httpJson(port, '/v1/content', {
        method: 'POST',
        body: {
          mode: 'initial_generation',
          dnaMode: 'writing',
          brief: { topic: '工业智能体', audience: '研发人员', format: '专业方案', tone: '专业', targetLength: '1000', materials: '' },
          targetLength: 1000,
        },
      });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'dna_not_ready');
      assert.equal(calls, 0);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('academic DNA stage failure exposes only safe readiness diagnostics', async () => {
  const root = await tempProject();
  const artifact = 'writing-dna-workspace/academic/Academic-Writing-DNA.md';
  try {
    await prepareAcademic(root);
    await withServer({
      projectRoot: root,
      dnaRunner: (mode, options) => runDnaDistill(mode, {
        ...options,
        projectRoot: root,
        runner: async (_prompt, context) => {
          await writeFile(context.stageWorkspace, artifact.split('/').pop(), academicArtifactVariant({ omit: ['title'] }));
          return {
            schemaVersion: 'codex.dna.distill.v1',
            status: 'succeeded',
            mode: 'academic',
            summary: 'stage output',
            outputFiles: ['Academic-Writing-DNA.md'],
          };
        },
      }),
    }, async (port) => {
      const response = await httpJson(port, '/v1/dna/distill', { method: 'POST', body: { mode: 'academic' } });
      assert.equal(response.status, 502);
      assert.equal(response.body.code, 'dna_distill_failed');
      assert.deepEqual(response.body.diagnostics, { mode: 'academic', issues: ['title'] });
      const encoded = JSON.stringify(response.body);
      assert.equal(encoded.includes(root), false);
      assert.equal(encoded.includes(academicArtifactVariant({ omit: ['title'] })), false);
      const status = await httpJson(port, '/v1/dna');
      assert.equal(status.status, 200);
      assert.deepEqual(status.body.modes.academic.issues, ['missing_file']);
      assert.equal(JSON.stringify(status.body).includes(root), false);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
