import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import test from 'node:test';

import {
  BridgeError,
  MAX_DNA_CORPUS_TEXT_CHARS,
  appendDnaCorpus,
  createBridgeServer,
  createCancellationController,
  EDITORIAL_SCORE_DIMENSIONS,
  EDITORIAL_SCORE_THRESHOLD,
  runSpawnedCodexProcess,
} from '../server.mjs';

function httpJson(port, requestPath, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const requestHeaders = { ...headers };
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
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = raw; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
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
  await new Promise((resolve) => server.once('listening', resolve));
  try { return await callback(server.address().port); }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

const corpusText = '这是用户提供的完整范文语料，用于验证原始 Writing DNA 的固定 raw 工作区接入、哈希幂等和状态检查。'.repeat(2);

function successfulResponse(payload) {
  const dimensions = Object.fromEntries(Object.entries(EDITORIAL_SCORE_DIMENSIONS)
    .map(([key, definition]) => [key, { score: definition.max, max: definition.max, reasons: [] }]));
  return {
    schemaVersion: 'codex.bridge.response.v1',
    status: 'succeeded',
    mode: payload.mode,
    versionId: `commit-${payload.mode}`,
    draft: '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。',
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
        total: 100,
        threshold: EDITORIAL_SCORE_THRESHOLD,
        dimensions,
        deductions: [],
      },
    },
    warnings: [],
  };
}

test('reference corpus is appended to the fixed DNA raw workspace with a hash idempotency key', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-corpus-'));
  const first = await appendDnaCorpus({ mode: 'writing', text: corpusText, projectRoot });
  assert.equal(first.schemaVersion, 'content-desk.dna.v1');
  assert.equal(first.corpus.mode, 'writing');
  assert.equal(first.corpus.added, true);
  assert.match(first.corpus.file, /^writing-dna-workspace\/general\/raw\/reference-[a-f0-9]{64}\.md$/u);
  assert.equal(first.modes.writing.corpusCount, 1);
  assert.equal(first.modes.writing.ready, false);
  const stored = await fs.readFile(path.join(projectRoot, first.corpus.file), 'utf8');
  assert.equal(stored, `${corpusText}\n`);

  const second = await appendDnaCorpus({ mode: 'writing', text: `\r\n ${corpusText} \r\n`, projectRoot });
  assert.equal(second.corpus.added, false);
  assert.equal(second.corpus.file, first.corpus.file);
  assert.equal(second.modes.writing.corpusCount, 1);
});

test('DNA corpus append rejects empty, short and oversized text without pretending readiness', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-corpus-invalid-'));
  await assert.rejects(
    appendDnaCorpus({ mode: 'academic', text: '太短', projectRoot }),
    (error) => error instanceof BridgeError && error.code === 'dna_corpus_too_short',
  );
  await assert.rejects(
    appendDnaCorpus({ mode: 'academic', text: 'x'.repeat(MAX_DNA_CORPUS_TEXT_CHARS + 1), projectRoot }),
    (error) => error instanceof BridgeError && error.code === 'field_too_large',
  );
  await assert.rejects(
    appendDnaCorpus({ mode: 'unknown', text: corpusText, projectRoot }),
    (error) => error instanceof BridgeError && error.code === 'invalid_request',
  );
  const files = await fs.readdir(path.join(projectRoot, 'writing-dna-workspace')).catch(() => []);
  assert.deepEqual(files, []);
});

test('DNA corpus HTTP endpoint accepts text only and returns the latest real status', async () => {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-corpus-http-'));
  await withServer({ projectRoot, statusProvider: async () => ({ ok: true }) }, async (port) => {
    const accepted = await httpJson(port, '/v1/dna/corpus', {
      method: 'POST',
      body: { mode: 'academic', text: corpusText },
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.corpus.mode, 'academic');
    assert.equal(accepted.body.modes.academic.corpusCount, 1);
    assert.equal(accepted.body.modes.academic.ready, false);
    const extra = await httpJson(port, '/v1/dna/corpus', {
      method: 'POST',
      body: { mode: 'academic', text: corpusText, file: 'C:/outside.txt' },
    });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.code, 'invalid_request');
  });
});

