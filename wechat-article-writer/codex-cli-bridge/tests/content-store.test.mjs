import assert from 'node:assert/strict';
import { request } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';

import {
  CONTENT_DOCUMENT_SCHEMA_VERSION,
  CONTENT_EXPORT_MANIFEST_SCHEMA_VERSION,
  CONTENT_REVISION_SCHEMA_VERSION,
  CONTENT_STORE_SCHEMA_VERSION,
  createBridgeServer,
  createContentStore,
} from '../server.mjs';

function result(draft) {
  return {
    draft,
    titleCandidates: ['标题甲', '标题乙', '标题丙'],
    recommendedTitle: '标题甲',
    outline: ['边界', '证据', '动作'],
    tags: ['写作', '非虚构', '编辑'],
    qualityReview: { passed: true, issues: [] },
    diagnostics: { remainingFlags: [] },
    editorialMemo: { unresolved: [] },
    receipts: [],
    warnings: [],
  };
}

function payload(mode = 'initial_generation') {
  return {
    mode,
    task: { kind: 'article', domain: 'general', genre: 'analysis', channel: 'wechat', purpose: 'explain' },
    brief: { topic: '测试主题', format: '调研文章' },
  };
}

function editorialScore(total = 100) {
  const dimensions = {
    factualBoundaries: { score: 25, max: 25, reasons: [] },
    specificActionability: { score: 25, max: 25, reasons: [] },
    authorVoiceContinuation: { score: 20, max: 20, reasons: [] },
    antiTemplateVariation: { score: 20, max: 20, reasons: [] },
    mobileClarity: { score: 10, max: 10, reasons: [] },
  };
  let remaining = 100 - total;
  for (const item of Object.values(dimensions)) {
    if (remaining <= 0) break;
    const points = Math.min(item.score, remaining);
    item.score -= points;
    item.reasons.push(`扣 ${points} 分：需要补充一处具体说明。`);
    remaining -= points;
  }
  return {
    total,
    threshold: 99,
    dimensions,
    deductions: Object.entries(dimensions)
      .filter(([, item]) => item.max - item.score > 0)
      .map(([dimension, item]) => ({ dimension, points: item.max - item.score, reason: item.reasons[0] })),
  };
}

function v2Response(mode, payload, {
  score = 100,
  passed = score >= 99,
  schemaVersion = 'codex.bridge.response.v1',
} = {}) {
  return {
    schemaVersion,
    status: passed ? 'succeeded' : 'succeeded_with_warnings',
    mode,
    versionId: `fake-${mode}`,
    draft: '这是一段按任务边界组织的非虚构正文，先说清依据，再给出可执行的下一步。',
    titleCandidates: ['标题甲', '标题乙', '标题丙'],
    recommendedTitle: '标题甲',
    outline: ['边界', '证据', '行动'],
    tags: ['非虚构', '编辑', '工作流'],
    receipts: payload.activeAnnotations.map((annotation) => ({ id: annotation.id, status: 'applied', message: '已按批注处理。' })),
    diagnostics: {
      humanized: true,
      changes: [],
      remainingFlags: [],
      engine: 'codex-cli',
      rulesVersion: 'nonfiction-editorial.v1',
      model: 'fake-model',
      passes: 2,
      preservedUserEdits: [],
    },
    editorialMemo: { preservedUserEdits: [], unresolved: [] },
    qualityReview: {
      passed,
      issues: passed ? [] : ['编辑评分仍需复核'],
      checks: {
        accuracy: true,
        annotationCoverage: true,
        humanVoice: true,
        mobileReadability: true,
        industrialData: null,
        crossSiteReasoning: null,
        workflowIntegration: null,
        actionAuthority: null,
        pilotAcceptance: null,
        terminology: null,
      },
      editorialScore: editorialScore(score),
    },
    warnings: [],
  };
}

function httpJson(port, route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port,
      path: route,
      method,
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined });
      });
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

