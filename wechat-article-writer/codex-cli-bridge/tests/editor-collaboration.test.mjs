import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBridgeServer, createContentStore } from '../server.mjs';

const task = { kind: 'article', domain: 'general', genre: 'analysis', channel: 'wechat', purpose: 'explain' };

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

async function withServer(options, run) {
  const server = createBridgeServer({
    port: 0,
    statusProvider: async () => ({ ok: true }),
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await run(server.address().port);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
}

function manualBody(draft, receipt) {
  return {
    schemaVersion: 'content-desk.manual-revision-request.v1',
    ...(receipt ? { baseRevisionId: receipt.revisionId, baseContentHash: receipt.contentHash } : {}),
    recommendedTitle: '手工测试文章',
    draft,
    task,
  };
}

function dialogueBody(receipt, action, instruction, selection = null) {
  return {
    schemaVersion: 'content-desk.editor-dialogue-request.v1',
    clientRunId: `editor-${action}`,
    documentId: receipt.documentId,
    revisionId: receipt.revisionId,
    contentHash: receipt.contentHash,
    action,
    instruction,
    selection,
    writerModel: 'codex-sol',
  };
}

test('manual saves append immutable revisions and stale CAS cannot overwrite them', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-manual-'));
  try {
    await withServer({ contentStorePath: directory }, async (port) => {
      const created = await httpJson(port, '/v2/documents/manual', {
        method: 'POST',
        body: manualBody('第一版手工正文'),
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.mode, 'manual_edit');
      assert.equal(created.body.source, 'manual_edit');
      assert.equal(created.body.status, 'review_required');

      const appended = await httpJson(port, `/v2/documents/${created.body.documentId}/revisions/manual`, {
        method: 'POST',
        body: manualBody('第二版手工正文', created.body),
      });
      assert.equal(appended.status, 200);
      assert.notEqual(appended.body.revisionId, created.body.revisionId);

      const stale = await httpJson(port, `/v2/documents/${created.body.documentId}/revisions/manual`, {
        method: 'POST',
        body: manualBody('不应覆盖的旧基线正文', created.body),
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.code, 'stale_revision');

      const stored = await httpJson(port, `/v2/documents/${created.body.documentId}`);
      assert.equal(stored.body.revisions.length, 2);
      assert.equal(stored.body.revisions[0].draft, '第一版手工正文');
      assert.equal(stored.body.revisions[1].draft, '第二版手工正文');
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('editor dialogue discusses without mutation and returns explicit rewrite/reformat candidates', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dialogue-'));
  const draft = '第一段需要保留。第二段需要改写。第三段也要保留。';
  try {
    await withServer({
      contentStorePath: directory,
      editorRunner: async (_prompt, context) => {
        if (context.payload.action === 'discuss') {
          return { schemaVersion: 'content-desk.editor-dialogue.model.v1', reply: '第二段论证缺少承接。', replacementText: '', formattedDraft: '' };
        }
        if (context.payload.action === 'rewrite_selection') {
          return { schemaVersion: 'content-desk.editor-dialogue.model.v1', reply: '只重写了选区。', replacementText: '第二段补足了因果承接。', formattedDraft: '' };
        }
        return { schemaVersion: 'content-desk.editor-dialogue.model.v1', reply: '只调整了段落。', replacementText: '', formattedDraft: '第一段需要保留。\n\n第二段需要改写。\n\n第三段也要保留。' };
      },
    }, async (port) => {
      const created = (await httpJson(port, '/v2/documents/manual', { method: 'POST', body: manualBody(draft) })).body;

      const discussed = await httpJson(port, '/v1/editor-dialogue', {
        method: 'POST',
        body: dialogueBody(created, 'discuss', '判断第二段是否跳步'),
      });
      assert.equal(discussed.status, 200);
      assert.equal(discussed.body.candidate, null);

      const selected = '第二段需要改写。';
      const start = draft.indexOf(selected);
      const rewritten = await httpJson(port, '/v1/editor-dialogue', {
        method: 'POST',
        body: dialogueBody(created, 'rewrite_selection', '补足承接，不改其他段', { start, end: start + selected.length }),
      });
      assert.equal(rewritten.status, 200);
      assert.equal(rewritten.body.candidate.draft, '第一段需要保留。第二段补足了因果承接。第三段也要保留。');
      assert.equal(rewritten.body.candidate.baseRevisionId, created.revisionId);

      const reformatted = await httpJson(port, '/v1/editor-dialogue', {
        method: 'POST',
        body: dialogueBody(created, 'reformat', '拆成三个自然段'),
      });
      assert.equal(reformatted.status, 200);
      assert.match(reformatted.body.candidate.draft, /\n\n/u);

      const stored = await httpJson(port, `/v2/documents/${created.documentId}`);
      assert.equal(stored.body.revisions.length, 1);
      assert.equal(stored.body.revisions[0].draft, draft);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('candidate is rejected when its saved base changes while the model is running', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dialogue-stale-'));
  const store = createContentStore({ directory });
  try {
    let base;
    await withServer({
      contentStore: store,
      editorRunner: async () => {
        await store.appendRevision({
          documentId: base.documentId,
          result: {
            status: 'review_required',
            blockingReasons: ['manual_revision_requires_review'],
            draft: '并发保存的新正文',
            titleCandidates: ['手工测试文章'],
            recommendedTitle: '手工测试文章',
            outline: [],
            tags: [],
            qualityReview: null,
            reviewAudit: null,
            diagnostics: {},
            editorialMemo: null,
            workflowReceipt: null,
            receipts: [],
            warnings: [],
          },
          payload: { mode: 'manual_edit', task, brief: { topic: '手工测试文章', format: 'analysis' } },
          parentRevisionId: base.revisionId,
          parentContentHash: base.contentHash,
          source: 'manual_edit',
        });
        return { schemaVersion: 'content-desk.editor-dialogue.model.v1', reply: '返回了旧基线候选。', replacementText: '', formattedDraft: '旧基线候选' };
      },
    }, async (port) => {
      base = (await httpJson(port, '/v2/documents/manual', { method: 'POST', body: manualBody('原始正文') })).body;
      const response = await httpJson(port, '/v1/editor-dialogue', {
        method: 'POST',
        body: dialogueBody(base, 'reformat', '重新排版'),
      });
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'stale_revision');
      const stored = await httpJson(port, `/v2/documents/${base.documentId}`);
      assert.equal(stored.body.revisions.length, 2);
      assert.equal(stored.body.revisions.at(-1).draft, '并发保存的新正文');
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('editor dialogue stop requires its exact clientRunId and never returns a candidate', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-dialogue-cancel-'));
  let releaseRunner;
  let runnerStarted;
  const started = new Promise((resolve) => { runnerStarted = resolve; });
  const released = new Promise((resolve) => { releaseRunner = resolve; });
  try {
    await withServer({
      contentStorePath: directory,
      editorRunner: async () => {
        runnerStarted();
        await released;
        return { schemaVersion: 'content-desk.editor-dialogue.model.v1', reply: '不应提交', replacementText: '', formattedDraft: '不应提交的候选' };
      },
    }, async (port) => {
      const base = (await httpJson(port, '/v2/documents/manual', { method: 'POST', body: manualBody('停止测试正文') })).body;
      const running = httpJson(port, '/v1/editor-dialogue', {
        method: 'POST',
        body: { ...dialogueBody(base, 'reformat', '重新排版'), clientRunId: 'editor-stop-exact' },
      });
      await started;
      const mismatch = await httpJson(port, '/v1/cancel', { method: 'POST', body: { clientRunId: 'editor-other' } });
      assert.equal(mismatch.status, 409);
      assert.equal(mismatch.body.code, 'run_mismatch');
      const stopped = await httpJson(port, '/v1/cancel', { method: 'POST', body: { clientRunId: 'editor-stop-exact' } });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.code, 'cancel_requested');
      releaseRunner();
      const response = await running;
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'cancelled');
      assert.equal(response.body.candidate, undefined);
      const stored = await httpJson(port, `/v2/documents/${base.documentId}`);
      assert.equal(stored.body.revisions.length, 1);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
