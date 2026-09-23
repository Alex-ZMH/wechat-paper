import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPrompt,
  createBridgeServer,
  createWritingMemoryStore,
  draftFingerprint,
  EDITORIAL_SCORE_DIMENSIONS,
  EDITORIAL_SCORE_THRESHOLD,
  MAX_EXPERIENCE_TEXT_CHARS,
  MAX_REFERENCE_TEXT_CHARS,
  MAX_WRITING_MEMORIES,
  mergeWritingMemories,
  normalizeWritingMemoryInput,
  collectAppliedWritingMemoryEntries,
  validateRequestPayload,
} from '../server.mjs';

function responseFor(payload, score = 100) {
  return {
    schemaVersion: 'codex.bridge.response.v1',
    status: 'succeeded',
    mode: payload.mode,
    versionId: `fake-${payload.mode}`,
    draft: payload.currentDraft || '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。',
    titleCandidates: ['从多站点问题找到共因', '过程管控的跨站点分析方法', '把异常从单点拉回系统看'],
    recommendedTitle: '从多站点问题找到共因',
    outline: ['问题边界与数据主键', '共因分析与证据链', '试点、处置和人工边界'],
    tags: ['过程管控', '质量分析', 'MES'],
    receipts: payload.activeAnnotations.map((item) => ({ id: item.id, status: 'applied', message: '已按批注调整。' })),
    diagnostics: {
      humanized: true,
      changes: ['保留具体动作和限制'],
      remainingFlags: [],
      engine: 'codex-cli',
      rulesVersion: 'industrial-process-control.v1',
      model: 'fake-model',
      passes: 2,
      preservedUserEdits: [],
    },
    editorialMemo: { preservedUserEdits: [], unresolved: [] },
    qualityReview: {
      passed: true,
      issues: [],
      checks: {
        accuracy: true,
        annotationCoverage: true,
        humanVoice: true,
        mobileReadability: true,
        industrialData: true,
        crossSiteReasoning: true,
        workflowIntegration: true,
        actionAuthority: true,
        pilotAcceptance: true,
        terminology: true,
      },
      editorialScore: {
        ...scoreFor(score),
      },
    },
    warnings: [],
  };
}

function scoreFor(total) {
  const dimensions = Object.fromEntries(Object.entries(EDITORIAL_SCORE_DIMENSIONS)
    .map(([key, definition]) => [key, { score: definition.max, max: definition.max, reasons: [] }]));
  let remaining = 100 - total;
  for (const [key, definition] of Object.entries(EDITORIAL_SCORE_DIMENSIONS)) {
    if (remaining <= 0) break;
    const points = Math.min(definition.max, remaining);
    dimensions[key].score -= points;
    dimensions[key].reasons.push(`扣 ${points} 分：测试用例的可解释扣分理由。`);
    remaining -= points;
  }
  const deductions = Object.entries(dimensions)
    .flatMap(([dimension, item]) => item.max - item.score > 0
      ? [{ dimension, points: item.max - item.score, reason: item.reasons[0] }]
      : []);
  return { total, threshold: EDITORIAL_SCORE_THRESHOLD, dimensions, deductions };
}

function basePayload(overrides = {}) {
  return {
    mode: 'initial_generation',
    brief: {
      topic: '多个站点同时出现过程异常，如何找共因',
      audience: '制造业过程和质量负责人',
      format: '专业方案',
      tone: '专业解释',
      targetLength: '900',
      materials: '需要说明 MES、QMS、SCADA 与 8D/FMEA 的衔接，数据和指标待现场确认。',
    },
    previousGeneratedDraft: '',
    currentDraft: '',
    annotations: [],
    voiceProfile: { tone: '专业解释', traits: ['具体', '克制'] },
    targetLength: 900,
    ...overrides,
  };
}

function httpJson(port, requestPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined) {
      requestHeaders['Content-Type'] ??= 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(encoded);
    }
    const req = request({ host: '127.0.0.1', port, path: requestPath, method, headers: requestHeaders }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (encoded !== undefined) req.write(encoded);
    req.end();
  });
}