test('cancellation controller only kills its exact active child and reports deterministic states', () => {
  const killed = [];
  const controller = createCancellationController({ terminate: (child) => { killed.push(child.pid); child.killed = true; } });
  const first = controller.begin({ clientRunId: 'run-1', stage: 'writing' });
  const child = { pid: 1234, killed: false };
  const unregister = controller.register(child, { stage: 'writing', clientRunId: 'run-1' });
  assert.deepEqual(controller.cancel(), { status: 'mismatch', code: 'run_mismatch', stage: 'writing' });
  assert.deepEqual(controller.cancel('other-run'), { status: 'mismatch', code: 'run_mismatch', stage: 'writing' });
  assert.deepEqual(killed, []);
  assert.deepEqual(controller.cancel('run-1'), {
    status: 'cancelling',
    code: 'cancel_requested',
    stage: 'writing',
    clientRunId: 'run-1',
  });
  assert.deepEqual(controller.cancel('run-1'), {
    status: 'cancelling',
    code: 'cancel_requested',
    stage: 'writing',
    clientRunId: 'run-1',
  });
  assert.deepEqual(killed, [1234]);
  assert.throws(() => controller.throwIfCancelled('writing'), (error) => error.code === 'cancelled' && error.stage === 'writing');
  unregister();
  controller.end(first);
  assert.deepEqual(controller.cancel(), { status: 'idle', code: 'idle' });
});

test('cancellation controller has an atomic commit point after which stops are rejected', () => {
  const killed = [];
  const controller = createCancellationController({ terminate: (child) => killed.push(child.pid) });
  const operation = controller.begin({ clientRunId: 'commit-run', stage: 'quality_gate' });
  const child = { pid: 4321 };
  controller.register(child, { stage: 'quality_gate', clientRunId: 'commit-run' });

  controller.beginCommit('committing');
  assert.deepEqual(controller.current(), {
    clientRunId: 'commit-run',
    stage: 'committing',
    kind: 'content',
    cancelRequested: false,
    committing: true,
    childPid: 4321,
  });
  assert.deepEqual(controller.cancel('commit-run'), {
    status: 'committing',
    code: 'run_committing',
    stage: 'committing',
    clientRunId: 'commit-run',
  });
  assert.deepEqual(killed, []);
  assert.equal(controller.current().cancelRequested, false);

  controller.end(operation);
  const cancelled = controller.begin({ clientRunId: 'cancel-before-commit', stage: 'quality_gate' });
  assert.deepEqual(controller.cancel('cancel-before-commit').code, 'cancel_requested');
  assert.throws(
    () => controller.beginCommit('committing'),
    (error) => error instanceof BridgeError && error.code === 'cancelled' && error.stage === 'committing',
  );
  assert.equal(controller.current().committing, false);
  controller.end(cancelled);
});

test('runSpawnedCodexProcess turns an exact child-tree stop into cancelled', async () => {
  let child;
  const controller = createCancellationController({ terminate: (target) => target.kill() });
  const promise = runSpawnedCodexProcess('fake-codex', [], 'prompt', {
    stage: 'quality_review',
    clientRunId: 'cancel-process',
    cancelController: controller,
    spawnProcess: () => {
      child = new EventEmitter();
      child.pid = 5678;
      child.stdin = new EventEmitter();
      child.stdin.end = () => {};
      child.kill = () => {
        child.killed = true;
        queueMicrotask(() => child.emit('close', 1));
      };
      return child;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const result = controller.cancel('cancel-process');
  assert.equal(result.code, 'cancel_requested');
  await assert.rejects(promise, (error) => error instanceof BridgeError
    && error.code === 'cancelled'
    && error.stage === 'quality_review');
  assert.equal(child.killed, true);
});

test('cancel endpoint is instance-local, rejects mismatched IDs, and records cancelled content runs', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runner = async () => {
    await gate;
    return {
      schemaVersion: 'codex.bridge.response.v1',
      status: 'succeeded',
      mode: 'initial_generation',
      versionId: 'cancel-test',
      draft: '测试草稿。',
      titleCandidates: ['标题一', '标题二', '标题三'],
      recommendedTitle: '标题一',
      outline: ['边界', '动作', '验收'],
      tags: ['测试'],
      receipts: [],
      diagnostics: {
        humanized: true,
        changes: [],
        remainingFlags: [],
        engine: 'codex-cli',
        rulesVersion: 'industrial-process-control.v1',
        model: 'fake',
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
        },
      },
      warnings: [],
    };
  };
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-cancel-runs-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-cancel-project-'));
  const base = {
    mode: 'initial_generation',
    brief: {
      topic: '测试取消', audience: '研发负责人', format: '专业方案', tone: '专业解释', targetLength: '900', materials: '待核验。',
    },
    previousGeneratedDraft: '', currentDraft: '', annotations: [], voiceProfile: { tone: '专业解释', traits: ['具体'] }, targetLength: 900,
    clientRunId: 'cancel-http',
  };
  await withServer({ runner, runsPath, projectRoot, statusProvider: async () => ({ ok: true }) }, async (port) => {
    const requestPromise = httpJson(port, '/v1/content', { method: 'POST', body: base });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const running = await httpJson(port, '/v1/runs/cancel-http');
      if (running.status === 200 && running.body.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const wrong = await httpJson(port, '/v1/cancel', { method: 'POST', body: { clientRunId: 'wrong' } });
    const missing = await httpJson(port, '/v1/cancel', { method: 'POST', body: {} });
    assert.equal(missing.status, 409);
    assert.equal(missing.body.code, 'run_mismatch');
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.code, 'run_mismatch');
    const stopped = await httpJson(port, '/v1/cancel', { method: 'POST', body: { clientRunId: 'cancel-http' } });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.code, 'cancel_requested');
    release();
    const response = await requestPromise;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'cancelled');
    assert.equal((await httpJson(port, '/v1/runs/cancel-http')).body.error.code, 'cancelled');
    const idle = await httpJson(port, '/v1/cancel', { method: 'POST', body: {} });
    assert.equal(idle.status, 200);
    assert.equal(idle.body.code, 'idle');
  });
});

