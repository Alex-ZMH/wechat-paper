import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import test from 'node:test';

import {
  buildDnaUsage,
  buildPrompt,
  buildSkillUsage,
  createBridgeServer,
  createRunStore,
  draftFingerprint,
  validateClientRunId,
  validateRequestPayload,
} from '../server.mjs';

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

function validEditorialScore() {
  return {
    total: 100,
    threshold: 99,
    dimensions: {
      factualBoundaries: { score: 25, max: 25, reasons: [] },
      specificActionability: { score: 25, max: 25, reasons: [] },
      authorVoiceContinuation: { score: 20, max: 20, reasons: [] },
      antiTemplateVariation: { score: 20, max: 20, reasons: [] },
      mobileClarity: { score: 10, max: 10, reasons: [] },
    },
    deductions: [],
  };
}

function validResponse(payload) {
  return {
    schemaVersion: 'codex.bridge.response.v1',
    status: 'succeeded',
    mode: payload.mode,
    versionId: 'fake-version',
    draft: '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。',
    titleCandidates: ['从多站点问题找到共因', '过程管控的跨站点分析方法', '把异常从单点拉回系统看'],
    recommendedTitle: '从多站点问题找到共因',
    outline: ['问题边界与数据主键', '共因分析与证据链', '试点、处置和人工边界'],
    tags: ['过程管控', '质量分析', 'MES'],
    receipts: [],
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
      editorialScore: validEditorialScore(),
    },
    warnings: [],
  };
}

function httpJson(port, requestPath, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method,
      headers: encoded
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) }
        : {},
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let bodyValue;
        try { bodyValue = raw ? JSON.parse(raw) : undefined; } catch { bodyValue = raw; }
        resolve({ status: res.statusCode, body: bodyValue });
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

test('legacy requests keep industrial plus legacy DNA mapping; explicit empty chain is valid', () => {
  const legacy = validateRequestPayload(basePayload({ dnaMode: 'writing' }));
  assert.deepEqual(legacy.skillChain, ['industrial-ai-wechat-research-writing', 'writing-dna']);
  assert.equal(legacy.dnaMode, 'writing');
  const empty = validateRequestPayload(basePayload({ skillChain: [] }));
  assert.deepEqual(empty.skillChain, []);
  assert.equal(empty.dnaMode, 'none');
});

test('skillChain preserves order, supports both DNA nodes, and emits server usage receipts', () => {
  const payload = validateRequestPayload(basePayload({
    skillChain: ['academic-writing-dna', 'industrial-ai-wechat-research-writing', 'writing-dna'],
  }));
  const prompt = buildPrompt(payload, 'quality_review');
  assert.ok(prompt.indexOf('1. academic-writing-dna') < prompt.indexOf('2. industrial-ai-wechat-research-writing'));
  assert.ok(prompt.indexOf('2. industrial-ai-wechat-research-writing') < prompt.indexOf('3. writing-dna'));
  assert.match(prompt, /后置 Skill 只在写法、结构或节奏发生冲突时覆盖前置 Skill/);
  assert.equal(buildDnaUsage(payload.skillChain).mode, 'writing');
  assert.deepEqual(buildSkillUsage(payload.skillChain).chain.map((item) => item.order), [1, 2, 3]);
  assert.equal(buildSkillUsage(payload.skillChain).core.qualityGate, 'completed');
});

test('skillChain rejects wrong type, duplicate, unknown, overlong, and contradictory legacy DNA', () => {
  for (const skillChain of [null, 'writing-dna', ['writing-dna', 'writing-dna'], ['unknown'], [
    'industrial-ai-wechat-research-writing', 'writing-dna', 'academic-writing-dna', 'unknown',
  ]]) {
    assert.throws(() => validateRequestPayload(basePayload({ skillChain })), /skillChain/);
  }
  assert.throws(
    () => validateRequestPayload(basePayload({ skillChain: [], dnaMode: 'academic' })),
    /dnaMode.*skillChain/,
  );
  assert.throws(() => validateClientRunId('../escape'), /clientRunId/);
  assert.throws(() => validateClientRunId('x'.repeat(129)), /clientRunId/);
});

test('unready DNA chain is rejected before Codex and identifies the blocked workflow node', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-chain-'));
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-chain-runs-'));
  let calls = 0;
  await withServer({
    projectRoot,
    runsPath,
    runner: async () => { calls += 1; return validResponse(basePayload()); },
    statusProvider: async () => ({ ok: true }),
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: basePayload({ skillChain: ['writing-dna'], clientRunId: 'dna-unready' }),
    });
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'dna_not_ready');
    assert.equal(response.body.workflowNode, 'writing-dna');
    assert.equal(calls, 0);
  });
});