async function withServer(options, callback) {
  const server = createBridgeServer({ port: 0, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    return await callback(server.address().port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function temporaryMemoryStore(options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-memory-'));
  const filePath = path.join(directory, 'writing-memory.v1.json');
  const store = createWritingMemoryStore({ filePath, ...options });
  return { directory, filePath, store };
}

test('writing memory normalization compacts text and rejects fact or reserved kinds', () => {
  assert.deepEqual(normalizeWritingMemoryInput({ kind: '表达调整', text: '  保持\n段落   节奏  ' }), {
    kind: '表达调整',
    text: '保持 段落 节奏',
  });
  assert.throws(() => normalizeWritingMemoryInput({ kind: '事实核对', text: '补充数字' }), /长期偏好 kind/);
  assert.throws(() => normalizeWritingMemoryInput({ kind: 'experience', text: '流程元数据' }), /写作经验由桥接/);
  assert.throws(() => normalizeWritingMemoryInput({ kind: '表达调整', text: 'x'.repeat(181) }), /超出长度限制/);
});

test('applied-only promotion accepts safe style notes and blocks facts, evidence, customers, quantities, and custom kinds', () => {
  const receiptSet = [
    { id: 'safe', status: 'applied' },
    { id: 'partial', status: 'partially_applied' },
    { id: 'blocked', status: 'blocked' },
    { id: 'quantity', status: 'applied' },
    { id: 'date', status: 'applied' },
    { id: 'customer', status: 'applied' },
    { id: 'custom', status: 'applied' },
    { id: 'quoted', status: 'applied' },
    { id: 'fact-kind', status: 'applied' },
  ];
  const entries = collectAppliedWritingMemoryEntries([
    { id: 'safe', kind: '表达调整', note: '先给判断条件，再补验证动作', quote: '', remember: true },
    { id: 'partial', kind: '表达调整', note: '部分应用也不应记住', quote: '', remember: true },
    { id: 'blocked', kind: '结构建议', note: '阻断的意见不应记住', quote: '', remember: true },
    { id: 'quantity', kind: '表达调整', note: '保留 37% 的说法', quote: '', remember: true },
    { id: 'date', kind: '表达调整', note: '从 2026年 开始写', quote: '', remember: true },
    { id: 'customer', kind: '表达调整', note: '客户已采用这套方案', quote: '', remember: true },
    { id: 'custom', kind: '自定义', note: '自定义类型不进入偏好', quote: '', remember: true },
    { id: 'quoted', kind: '表达调整', note: '选区内容只改本稿', quote: '原句', remember: true },
    { id: 'fact-kind', kind: '事实核对', note: '核对后再写', quote: '', remember: true },
  ], receiptSet);
  assert.deepEqual(entries, [{ kind: '表达调整', text: '先给判断条件，再补验证动作' }]);
});

test('annotation remember is optional and must be boolean', () => {
  const normalized = validateRequestPayload({
    ...basePayload(),
    annotations: [{ id: 'a1', kind: '表达调整', note: '先给判断', quote: '' }],
  });
  assert.equal(normalized.annotations[0].remember, false);
  assert.throws(() => validateRequestPayload({
    ...basePayload(),
    annotations: [{ id: 'a1', kind: '表达调整', note: '先给判断', quote: '', remember: 'yes' }],
  }), /remember 必须是布尔值/);
});

test('persistent store deduplicates, increments confirmations, and retains twelve preferences', async () => {
  const { directory, store } = await temporaryMemoryStore({
    idFactory: (() => { let id = 0; return () => `m${++id}`; })(),
    clock: (() => { let tick = 0; return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)); })(),
  });
  try {
    await store.upsert([{ kind: '表达调整', text: '保持\n段落节奏' }]);
    await store.upsert([{ kind: '表达调整', text: '保持 段落节奏' }]);
    const duplicate = await store.list();
    assert.equal(duplicate.length, 1);
    assert.equal(duplicate[0].confirmations, 2);
    assert.equal(duplicate[0].text, '保持 段落节奏');
    await store.upsert(Array.from({ length: MAX_WRITING_MEMORIES + 2 }, (_, index) => ({
      kind: '结构建议',
      text: `结构建议${String.fromCharCode(0x4e00 + index)}`,
    })));
    const records = await store.list();
    assert.equal(records.length, MAX_WRITING_MEMORIES);
    assert.equal(records.some((item) => item.text === '保持 段落节奏'), false);
    const persisted = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
    assert.equal(persisted.schemaVersion, 'content-desk.memory.v1');
    assert.equal(persisted.memories.length, MAX_WRITING_MEMORIES);
    assert.deepEqual(persisted.experiences, []);
    await store.recordExperience({
      format: '专业方案', tone: '专业解释', targetLength: 900, score: 100,
      referenceTextPresent: true, activeAnnotationCount: 0, manualEdits: false, gatePassed: true,
    });
    const reloaded = createWritingMemoryStore({ filePath: store.filePath });
    const state = await reloaded.readState();
    assert.equal(state.memories.length, MAX_WRITING_MEMORIES);
    assert.equal(state.experiences.length, 1);
    assert.ok(state.experiences[0].text.length <= MAX_EXPERIENCE_TEXT_CHARS);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('memory HTTP API is read/delete only, supports CORS DELETE, and rejects public writes', async () => {
  const { directory, store } = await temporaryMemoryStore();
  try {
    await withServer({ store, statusProvider: async () => ({ ok: true }) }, async (port) => {
      const origin = 'http://localhost:3000';
      const initial = await httpJson(port, '/v1/memory', { headers: { Origin: origin } });
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.body.memories, []);
      assert.deepEqual(initial.body.experiences, []);
      await store.upsert([{ kind: '表达调整', text: '少用套话，先给判断条件' }]);
      const added = await httpJson(port, '/v1/memory', { headers: { Origin: origin } });
      assert.equal(added.status, 200);
      assert.equal(added.body.memories.length, 1);
      const id = added.body.memories[0].id;
      const publicWrite = await httpJson(port, '/v1/memory', {
        method: 'POST', headers: { Origin: origin },
        body: { entries: [{ kind: '表达调整', text: '不得绕过门禁' }] },
      });
      assert.equal(publicWrite.status, 405);
      assert.match(publicWrite.headers.allow, /GET/);
      assert.doesNotMatch(publicWrite.headers.allow, /POST/);
      const deleted = await httpJson(port, `/v1/memory?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Origin: origin },
      });
      assert.equal(deleted.status, 200);
      assert.deepEqual(deleted.body.memories, []);
      const preflight = await httpJson(port, '/v1/memory', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'DELETE' },
      });
      assert.equal(preflight.status, 204);
      assert.match(preflight.headers['access-control-allow-methods'], /DELETE/);
      assert.doesNotMatch(preflight.headers['access-control-allow-methods'], /POST/);
      const contentPreflight = await httpJson(port, '/v1/content', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
      assert.equal(contentPreflight.status, 204);
      assert.match(contentPreflight.headers['access-control-allow-methods'], /POST/);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('buildPrompt injects reference text and both memory partitions with non-authorization rules', async () => {
  const { directory, store } = await temporaryMemoryStore({ idFactory: (() => { let id = 0; return () => `m${++id}`; })() });
  try {
    await store.upsert([{ kind: '表达调整', text: '先给结论，再写验证动作' }]);
    await store.recordExperience({
      format: '专业方案', tone: '专业解释', targetLength: 900, score: 100,
      referenceTextPresent: false, activeAnnotationCount: 1, manualEdits: true, gatePassed: true,
    });
    const payload = validateRequestPayload({ ...basePayload(), referenceText: '范文中的短句节奏。' });
    payload.writingMemory = await store.readState();
    const prompt = buildPrompt(payload, 'writing');
    assert.match(prompt, /范文中的短句节奏/);
    assert.match(prompt, /先给结论，再写验证动作/);
    assert.match(prompt, /writingMemory\.experiences/);
    assert.match(prompt, /绝不是事实、数据、引文、URL、DOI、来源授权/);
    assert.match(prompt, /referenceText/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('content route reads memory for both stages and records only successful process experience', async () => {
  const { directory, store } = await temporaryMemoryStore({ idFactory: (() => { let id = 0; return () => `m${++id}`; })() });
  const prompts = [];
  try {
    await store.upsert([{ kind: '表达调整', text: '删掉空泛开场，先给判断条件' }]);
    await withServer({
      store,
      statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
      runner: async (prompt, context) => { prompts.push(prompt); return responseFor(context.payload); },
    }, async (port) => {
      const response = await httpJson(port, '/v1/content', {
        method: 'POST',
        body: { ...basePayload(), referenceText: '用户提供的范文节奏。' },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.memoryPromotion, { promotedAnnotationIds: [] });
      assert.equal(prompts.length, 2);
      assert.ok(prompts.every((prompt) => prompt.includes('删掉空泛开场，先给判断条件')));
      assert.ok(prompts.every((prompt) => prompt.includes('用户提供的范文节奏')));
      const state = await store.readState();
      assert.equal(state.experiences.length, 1);
      assert.match(state.experiences[0].text, /gatePassed=yes/);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('failed writing or sub-99 review leaves both memory partitions unchanged', async () => {
  const { directory, store } = await temporaryMemoryStore({ idFactory: (() => { let id = 0; return () => `m${++id}`; })() });
  try {
    await store.upsert([{ kind: '表达调整', text: '先给判断条件' }]);
    await store.recordExperience({
      format: '专业方案', tone: '专业解释', targetLength: 900, score: 100,
      referenceTextPresent: false, activeAnnotationCount: 0, manualEdits: false, gatePassed: true,
    });
    const before = await store.readState();
    await withServer({
      store,
      statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
      runner: async (_prompt, context) => {
        if (context.stage === 'quality_review') throw new Error('synthetic review failure');
        return responseFor(context.payload);
      },
    }, async (port) => {
      const failed = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
      assert.equal(failed.status, 502);
      assert.deepEqual(await store.readState(), before);
    });
    await withServer({
      store,
      statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
      runner: async (_prompt, context) => responseFor(context.payload, 94),
    }, async (port) => {
      const failed = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
      assert.equal(failed.status, 502);
      assert.deepEqual(await store.readState(), before);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('successful annotation regeneration promotes only applied safe remembered notes before responding', async () => {
  const { directory, store } = await temporaryMemoryStore({ idFactory: (() => { let id = 0; return () => `m${++id}`; })() });
  try {
    const currentDraft = '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。';
    const annotations = [
      { id: 'safe', kind: '表达调整', note: '先给判断条件，再补验证动作', quote: '', remember: true },
      { id: 'partial', kind: '表达调整', note: '部分应用不记住', quote: '', remember: true },
      { id: 'blocked', kind: '结构建议', note: '阻断意见不记住', quote: '', remember: true },
      { id: 'fact', kind: '事实核对', note: '事实核对不记住', quote: '', remember: true },
      { id: 'custom', kind: '自定义', note: '自定义 kind 不记住', quote: '', remember: true },
      { id: 'quantity', kind: '表达调整', note: '保留 37%', quote: '', remember: true },
      { id: 'date', kind: '表达调整', note: '从 2026年 开始', quote: '', remember: true },
      { id: 'customer', kind: '表达调整', note: '客户已采用', quote: '', remember: true },
      { id: 'quoted', kind: '表达调整', note: '有选区只改单次', quote: '证据分层', remember: true },
    ];
    await withServer({
      store,
      statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
      runner: async (_prompt, context) => {
        const result = responseFor(context.payload);
        result.receipts = context.payload.activeAnnotations.map((item) => ({
          id: item.id,
          status: item.id === 'partial' ? 'partially_applied' : item.id === 'blocked' ? 'blocked' : 'applied',
          message: '测试回执',
        }));
        return result;
      },
    }, async (port) => {
      const response = await httpJson(port, '/v1/content', {
        method: 'POST',
        body: basePayload({
          mode: 'annotation_regeneration',
          previousGeneratedDraft: currentDraft,
          currentDraft,
          annotations,
          versionId: `v1:${draftFingerprint(currentDraft)}`,
        }),
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body.memoryPromotion, { promotedAnnotationIds: ['safe'] });
      const state = await store.readState();
      assert.deepEqual(state.memories.map((item) => item.text), ['先给判断条件，再补验证动作']);
      assert.equal(state.experiences.length, 1);
    });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('memoryPromotion stays empty and warns when the internal preference write fails', async () => {
  const currentDraft = '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。';
  const failingStore = {
    readState: async () => ({ memories: [], experiences: [] }),
    upsert: async () => { throw new Error('synthetic write failure'); },
    recordExperience: async () => {},
  };
  await withServer({
    store: failingStore,
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => responseFor(context.payload),
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: basePayload({
        mode: 'annotation_regeneration',
        previousGeneratedDraft: currentDraft,
        currentDraft,
        annotations: [{ id: 'safe', kind: '表达调整', note: '先给判断条件', quote: '', remember: true }],
        versionId: `v1:${draftFingerprint(currentDraft)}`,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.memoryPromotion, { promotedAnnotationIds: [] });
    assert.ok(response.body.warnings.some((item) => /未能保存为长期偏好/.test(item)));
  });
});

test('content continues with empty memory when local memory read fails, and referenceText is bounded', async () => {
  const prompts = [];
  const brokenStore = {
    readState: async () => { throw new Error('simulated disk failure'); },
  };
  await withServer({
    store: brokenStore,
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (prompt, context) => { prompts.push(prompt); return responseFor(context.payload); },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 200);
    assert.ok(response.body.warnings.some((item) => /长期写作记忆暂不可用/.test(item)));
    assert.ok(prompts.every((prompt) => /"preferences": \[\]/u.test(prompt)));
    assert.throws(() => validateRequestPayload({ ...basePayload(), referenceText: 'x'.repeat(MAX_REFERENCE_TEXT_CHARS + 1) }), /超出长度限制/);
  });
});