test('HTTP cancel before commit returns cancelled and leaves memory side effects untouched', async () => {
  let release;
  let resolveWritingStarted;
  const writingStarted = new Promise((resolve) => { resolveWritingStarted = resolve; });
  const writingGate = new Promise((resolve) => { release = resolve; });
  let experienceWrites = 0;
  const store = {
    readState: async () => ({ memories: [], experiences: [] }),
    recordExperience: async () => { experienceWrites += 1; },
  };
  const runner = async (_prompt, { stage, payload }) => {
    if (stage === 'writing') {
      resolveWritingStarted();
      await writingGate;
    }
    return successfulResponse(payload);
  };
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-commit-before-runs-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-commit-before-project-'));
  const payload = {
    mode: 'initial_generation',
    brief: {
      topic: '取消发生在提交点之前', audience: '研发负责人', format: '专业方案', tone: '专业解释', targetLength: '900', materials: '待核验。',
    },
    previousGeneratedDraft: '', currentDraft: '', annotations: [], voiceProfile: { tone: '专业解释', traits: ['具体'] }, targetLength: 900,
    clientRunId: 'cancel-before-commit',
  };
  try {
    await withServer({ store, runner, runsPath, projectRoot, statusProvider: async () => ({ ok: true }) }, async (port) => {
      const requestPromise = httpJson(port, '/v1/content', { method: 'POST', body: payload });
      await writingStarted;
      const stopped = await httpJson(port, '/v1/cancel', {
        method: 'POST',
        body: { clientRunId: payload.clientRunId },
      });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.code, 'cancel_requested');
      release();
      const response = await requestPromise;
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'cancelled');
      const ledger = await httpJson(port, `/v1/runs/${payload.clientRunId}`);
      assert.equal(ledger.status, 200);
      assert.equal(ledger.body.status, 'failed');
      assert.equal(ledger.body.error.code, 'cancelled');
      assert.equal(experienceWrites, 0);
    });
  } finally {
    await Promise.all([
      fs.rm(runsPath, { recursive: true, force: true }),
      fs.rm(projectRoot, { recursive: true, force: true }),
    ]);
  }
});

test('HTTP cancel after commit reports run_committing and content finishes succeeded', async () => {
  let release;
  let resolveExperienceStarted;
  const experienceStarted = new Promise((resolve) => { resolveExperienceStarted = resolve; });
  const experienceGate = new Promise((resolve) => { release = resolve; });
  let experienceWrites = 0;
  const store = {
    readState: async () => ({ memories: [], experiences: [] }),
    recordExperience: async () => {
      experienceWrites += 1;
      resolveExperienceStarted();
      await experienceGate;
    },
  };
  const runner = async (_prompt, { payload }) => successfulResponse(payload);
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-commit-after-runs-'));
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-commit-after-project-'));
  const payload = {
    mode: 'initial_generation',
    brief: {
      topic: '取消发生在提交点之后', audience: '研发负责人', format: '专业方案', tone: '专业解释', targetLength: '900', materials: '待核验。',
    },
    previousGeneratedDraft: '', currentDraft: '', annotations: [], voiceProfile: { tone: '专业解释', traits: ['具体'] }, targetLength: 900,
    clientRunId: 'cancel-after-commit',
  };
  try {
    await withServer({ store, runner, runsPath, projectRoot, statusProvider: async () => ({ ok: true }) }, async (port) => {
      const requestPromise = httpJson(port, '/v1/content', { method: 'POST', body: payload });
      await experienceStarted;
      const health = await httpJson(port, '/health');
      assert.equal(health.body.stage, 'committing');
      const stopped = await httpJson(port, '/v1/cancel', {
        method: 'POST',
        body: { clientRunId: payload.clientRunId },
      });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.status, 'committing');
      assert.equal(stopped.body.code, 'run_committing');
      assert.equal(stopped.body.clientRunId, payload.clientRunId);
      release();
      const response = await requestPromise;
      assert.equal(response.status, 200);
      assert.equal(response.body.status, 'succeeded');
      const ledger = await httpJson(port, `/v1/runs/${payload.clientRunId}`);
      assert.equal(ledger.status, 200);
      assert.equal(ledger.body.status, 'succeeded');
      assert.equal(experienceWrites, 1);
      assert.equal((await httpJson(port, '/v1/cancel', { method: 'POST', body: {} })).body.code, 'idle');
    });
  } finally {
    await Promise.all([
      fs.rm(runsPath, { recursive: true, force: true }),
      fs.rm(projectRoot, { recursive: true, force: true }),
    ]);
  }
});