test('run ledger supports refresh retrieval, atomic terminal state, unknown/illegal IDs, and closed future API paths', async () => {
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-runs-'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withServer({
    runsPath,
    statusProvider: async () => ({ ok: true }),
    runner: async (_prompt, context) => {
      await gate;
      return validResponse(context.payload);
    },
  }, async (port) => {
    const body = basePayload({ clientRunId: 'refresh-run' });
    const requestPromise = httpJson(port, '/v1/content', { method: 'POST', body });
    let running;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      running = await httpJson(port, '/v1/runs/refresh-run');
      if (running.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(running.status, 200);
    assert.equal(running.body.status, 'running');
    release();
    assert.equal((await requestPromise).status, 200);
    const succeeded = await httpJson(port, '/v1/runs/refresh-run');
    assert.equal(succeeded.status, 200);
    assert.equal(succeeded.body.status, 'succeeded');
    assert.equal(succeeded.body.result.skillUsage.schemaVersion, 'content-desk.skill-usage.v1');
    assert.equal((await httpJson(port, '/v1/runs/missing-run')).status, 404);
    assert.equal((await httpJson(port, '/v1/runs/%2Fescape')).status, 400);
    assert.equal((await httpJson(port, '/v1/future')).status, 404);
    assert.equal((await httpJson(port, '/v1/runs/refresh-run', { method: 'DELETE' })).status, 204);
    assert.equal((await httpJson(port, '/v1/runs/refresh-run')).status, 404);
    const files = await fs.readdir(runsPath);
    assert.deepEqual(files, []);
  });
});

test('terminal clientRunId cannot be overwritten and can be deleted explicitly', async () => {
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-duplicate-runs-'));
  await withServer({
    runsPath,
    statusProvider: async () => ({ ok: true }),
    runner: async (_prompt, context) => validResponse(context.payload),
  }, async (port) => {
    const body = basePayload({ clientRunId: 'stable-run' });
    assert.equal((await httpJson(port, '/v1/content', { method: 'POST', body })).status, 200);
    const duplicate = await httpJson(port, '/v1/content', { method: 'POST', body });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, 'run_exists');
    const original = await httpJson(port, '/v1/runs/stable-run');
    assert.equal(original.body.status, 'succeeded');
    assert.equal((await httpJson(port, '/v1/runs/stable-run', { method: 'DELETE' })).status, 204);
  });
});

test('failed run ledger records sanitized error and workflow node', async () => {
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-failed-runs-'));
  await withServer({
    runsPath,
    statusProvider: async () => ({ ok: true }),
    runner: async () => { throw new Error('synthetic review failure with secret prompt'); },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: basePayload({ clientRunId: 'failed-run' }),
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'writing_failed');
    assert.equal(response.body.workflowNode, 'codex-writer');
    const stored = await httpJson(port, '/v1/runs/failed-run');
    assert.equal(stored.status, 200);
    assert.equal(stored.body.status, 'failed');
    assert.equal(stored.body.error.workflowNode, 'codex-writer');
    assert.equal(JSON.stringify(stored.body).includes('secret prompt'), false);
  });
});

test('orphaned running records become terminal run_interrupted after a Bridge restart', async () => {
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-orphan-runs-'));
  await fs.writeFile(path.join(runsPath, 'orphan-run.json'), JSON.stringify({
    schemaVersion: 'content-desk.run.v1',
    clientRunId: 'orphan-run',
    status: 'running',
    startedAt: '2026-08-28T00:00:00.000Z',
    updatedAt: '2026-08-28T00:00:01.000Z',
  }), 'utf8');
  const store = createRunStore({ directory: runsPath });
  const record = await store.get('orphan-run');
  assert.equal(record.status, 'failed');
  assert.equal(record.error.code, 'run_interrupted');
  const persisted = JSON.parse(await fs.readFile(path.join(runsPath, 'orphan-run.json'), 'utf8'));
  assert.equal(persisted.status, 'failed');
});

test('annotation regeneration legacy version token still validates with explicit empty chain', () => {
  const currentDraft = '当前稿保留这句。';
  const payload = validateRequestPayload(basePayload({
    mode: 'annotation_regeneration',
    previousGeneratedDraft: currentDraft,
    currentDraft,
    annotations: [],
    versionId: `v1:${draftFingerprint(currentDraft)}`,
    skillChain: [],
  }));
  assert.deepEqual(payload.skillChain, []);
  assert.equal(payload.dnaMode, 'none');
});