test('content store appends immutable revisions and finalizes an external-asset text snapshot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-store-'));
  try {
    const store = createContentStore({ directory });
    const created = await store.create({ result: result('第一版正文'), payload: payload(), documentId: 'doc-test', revisionId: 'rev-one' });
    assert.equal(created.schemaVersion, CONTENT_DOCUMENT_SCHEMA_VERSION);
    assert.equal(created.documentId, 'doc-test');
    assert.equal(created.revisions[0].schemaVersion, CONTENT_REVISION_SCHEMA_VERSION);
    assert.equal(created.status, 'working');
    assert.equal(created.delivery.status, 'not_started');
    assert.equal(created.revisions[0].contentHash.length, 64);

    const next = await store.appendRevision({
      documentId: created.documentId,
      result: result('第二版正文'),
      payload: payload('annotation_regeneration'),
      parentRevisionId: created.latestRevisionId,
      revisionId: 'rev-two',
      source: 'annotation_regeneration',
    });
    assert.equal(next.revisions.length, 2);
    assert.equal(next.revisions[0].draft, '第一版正文');
    assert.equal(next.revisions[1].draft, '第二版正文');
    assert.equal(next.latestRevisionId, 'rev-two');
    assert.equal(next.approvedTextSnapshot, null);

    const rewritten = await store.appendRevision({
      documentId: created.documentId,
      result: result('外部原稿重写版'),
      payload: payload('source_rewrite'),
      parentRevisionId: next.latestRevisionId,
      revisionId: 'rev-source-rewrite',
      source: 'source_rewrite',
    });
    assert.equal(rewritten.revisions.at(-1).mode, 'source_rewrite');
    assert.equal(rewritten.revisions.at(-1).source, 'source_rewrite');

    const finalized = await store.finalizeText({
      documentId: created.documentId,
      revisionId: 'rev-source-rewrite',
      contentHash: rewritten.latestContentHash,
    });
    assert.equal(finalized.status, 'assets_pending');
    assert.deepEqual(finalized.blockingReasons, ['assets_missing']);
    assert.equal(finalized.approvedTextSnapshot.draft, '外部原稿重写版');

    const manifest = await store.exportManifest(created.documentId);
    assert.equal(manifest.schemaVersion, CONTENT_EXPORT_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.revisionId, 'rev-source-rewrite');
    assert.equal(manifest.text, '外部原稿重写版');
    assert.deepEqual(manifest.blockingReasons, ['assets_missing']);
    assert.equal(manifest.assets.policy, 'external_project');
    assert.equal(finalized.approvedTextSnapshots.length, 1);

    const later = await store.appendRevision({
      documentId: created.documentId,
      result: result('第三版正文'),
      payload: payload('annotation_regeneration'),
      parentRevisionId: finalized.latestRevisionId,
      revisionId: 'rev-three',
      source: 'annotation_regeneration',
    });
    assert.equal(later.approvedTextSnapshot.revisionId, finalized.latestRevisionId);
    await assert.rejects(
      () => store.exportManifest(created.documentId),
      /当前最新工作稿尚未审批/,
    );
    assert.equal((await store.exportManifest(created.documentId, manifest.manifestId)).text, '外部原稿重写版');
    const latestFinalized = await store.finalizeText({
      documentId: created.documentId,
      revisionId: later.latestRevisionId,
      contentHash: later.latestContentHash,
    });
    assert.equal(latestFinalized.approvedTextSnapshots.length, 2);
    assert.equal((await store.exportManifest(created.documentId)).text, '第三版正文');
    assert.equal((await store.exportManifest(created.documentId, manifest.manifestId)).text, '外部原稿重写版');

    const reopened = createContentStore({ directory });
    const persisted = await reopened.get(created.documentId);
    assert.equal(persisted.latestRevisionId, 'rev-three');
    assert.equal(persisted.approvedTextSnapshot.contentHash, (await store.exportManifest(created.documentId)).contentHash);
    const envelope = JSON.parse(await fs.readFile(path.join(directory, 'content-store.v2.json'), 'utf8'));
    assert.equal(envelope.schemaVersion, CONTENT_STORE_SCHEMA_VERSION);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('content store rejects stale revision appends and prevents changing an approved snapshot', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-store-stale-'));
  try {
    const store = createContentStore({ directory });
    const created = await store.create({ result: result('正文'), payload: payload(), documentId: 'doc-stale', revisionId: 'rev-base' });
    await assert.rejects(
      () => store.appendRevision({ documentId: created.documentId, result: result('新正文'), payload: payload(), parentRevisionId: 'not-latest' }),
      /baseRevisionId/,
    );
    await assert.rejects(
      () => store.finalizeText({ documentId: created.documentId }),
      /必须同时提供 revisionId 和 contentHash/,
    );
    await store.finalizeText({ documentId: created.documentId, revisionId: created.latestRevisionId, contentHash: created.latestContentHash });
    await assert.rejects(
      () => store.finalizeText({ documentId: created.documentId, revisionId: 'other', contentHash: created.latestContentHash }),
      /不是当前最新 revision/,
    );
    await assert.rejects(
      () => store.finalizeText({ documentId: created.documentId, revisionId: created.latestRevisionId, contentHash: '0'.repeat(64) }),
      /不是当前最新正文/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('v2 content defaults to an empty optional Skill chain and retains sub-99 candidates without finalizing them', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-v2-http-'));
  const prompts = [];
  const server = createBridgeServer({
    port: 0,
    contentStorePath: directory,
    memoryPath: path.join(directory, 'writing-memory.json'),
    statusProvider: async () => ({ ok: true }),
    runner: async (prompt, context) => {
      prompts.push(prompt);
      return v2Response(context.payload.mode, context.payload, { score: 94, passed: false });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const body = {
      schemaVersion: 'content-desk.request.v2',
      task: { kind: 'article', domain: 'history', genre: 'analysis', channel: 'wechat', purpose: 'explain' },
      mode: 'initial_generation',
      brief: { topic: '如何拆解一个陌生问题', audience: '普通读者', format: '调研文章', tone: '克制', materials: '' },
      targetLength: 600,
      annotations: [{ id: 'review-only', kind: '表达调整', note: '保留作者的短句节奏。', quote: '', remember: true }],
    };
    const response = await httpJson(server.address().port, '/v1/content', { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, 'content-desk.response.v2');
    assert.equal(response.body.status, 'review_required');
    assert.equal(response.body.contentStatus, 'review_required');
    assert.deepEqual(response.body.skillUsage.chain, []);
    assert.match(prompts[0], /nonfiction-editorial\.v1/);
    assert.doesNotMatch(prompts[0], /工业过程、MES、QMS、SCADA、FMEA、8D/);
    const document = await httpJson(server.address().port, `/v2/content/${response.body.documentId}`);
    assert.equal(document.status, 200);
    const finalized = await httpJson(server.address().port, `/v2/content/${response.body.documentId}/finalize`, {
      method: 'POST',
      body: { revisionId: response.body.revisionId, contentHash: response.body.contentHash },
    });
    assert.equal(finalized.status, 409);
    assert.equal(finalized.body.code, 'review_required');
    const blockedManifest = await httpJson(server.address().port, `/v2/content/${response.body.documentId}/export-manifest`);
    assert.equal(blockedManifest.status, 409);
    assert.equal(blockedManifest.body.code, 'text_not_finalized');
    const memory = await httpJson(server.address().port, '/v1/memory');
    assert.deepEqual(memory.body.memories, []);
    assert.deepEqual(memory.body.experiences, []);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('v2 accepts the shared response schema enum from Codex and still overwrites Bridge fields', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-v2-model-schema-'));
  const server = createBridgeServer({
    port: 0,
    contentStorePath: directory,
    memoryPath: path.join(directory, 'writing-memory.json'),
    statusProvider: async () => ({ ok: true }),
    runner: async (_prompt, context) => v2Response(context.payload.mode, context.payload, {
      schemaVersion: 'content-desk.response.v2',
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await httpJson(server.address().port, '/v1/content', {
      method: 'POST',
      body: {
        schemaVersion: 'content-desk.request.v2',
        task: { kind: 'article', domain: 'general', genre: 'analysis', channel: 'wechat', purpose: 'explain' },
        mode: 'initial_generation',
        brief: { topic: '验证模型输出枚举', format: '调研文章', tone: '克制' },
        targetLength: 600,
        annotations: [{ id: 'remember-me', kind: '表达调整', note: '每段先给结论，再展开说明。', quote: '', remember: true }],
      },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.schemaVersion, 'content-desk.response.v2');
    assert.match(response.body.documentId, /^[A-Za-z0-9][A-Za-z0-9_:-]*$/u);
    assert.equal(response.body.runStatus, 'succeeded');
    assert.deepEqual((await httpJson(server.address().port, '/v1/memory')).body.memories, []);
    const finalized = await httpJson(server.address().port, `/v2/content/${response.body.documentId}/finalize`, {
      method: 'POST',
      body: { revisionId: response.body.revisionId, contentHash: response.body.contentHash },
    });
    assert.equal(finalized.status, 200);
    assert.deepEqual(finalized.body.memoryPromotion.promotedAnnotationIds, ['remember-me']);
    assert.equal(finalized.body.memoryPromotion.experienceRecorded, true);
    const finalizedDocument = await httpJson(server.address().port, `/v2/content/${response.body.documentId}`);
    const historicalManifest = await httpJson(
      server.address().port,
      `/v2/content/${response.body.documentId}/export-manifest?manifestId=${encodeURIComponent(finalizedDocument.body.approvedTextSnapshot.snapshotId)}`,
    );
    assert.equal(historicalManifest.status, 200);
    assert.equal(historicalManifest.body.contentHash, response.body.contentHash);
    const memory = await httpJson(server.address().port, '/v1/memory');
    assert.equal(memory.body.memories.length, 1);
    assert.equal(memory.body.experiences.length, 1);
    const repeated = await httpJson(server.address().port, `/v2/content/${response.body.documentId}/finalize`, {
      method: 'POST',
      body: { revisionId: response.body.revisionId, contentHash: response.body.contentHash },
    });
    assert.equal(repeated.status, 200);
    const afterRepeat = await httpJson(server.address().port, '/v1/memory');
    assert.equal(afterRepeat.body.memories[0].confirmations, 1);
    assert.equal(afterRepeat.body.experiences[0].confirmations, 1);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