test('two Bridge instances do not share cancel state', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const base = {
    mode: 'initial_generation',
    brief: {
      topic: '双实例取消隔离测试', audience: '研发负责人', format: '专业方案', tone: '专业解释', targetLength: '900', materials: '待核验。',
    },
    previousGeneratedDraft: '', currentDraft: '', annotations: [], voiceProfile: { tone: '专业解释', traits: ['具体'] }, targetLength: 900,
    clientRunId: 'instance-a-run',
  };
  const serverA = createBridgeServer({
    port: 0,
    runsPath: await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-instance-a-')),
    runner: async () => {
      await gate;
      throw new BridgeError(409, 'cancelled', '已停止 Codex 执行，当前稿未被覆盖', 'writing');
    },
    statusProvider: async () => ({ ok: true }),
  });
  const serverB = createBridgeServer({ port: 0, statusProvider: async () => ({ ok: true }) });
  serverA.listen(0, '127.0.0.1');
  serverB.listen(0, '127.0.0.1');
  await Promise.all([
    new Promise((resolve) => serverA.once('listening', resolve)),
    new Promise((resolve) => serverB.once('listening', resolve)),
  ]);
  const portA = serverA.address().port;
  const portB = serverB.address().port;
  try {
    const requestPromise = httpJson(portA, '/v1/content', { method: 'POST', body: base });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const running = await httpJson(portA, '/v1/runs/instance-a-run');
      if (running.status === 200 && running.body.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const idleB = await httpJson(portB, '/v1/cancel', { method: 'POST', body: {} });
    assert.equal(idleB.status, 200);
    assert.equal(idleB.body.code, 'idle');
    assert.equal((await httpJson(portA, '/health')).body.busy, true);
    const wrongA = await httpJson(portA, '/v1/cancel', { method: 'POST', body: { clientRunId: 'other' } });
    assert.equal(wrongA.status, 409);
    assert.equal(wrongA.body.code, 'run_mismatch');
    const stoppedA = await httpJson(portA, '/v1/cancel', { method: 'POST', body: { clientRunId: 'instance-a-run' } });
    assert.equal(stoppedA.status, 200);
    assert.equal(stoppedA.body.code, 'cancel_requested');
    release();
    const response = await requestPromise;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'cancelled');
    assert.equal((await httpJson(portA, '/v1/runs/instance-a-run')).body.error.code, 'cancelled');
  } finally {
    await Promise.all([
      new Promise((resolve) => serverA.close(resolve)),
      new Promise((resolve) => serverB.close(resolve)),
    ]);
  }
});

test('DNA distillation also honors an empty-ID stop because it has no content run id', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const server = createBridgeServer({
    port: 0,
    statusProvider: async () => ({ ok: true }),
    dnaRunner: async (_mode, { cancelController }) => {
      await gate;
      cancelController.throwIfCancelled('dna_distill');
      return {
        status: {
          schemaVersion: 'content-desk.dna.v1',
          modes: {
            writing: { mode: 'writing', corpusCount: 0, minimumCorpus: 20, ready: false, workspace: 'writing-dna-workspace/general' },
            academic: { mode: 'academic', corpusCount: 0, minimumCorpus: 1, ready: false, workspace: 'writing-dna-workspace/academic' },
          },
        },
      };
    },
  });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  try {
    const requestPromise = httpJson(port, '/v1/dna/distill', { method: 'POST', body: { mode: 'academic' } });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((await httpJson(port, '/health')).body.busy) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const stopped = await httpJson(port, '/v1/cancel', { method: 'POST', body: {} });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.code, 'cancel_requested');
    release();
    const response = await requestPromise;
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'cancelled');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
