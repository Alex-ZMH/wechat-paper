import assert from 'node:assert/strict';
import { request } from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  EDITORIAL_SCORE_DIMENSIONS,
  MODEL_CATALOG_SCHEMA_VERSION,
  buildCodexExecArgs,
  buildWorkflowReceipt,
  contentHash,
  createContentStore,
  createBridgeServer,
  runPipeline,
  scanDraftForQuality,
  validateRequestPayload,
} from '../server.mjs';

function editorialScore(total = 100) {
  const dimensions = Object.fromEntries(Object.entries(EDITORIAL_SCORE_DIMENSIONS).map(([key, definition]) => [
    key,
    { score: definition.max, max: definition.max, reasons: [] },
  ]));
  let remaining = 100 - total;
  for (const [key, definition] of Object.entries(EDITORIAL_SCORE_DIMENSIONS)) {
    if (remaining <= 0) break;
    const points = Math.min(definition.max, remaining);
    dimensions[key].score -= points;
    dimensions[key].reasons.push(`扣 ${points} 分：测试用例扣分理由。`);
    remaining -= points;
  }
  return {
    total,
    threshold: 99,
    dimensions,
    deductions: Object.entries(dimensions)
      .filter(([, item]) => item.max !== item.score)
      .map(([dimension, item]) => ({ dimension, points: item.max - item.score, reason: item.reasons[0] })),
  };
}

function scoreMinusOne(dimension) {
  const score = editorialScore(100);
  score.dimensions[dimension].score -= 1;
  score.dimensions[dimension].reasons = ['扣 1 分：该维度仍有一处待核对。'];
  score.total = 99;
  score.deductions = [{ dimension, points: 1, reason: score.dimensions[dimension].reasons[0] }];
  return score;
}

function requestPayload(overrides = {}) {
  return validateRequestPayload({
    schemaVersion: 'content-desk.request.v2',
    task: { kind: 'article', domain: 'general', genre: 'analysis', channel: 'wechat', purpose: 'explain' },
    mode: 'initial_generation',
    brief: { topic: '如何判断一个工具是否值得长期使用', audience: '知识创作者', format: '调研文章', tone: '克制', materials: '' },
    targetLength: 600,
    ...overrides,
  });
}

function responseFor(payload, { score = 100, draft = '先界定问题，再给出可核验的判断和下一步动作。', passed = true } = {}) {
  return {
    schemaVersion: 'content-desk.response.v2',
    status: passed ? 'succeeded' : 'succeeded_with_warnings',
    mode: payload.mode,
    versionId: 'v31-test',
    draft,
    titleCandidates: ['工具是否值得长期使用', '从一次试用走向长期判断', '给个人创作者的工具评估方法'],
    recommendedTitle: '工具是否值得长期使用',
    outline: ['先定义判断问题', '再核对使用证据', '最后决定是否保留'],
    tags: ['工具评估', '知识创作', '工作流'],
    receipts: payload.activeAnnotations.map((item) => ({ id: item.id, status: 'applied', message: '已按批注处理。' })),
    diagnostics: {
      humanized: true,
      changes: [],
      remainingFlags: [],
      engine: 'codex-cli',
      rulesVersion: 'nonfiction-editorial.v1',
      model: 'test-model',
      passes: 2,
      preservedUserEdits: [],
    },
    editorialMemo: { preservedUserEdits: [], unresolved: [] },
    qualityReview: {
      passed,
      issues: passed ? [] : ['仍需人工复核'],
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
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : undefined }));
    });
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

async function withServer(options, callback) {
  const server = createBridgeServer({ port: 0, ...options });
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await callback(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('dual review takes the conservative score and keeps a 100/98 pair review_required', async () => {
  const payload = requestPayload({ dualReview: true });
  let calls = 0;
  const stages = [];
  const result = await runPipeline(payload, {
    onStage: (stage) => stages.push(stage),
    runner: async (_prompt, context) => {
      calls += 1;
      if (context.audit) return responseFor(payload, { score: 98 });
      return responseFor(payload, { score: 100 });
    },
  });
  assert.equal(calls, 3, 'writer + reviewer A + reviewer B');
  assert.equal(result.status, 'review_required');
  assert.equal(result.qualityReview.editorialScore.total, 98);
  assert.equal(result.reviewAudit.conservativeScore, 98);
  assert.deepEqual(result.reviewAudit.reviewers.map((item) => item.score), [100, 98]);
  assert.equal(result.reviewAudit.exactMatch, true);
  assert.deepEqual(stages, ['writing', 'quality_review', 'quality_review_audit', 'quality_gate']);
});

test('dual review merges tied totals per dimension instead of dropping either deduction', async () => {
  const payload = requestPayload({ dualReview: true });
  const result = await runPipeline(payload, {
    runner: async (prompt, context) => {
      if (context.audit) return {
        ...responseFor(payload),
        qualityReview: {
          ...responseFor(payload).qualityReview,
          editorialScore: scoreMinusOne('specificActionability'),
        },
      };
      if (context.stage === 'quality_review') return {
        ...responseFor(payload),
        qualityReview: {
          ...responseFor(payload).qualityReview,
          editorialScore: scoreMinusOne('factualBoundaries'),
        },
      };
      return responseFor(payload);
    },
  });
  assert.equal(result.reviewAudit.reviewers[0].score, 99);
  assert.equal(result.reviewAudit.reviewers[1].score, 99);
  assert.equal(result.qualityReview.editorialScore.total, 98);
  assert.equal(result.status, 'review_required');
});

test('second reviewer receives a frozen manuscript without reviewer A verdict data', async () => {
  const payload = requestPayload({
    dualReview: true,
    annotations: [{ id: 'a-secret', kind: '表达调整', note: '保留作者语气。', quote: '', remember: false }],
  });
  let auditPrompt = '';
  const result = await runPipeline(payload, {
    runner: async (prompt, context) => {
      if (context.audit) {
        auditPrompt = prompt;
        const value = responseFor(payload);
        value.receipts[0].message = 'B_INDEPENDENT_RECEIPT_REASON';
        return value;
      }
      const value = responseFor(payload);
      if (context.stage === 'quality_review') {
        value.qualityReview.issues = ['A_ONLY_SECRET'];
        value.editorialMemo.unresolved = ['A_UNRESOLVED_SECRET'];
        value.diagnostics.remainingFlags = ['A_FLAG_SECRET'];
        value.receipts = [{ id: 'a-secret', status: 'applied', message: 'A_RECEIPT_SECRET' }];
      }
      return value;
    },
  });
  assert.equal(result.status, 'review_required');
  assert.equal(result.receipts[0].message, 'A_RECEIPT_SECRET');
  assert.doesNotMatch(auditPrompt, /A_ONLY_SECRET|A_UNRESOLVED_SECRET|A_FLAG_SECRET|A_RECEIPT_SECRET/);
});

test('dual review compares annotation decisions without requiring identical prose', async () => {
  const payload = requestPayload({
    dualReview: true,
    annotations: [{ id: 'a-decision', kind: '表达调整', note: '保留作者语气。', quote: '', remember: false }],
  });
  await assert.rejects(
    () => runPipeline(payload, {
      runner: async (_prompt, context) => {
        const value = responseFor(payload);
        if (context.audit) {
          value.receipts[0] = { id: 'a-decision', status: 'blocked', message: '与作者手改冲突。' };
        }
        return value;
      },
    }),
    (error) => error?.code === 'review_audit_mismatch'
      && error?.details?.mismatchFields?.includes('receipts'),
  );
});

test('dual review fails closed when the second reviewer changes frozen正文', async () => {
  const payload = requestPayload({ dualReview: true });
  await assert.rejects(
    () => runPipeline(payload, {
      runner: async (_prompt, context) => context.audit
        ? responseFor(payload, { draft: '第二位审核偷偷改了正文。' })
        : responseFor(payload),
    }),
    (error) => error?.code === 'review_audit_mismatch',
  );
});

test('deterministic anti-template flag blocks a model self-reporting 100/100', async () => {
  const payload = requestPayload();
  const result = await runPipeline(payload, {
    runner: async (_prompt, context) => context.stage === 'quality_review'
      ? responseFor(payload, { draft: '在这个快节奏的时代，当然可以一键解决，保证提升效率。' })
      : responseFor(payload),
  });
  assert.equal(result.qualityReview.editorialScore.total, 100);
  assert.equal(result.status, 'review_required');
});

test('an honest humanized=false review remains a reviewable candidate instead of breaking the output contract', async () => {
  const payload = requestPayload();
  const result = await runPipeline(payload, {
    runner: async (_prompt, context) => {
      const value = responseFor(payload);
      if (context.stage === 'quality_review') value.diagnostics.humanized = false;
      return value;
    },
  });
  assert.equal(result.status, 'review_required');
  assert.equal(result.diagnostics.humanized, false);
});

test('initial v2 generation retains a hard-rejected candidate for inspection without passing the gate', async () => {
  const payload = requestPayload();
  const result = await runPipeline(payload, {
    runner: async (_prompt, context) => {
      const value = responseFor(payload);
      if (context.stage === 'quality_review') {
        value.qualityReview.passed = false;
        value.qualityReview.issues = ['事实边界仍需核对'];
        value.qualityReview.checks.accuracy = false;
        value.qualityReview.editorialScore = scoreMinusOne('factualBoundaries');
      }
      return value;
    },
  });
  assert.equal(result.status, 'review_required');
  assert.equal(result.qualityReview.passed, false);
  assert.equal(result.qualityReview.checks.accuracy, false);
  assert.ok(result.blockingReasons.some((item) => /不可定稿或发送/u.test(item)));
  assert.ok(result.blockingReasons.some((item) => /硬问题/u.test(item)));
  assert.ok(result.draft.length > 0, 'the rejected stage output remains available to the editor');
});

test('v2 regeneration still fails closed when review finds a hard factual defect', async () => {
  const payload = requestPayload({
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '作者原稿。',
    currentDraft: '作者原稿。',
    versionId: 'v1:author-draft',
    annotations: [{
      id: 'hard-fact-check',
      kind: '事实核对',
      note: '核对事实边界，不要改变未经授权的信息。',
      quote: '',
      resolved: false,
      remember: false,
    }],
  });
  await assert.rejects(
    () => runPipeline(payload, {
      runner: async (_prompt, context) => {
        const value = responseFor(payload);
        value.draft = '作者原稿。';
        if (context.stage === 'quality_review') {
          value.qualityReview.passed = false;
          value.qualityReview.issues = ['事实边界冲突'];
          value.qualityReview.checks.accuracy = false;
          value.qualityReview.editorialScore = scoreMinusOne('factualBoundaries');
        }
        return value;
      },
    }),
    (error) => error?.code === 'review_failed',
  );
});

test('an initial run ignores model-invented receipts when the server knows there are no annotations', async () => {
  const payload = requestPayload();
  const result = await runPipeline(payload, {
    runner: async () => ({
      ...responseFor(payload),
      receipts: [{ id: 'invented', status: 'applied', message: '模型擅自生成的回执。' }],
    }),
  });
  assert.deepEqual(result.receipts, []);
});

test('grouped anti-template checks distinguish professional examples from synthetic patterns', () => {
  assert.deepEqual(scanDraftForQuality('一、边界\n二、证据\n三、动作\n构建事件主键后再核对时间窗口。'), []);
  assert.ok(scanDraftForQuality('不仅要看结果，更要核对分母。\n不仅要看趋势，更要保留原始记录。').includes('不仅更句式重复'));
  assert.ok(scanDraftForQuality('当然可以，以下是方案。希望这篇文章对你有帮助。').includes('聊天机器人残留'));
  assert.ok(scanDraftForQuality('本文将先讲背景，再带你理解判断方法。').includes('预告式开场'));
  assert.ok(scanDraftForQuality('希望本文有所收获。').includes('万能正能量结尾'));
  assert.ok(!scanDraftForQuality('构建事件主键，记录系统边界。').includes('空泛管理词重复'));
  assert.ok(scanDraftForQuality('赋能协同落地，形成闭环体系，提升能力。').includes('空泛管理词重复'));
  assert.ok(!scanDraftForQuality('业内人士表示，单个指标还需结合现场记录。').includes('宣传腔多项共现'));
  assert.ok(scanDraftForQuality('行业领先、革命性升级，保证提升效率。').includes('宣传腔多项共现'));
});

test('unknown writer/reviewer model IDs are rejected at the request boundary', () => {
  assert.throws(() => requestPayload({ writerModel: 'not-a-profile' }), /受支持的模型配置/);
  assert.throws(() => requestPayload({ reviewerModel: 'not-a-profile' }), /受支持的模型配置/);
});

test('model catalog route runs an explicit Ollama probe and reports probe depth', async () => {
  let probed = false;
  const profiles = (ready, qwenProbeLevel = ready ? 'content_smoke' : 'installed') => [
    { id: 'codex-sol', label: 'Codex · sol', provider: 'codex-cli', model: 'gpt-5.6-sol', free: false, requiresAuth: true, ready: true, reason: 'ready', probeLevel: 'cli_auth' },
    { id: 'codex-terra', label: 'Codex · terra', provider: 'codex-cli', model: 'gpt-5.6-terra', free: false, requiresAuth: true, ready: true, reason: 'ready', probeLevel: 'cli_auth' },
    { id: 'codex-luna', label: 'Codex · luna', provider: 'codex-cli', model: 'gpt-5.6-luna', free: false, requiresAuth: true, ready: true, reason: 'ready', probeLevel: 'cli_auth' },
    { id: 'ollama-qwen3-8b', label: 'qwen3:8b', provider: 'ollama', model: 'qwen3:8b', free: true, requiresAuth: false, ready, reason: ready ? 'content_smoke_ready' : qwenProbeLevel === 'minimal_schema' ? 'minimal_schema_ready' : 'installed_not_probed', probeLevel: qwenProbeLevel },
  ];
  await withServer({
    statusProvider: async () => ({ ok: true, cliAvailable: true, execReady: true, authenticated: true }),
    modelProbe: async () => { probed = true; },
    modelReadinessProvider: async () => ({
      schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
      defaultWriterModel: 'codex-sol',
      defaultReviewerModel: 'codex-sol',
      // The injected provider mirrors the server's post-probe contract: a
      // minimal schema probe remains disabled until a real content smoke.
      profiles: profiles(false, 'minimal_schema'),
    }),
  }, async (port) => {
    const before = await httpJson(port, '/v1/models');
    assert.equal(before.status, 200);
    assert.equal(before.body.profiles.find((item) => item.id === 'ollama-qwen3-8b').ready, false);
    const after = await httpJson(port, '/v1/models?probe=ollama-qwen3-8b');
    assert.equal(after.status, 200);
    assert.equal(probed, true);
    const qwen = after.body.profiles.find((item) => item.id === 'ollama-qwen3-8b');
    // A minimal provider/schema probe is deliberately not enough to unlock
    // long-form writing; only a real /v1/content smoke receipt can do that.
    assert.equal(qwen.ready, false);
    assert.equal(qwen.probeLevel, 'minimal_schema');
    assert.equal(qwen.reason, 'minimal_schema_ready');
  });
});

test('v31 finalize fails closed without the frozen dual-review receipt', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-v31-finalize-'));
  try {
    const store = createContentStore({ directory });
    const payload = requestPayload({ dualReview: true });
    const draft = responseFor(payload);
    const missingAudit = await store.create({
      result: draft,
      payload,
      documentId: 'v31-missing-audit',
      revisionId: 'v31-rev-missing',
    });
    await assert.rejects(
      () => store.finalizeText({
        documentId: missingAudit.documentId,
        revisionId: missingAudit.latestRevisionId,
        contentHash: missingAudit.latestContentHash,
      }),
      (error) => error?.code === 'review_required',
    );
    assert.equal((await store.get(missingAudit.documentId)).approvedTextSnapshot, null);

    const valid = responseFor(payload);
    const hash = contentHash(valid.draft);
    valid.reviewAudit = {
      schemaVersion: 'content-desk.review-audit.v1',
      required: true,
      frozen: true,
      exactMatch: true,
      conservativeScore: 100,
      reviewers: [1, 2].map((pass) => ({ pass, model: 'test-model', score: 100, draftHash: hash })),
    };
    valid.workflowReceipt = buildWorkflowReceipt(payload, valid);
    const approved = await store.create({
      result: valid,
      payload,
      documentId: 'v31-valid-audit',
      revisionId: 'v31-rev-valid',
    });
    const finalized = await store.finalizeText({
      documentId: approved.documentId,
      revisionId: approved.latestRevisionId,
      contentHash: approved.latestContentHash,
    });
    assert.equal(finalized.approvedTextSnapshot.finalization, 'bridge');
    assert.equal(finalized.revisions[0].reviewAudit.exactMatch, true);
    assert.equal(finalized.revisions[0].workflowReceipt.reviewAudit.exactMatch, true);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Codex model arguments are explicit for writer and Ollama reviewer profiles', () => {
  const writer = buildCodexExecArgs({ outputSchema: 'schema.json', outputPath: 'out.json', model: 'gpt-5.6-sol', provider: 'codex-cli' });
  assert.deepEqual(writer.slice(0, 5), ['-c', 'approval_policy=never', '-m', 'gpt-5.6-sol', 'exec']);
  const reviewer = buildCodexExecArgs({ outputSchema: 'schema.json', outputPath: 'out.json', model: 'qwen3:8b', provider: 'ollama' });
  assert.ok(reviewer.includes('--oss'));
  assert.ok(reviewer.includes('--local-provider'));
  assert.ok(reviewer.includes('ollama'));
  assert.ok(reviewer.includes('model_reasoning_effort="none"'));
  assert.ok(reviewer.includes('-m'));
  assert.ok(reviewer.includes('qwen3:8b'));
});
