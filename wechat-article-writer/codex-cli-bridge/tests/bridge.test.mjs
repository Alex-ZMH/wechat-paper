import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer as createHttpServer, request } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BridgeError,
  buildFailureDiagnostics,
  createBridgeServer,
  classifyQualityFlags,
  buildPrompt,
  draftFingerprint,
  EDITORIAL_SCORE_DIMENSIONS,
  EDITORIAL_SCORE_THRESHOLD,
  CODEX_STAGE_TIMEOUTS,
  editorialScoreGateIssues,
  extractAuthorSignals,
  extractQuantitativeLiterals,
  validateDraftInvariants,
  validateAuthorVoiceContinuation,
  validateInitialDraftFacts,
  validateTargetLength,
  validateEditorialScore,
  timeoutForStage,
  scanDraftForQuality,
  summarizeDraftDiff,
  terminateProcessTree,
  runSpawnedCodexProcess,
  runPipeline,
  validateRequestPayload,
  candidatePaths,
  normalizeHealthStatus,
} from '../server.mjs';

function validEditorialScore(total = 100) {
  const dimensions = {
    factualBoundaries: { score: 25, max: 25, reasons: [] },
    specificActionability: { score: 25, max: 25, reasons: [] },
    authorVoiceContinuation: { score: 20, max: 20, reasons: [] },
    antiTemplateVariation: { score: 20, max: 20, reasons: [] },
    mobileClarity: { score: 10, max: 10, reasons: [] },
  };
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
  return {
    total,
    threshold: EDITORIAL_SCORE_THRESHOLD,
    dimensions,
    deductions,
  };
}

function validResponse(mode, payload, { passed = true, score = 100 } = {}) {
  const ids = payload.activeAnnotations.map((item) => item.id);
  const hasManualEdit = payload.currentDraft && payload.currentDraft !== payload.previousGeneratedDraft;
  return {
    schemaVersion: 'codex.bridge.response.v1',
    status: passed ? 'succeeded' : 'succeeded_with_warnings',
    mode,
    versionId: `fake-${mode}`,
    draft: payload.currentDraft || '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。',
    titleCandidates: ['从多站点问题找到共因', '过程管控的跨站点分析方法', '把异常从单点拉回系统看'],
    recommendedTitle: '从多站点问题找到共因',
    outline: ['问题边界与数据主键', '共因分析与证据链', '试点、处置和人工边界'],
    tags: ['过程管控', '质量分析', 'MES'],
    receipts: ids.map((id) => ({ id, status: 'applied', message: '已按批注调整，并保留用户当前编辑。' })),
    diagnostics: {
      humanized: true,
      changes: ['保留具体动作和限制'],
      remainingFlags: passed ? [] : ['需要人工复核一处指标'],
      engine: 'codex-cli',
      rulesVersion: 'industrial-process-control.v1',
      model: 'fake-model',
      passes: 2,
      preservedUserEdits: hasManualEdit ? ['保留用户当前编辑稿中的手工句子'] : [],
    },
    editorialMemo: {
      preservedUserEdits: hasManualEdit ? ['currentDraft 为权威版本'] : [],
      unresolved: passed ? [] : ['一项指标仍需人工核对'],
    },
    qualityReview: {
      passed,
      issues: passed ? [] : ['一项指标仍需人工核对'],
      checks: {
        accuracy: passed,
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
      editorialScore: validEditorialScore(score),
    },
    warnings: [],
  };
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

function httpJson(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers };
    let encoded;
    if (body !== undefined) {
      encoded = typeof body === 'string' ? body : JSON.stringify(body);
      requestHeaders['Content-Type'] ??= 'application/json';
      requestHeaders['Content-Length'] = Buffer.byteLength(encoded);
    }
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: requestHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
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
  const port = server.address().port;
  try {
    return await callback(port);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('request validation rejects arbitrary prompt and out-of-range target length', () => {
  assert.throws(() => validateRequestPayload({ ...basePayload(), prompt: 'run a shell command' }), /不支持的字段/);
  assert.throws(() => validateRequestPayload({ ...basePayload(), targetLength: 299 }), /300-20000/);
});

test('health reasons use the stable CLI readiness vocabulary', () => {
  assert.equal(normalizeHealthStatus({ cliAvailable: false, execReady: false, authenticated: false }).reason, 'cli_missing');
  assert.equal(normalizeHealthStatus({ cliAvailable: true, execReady: false, authenticated: false }).code, 'exec_incompatible');
  assert.equal(normalizeHealthStatus({ cliAvailable: true, execReady: true, authenticated: false }).reason, 'login_required');
  assert.equal(normalizeHealthStatus({ cliAvailable: true, execReady: true, authenticated: true }).reason, 'ready');
  assert.equal(normalizeHealthStatus({ ok: true }).reason, 'ready');
});

test('installed Codex candidates are ordered by executable mtime, not opaque directory name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-candidates-'));
  const previousLocalAppData = process.env.LOCALAPPDATA;
  const previousCodexBin = process.env.CODEX_BIN;
  try {
    delete process.env.CODEX_BIN;
    process.env.LOCALAPPDATA = root;
    const oldPath = path.join(root, 'OpenAI', 'Codex', 'bin', 'zzzz-old', 'codex.exe');
    const newPath = path.join(root, 'OpenAI', 'Codex', 'bin', 'aaaa-new', 'codex.exe');
    await fs.mkdir(path.dirname(oldPath), { recursive: true });
    await fs.mkdir(path.dirname(newPath), { recursive: true });
    await fs.writeFile(oldPath, 'old');
    await fs.writeFile(newPath, 'new');
    const now = Date.now() / 1000;
    await fs.utimes(oldPath, now - 120, now - 120);
    await fs.utimes(newPath, now, now);
    const paths = await candidatePaths();
    assert.ok(paths.indexOf(newPath) >= 0);
    assert.ok(paths.indexOf(oldPath) >= 0);
    assert.ok(paths.indexOf(newPath) < paths.indexOf(oldPath));
  } finally {
    if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = previousLocalAppData;
    if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousCodexBin;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('v2 source_rewrite accepts an external draft without annotations and requires that draft', () => {
  const external = {
    schemaVersion: 'content-desk.request.v2',
    task: { kind: 'rewrite', domain: 'general', genre: 'analysis', channel: 'wechat', purpose: 'clarify' },
    mode: 'source_rewrite',
    brief: { topic: '把外部原稿改得更清楚', audience: '知识创作者', format: '分析文章', tone: '克制', targetLength: '900', materials: '' },
    previousGeneratedDraft: '外部原稿中的原始判断。',
    currentDraft: '外部原稿中的原始判断，含 37% 基线。',
    referenceText: '只学习段落节奏，不提供事实。',
    protectedFacts: ['37%'],
    targetLength: 900,
  };
  const payload = validateRequestPayload(external);
  assert.equal(payload.contractVersion, 'v2');
  assert.equal(payload.mode, 'source_rewrite');
  assert.deepEqual(payload.activeAnnotations, []);
  assert.match(buildPrompt(payload, 'writing'), /外部原稿.*权威底稿/s);
  assert.match(buildPrompt(payload, 'writing'), /referenceText 只用于学习表达/s);
  assert.deepEqual(validateDraftInvariants(payload, '改写后的判断，含 37% 基线。'), []);
  assert.match(validateDraftInvariants(payload, '改写后的判断，含 40% 基线。').join('\n'), /37%|40%/);
  assert.throws(
    () => validateRequestPayload({ ...external, currentDraft: '' }),
    /外部原稿重写需要 currentDraft/,
  );
  assert.throws(
    () => validateRequestPayload({ ...basePayload({ mode: 'source_rewrite', currentDraft: '外部原稿。' }) }),
    /仅支持 content-desk.request.v2/,
  );
});

test('editorial score is an explainable five-dimension rubric with a hard 99 gate', () => {
  const passing = validEditorialScore(99);
  assert.equal(passing.total, 99);
  assert.deepEqual(validateEditorialScore(passing), passing);
  assert.deepEqual(editorialScoreGateIssues(passing), []);
  const failing = validEditorialScore(98);
  assert.deepEqual(editorialScoreGateIssues(failing), ['编辑评分 98/100，低于 99 分提交门禁']);
  assert.throws(() => validateEditorialScore({
    ...passing,
    total: 96,
  }), /total 与分项分数不一致/);
  assert.throws(() => validateEditorialScore({
    ...passing,
    dimensions: {
      ...passing.dimensions,
      mobileClarity: { ...passing.dimensions.mobileClarity, score: 11, max: 10, reasons: ['超出满分'] },
    },
  }), /mobileClarity\.score 超出范围/);
  assert.throws(() => validateEditorialScore({
    ...passing,
    deductions: [{ dimension: 'factualBoundaries', points: 2, reason: '算术错误' }],
  }), /deductions 与总分不一致/);
});

test('annotation anchor and versionId must match the submitted currentDraft', () => {
  const valid = basePayload({
    mode: 'annotation_regeneration',
    previousGeneratedDraft: 'abcdef',
    currentDraft: 'abcdef',
    versionId: `v2:${draftFingerprint('abcdef')}`,
    annotations: [{
      id: 'a1', kind: '事实', note: '核对选区', quote: 'bc',
      anchor: { start: 1, end: 3, before: 'a', after: 'def' },
    }],
  });
  assert.equal(validateRequestPayload(valid).activeAnnotations[0].quote, 'bc');
  assert.throws(() => validateRequestPayload({ ...valid, versionId: 'v2:d00000000' }), /versionId/);
  assert.throws(() => validateRequestPayload({ ...valid, annotations: [{ ...valid.annotations[0], quote: 'zz' }] }), /选区/);
});

test('draft diff identifies current user edits without exposing hidden data', () => {
  const summary = summarizeDraftDiff('旧段落\n保留句', '用户改写段落\n保留句');
  assert.equal(summary.manualEditsDetected, true);
  assert.deepEqual(summary.added, ['用户改写段落']);
  assert.deepEqual(summary.removed, ['旧段落']);
  assert.match(summary.instruction, /currentDraft/);
});

test('draft diff keeps a bounded multi-hunk edit ledger beyond the old 12-line cap', () => {
  const before = Array.from({ length: 20 }, (_, index) => `旧句${index} 保留模板`).join('\n');
  const after = Array.from({ length: 20 }, (_, index) => index % 2 === 0 ? `新句${index} 作者判断${index}` : `旧句${index} 保留模板`).join('\n');
  const summary = summarizeDraftDiff(before, after);
  assert.equal(summary.added.length, 10);
  assert.equal(summary.editLedger.length, 10);
  assert.ok(summary.editLedger.every((hunk) => Number.isInteger(hunk.startLine) && Array.isArray(hunk.addedUniqueFragments)));
  assert.ok(summary.editLedger.some((hunk) => hunk.addedHashes.length > 0));
});

test('Windows timeout termination targets only the exact spawned PID tree', () => {
  const calls = [];
  const child = { pid: 4312, kill: () => calls.push(['child.kill']) };
  const spawned = terminateProcessTree(child, {
    platform: 'win32',
    spawnProcess: (...args) => {
      calls.push(args);
      return { unref() {} };
    },
  });
  assert.equal(spawned, true);
  assert.deepEqual(calls[0].slice(0, 2), ['taskkill.exe', ['/PID', '4312', '/T', '/F']]);
  assert.deepEqual(calls[1], ['child.kill']);
  assert.equal(terminateProcessTree({ pid: 'not-a-pid', kill() {} }, { platform: 'win32' }), false);
});

test('Codex model stages intentionally have no wall-clock timeout', () => {
  assert.equal(CODEX_STAGE_TIMEOUTS.writing, undefined);
  assert.equal(CODEX_STAGE_TIMEOUTS.quality_review, undefined);
  assert.equal(CODEX_STAGE_TIMEOUTS.dna_distill, undefined);
  assert.equal(timeoutForStage('writing'), undefined);
  assert.equal(timeoutForStage('quality_review', 5000), undefined);
  assert.equal(timeoutForStage('dna_distill', 5000), undefined);
});

test('early Codex exit and stdin EPIPE reject once while the bridge remains healthy', async () => {
  const child = new EventEmitter();
  child.pid = 54321;
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    queueMicrotask(() => {
      child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' }));
      child.emit('error', Object.assign(new Error('closed'), { code: 'EPIPE' }));
      child.emit('close', 1);
    });
  };
  await assert.rejects(
    runSpawnedCodexProcess('fake-codex.exe', [], 'safe prompt', {
      stage: 'writing',
      spawnProcess: () => child,
      terminate: () => true,
      timeoutMs: 50,
    }),
    (error) => error?.code === 'cli_failed' && error?.stage === 'writing',
  );
  await withServer({
    statusProvider: async () => ({ ok: true, bridgeVersion: 'codex-bridge.v29-20260901', engine: 'codex-cli', cliAvailable: true, execReady: true, authenticated: true }),
  }, async (port) => {
    const health = await httpJson(port, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.busy, false);
  });
});

test('Codex process exposes only bounded schema diagnostics and never raw stderr', async () => {
  const child = new EventEmitter();
  child.pid = 54323;
  child.stdin = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.end = () => {
    child.stderr.emit('data', 'user secret must-not-leak\n');
    child.stderr.emit('data', '{"error":{"code":"invalid_json_schema","message":"uniqueItems is not permitted"}}');
    queueMicrotask(() => child.emit('close', 1));
  };
  await assert.rejects(
    runSpawnedCodexProcess('fake-codex.exe', [], 'safe prompt', {
      stage: 'writing_continuation',
      spawnProcess: () => child,
    }),
    (error) => {
      assert.equal(error.code, 'cli_failed');
      assert.equal(error.stage, 'writing_continuation');
      assert.equal(error.details.exitCode, 1);
      assert.equal(error.details.cliErrorCode, 'invalid_json_schema');
      assert.equal(error.details.cliMessage, 'uniqueItems is not permitted');
      assert.equal(JSON.stringify(error.details).includes('must-not-leak'), false);
      return true;
    },
  );
});

test('model subprocess remains alive beyond legacy timeout argument', async () => {
  const child = new EventEmitter();
  child.pid = 54322;
  child.stdin = new EventEmitter();
  let terminateCalls = 0;
  child.stdin.end = () => setTimeout(() => child.emit('close', 0), 25);
  const result = await runSpawnedCodexProcess('fake-codex.exe', [], 'safe prompt', {
    stage: 'writing',
    spawnProcess: () => child,
    timeoutMs: 5,
    terminate: () => { terminateCalls += 1; return true; },
  });
  assert.equal(result, 0);
  assert.equal(terminateCalls, 0);
});

test('evidence authorization is scoped to the annotated fact, not a global switch', () => {
  const payload = {
    mode: 'annotation_regeneration',
    currentDraft: '指标为37%，报价为8万元。',
    previousGeneratedDraft: '指标为37%，报价为8万元。',
    protectedFacts: [],
    activeAnnotations: [{
      id: 'a1',
      kind: '事实核对',
      note: '新增证据：40%，替换事实',
      quote: '37%',
      anchor: undefined,
    }],
  };
  assert.deepEqual(extractQuantitativeLiterals(payload.currentDraft), ['37%', '8万元']);
  assert.deepEqual(validateDraftInvariants(payload, '指标为40%，报价为8万元。'), []);
  assert.match(validateDraftInvariants(payload, '指标为40%。').join('\n'), /8万元/);
  const unscoped = { ...payload, activeAnnotations: [{ id: 'a2', kind: '事实核对', note: '新增证据', quote: '' }] };
  assert.match(validateDraftInvariants(unscoped, '指标为37%，报价为8万元，提升了40%。').join('\n'), /40%/);
});

test('negated evidence and fact-change instructions never authorize additions or edits', () => {
  const payload = {
    mode: 'annotation_regeneration',
    currentDraft: '指标37%。',
    previousGeneratedDraft: '指标37%。',
    protectedFacts: [],
    activeAnnotations: [{
      id: 'deny-add',
      kind: '事实核对',
      note: '没有新证据：40%，请不要添加数字，也不要修改数字。',
      quote: '',
      anchor: undefined,
    }],
  };
  assert.match(validateDraftInvariants(payload, '指标37%，新增40%。').join('\n'), /40%/);
  assert.match(validateDraftInvariants(payload, '指标40%。').join('\n'), /37%/);
});

test('one annotation cannot leak positive authorization into a later denied fact', () => {
  const payload = {
    mode: 'annotation_regeneration',
    currentDraft: '基线20%。',
    previousGeneratedDraft: '基线20%。',
    protectedFacts: [],
    activeAnnotations: [{
      id: 'mixed-scope',
      kind: '事实核对',
      note: '补充数据：37%。没有新证据支持40%。',
      quote: '',
      anchor: undefined,
    }],
  };
  const issues = validateDraftInvariants(payload, '基线20%，补充37%和40%。').join('\n');
  assert.match(issues, /40%/);
  assert.doesNotMatch(issues, /37%/);

  const listed = {
    ...payload,
    activeAnnotations: [{ ...payload.activeAnnotations[0], note: '补充数据：37%；40%。' }],
  };
  assert.deepEqual(validateDraftInvariants(listed, '基线20%，补充37%和40%。'), []);

  const deniedInSemicolon = {
    ...payload,
    activeAnnotations: [{ ...payload.activeAnnotations[0], note: '补充数据：37%；不要添加40%。' }],
  };
  const semicolonIssues = validateDraftInvariants(deniedInSemicolon, '基线20%，补充37%和40%。').join('\n');
  assert.match(semicolonIssues, /40%/);
  assert.doesNotMatch(semicolonIssues, /37%/);

  const changes = {
    ...payload,
    currentDraft: '甲为37%，乙为40%。',
    previousGeneratedDraft: '甲为37%，乙为40%。',
    activeAnnotations: [{ ...payload.activeAnnotations[0], note: '修改事实：37%。不要修改40%。' }],
  };
  const changeIssues = validateDraftInvariants(changes, '甲待复核，乙待复核。').join('\n');
  assert.match(changeIssues, /40%/);
  assert.doesNotMatch(changeIssues, /37%/);

  const changeDeniedInSemicolon = {
    ...changes,
    activeAnnotations: [{ ...changes.activeAnnotations[0], note: '修改事实：37%；不要修改40%。' }],
  };
  const semicolonChangeIssues = validateDraftInvariants(changeDeniedInSemicolon, '甲待复核，乙待复核。').join('\n');
  assert.match(semicolonChangeIssues, /40%/);
  assert.doesNotMatch(semicolonChangeIssues, /37%/);
});

test('industrial quantities and full-width typography are guarded consistently', () => {
  assert.deepEqual(
    extractQuantitativeLiterals('新增178 A、220 V、35 ℃、0.8 MPa、5 秒、3000 rpm、64 GB、40％、三台、5 mm、12 h').sort(),
    ['178A', '220V', '35℃', '0.8MPa', '5秒', '3000rpm', '64GB', '40%', '三台', '5mm', '12h'].sort(),
  );
  const payload = {
    mode: 'annotation_regeneration',
    currentDraft: '指标37%。',
    previousGeneratedDraft: '指标37%。',
    protectedFacts: [],
    activeAnnotations: [],
  };
  assert.deepEqual(validateDraftInvariants(payload, '指标37 %。'), []);
  const hours = { ...payload, currentDraft: '持续12 h。', previousGeneratedDraft: '持续12 h。' };
  assert.deepEqual(validateDraftInvariants(hours, '持续12h。'), []);
  assert.match(validateDraftInvariants(payload, '指标37%，电流178 A。').join('\n'), /178A/);
});

test('indefinite Chinese classifiers do not masquerade as invented quantitative facts', () => {
  const payload = basePayload({ mode: 'initial_generation' });
  const prose = '先定义一个问题，再核对一条线索，最后形成一套方法。';
  assert.deepEqual(extractQuantitativeLiterals(prose), []);
  assert.deepEqual(validateInitialDraftFacts(payload, prose), []);
  assert.deepEqual(
    extractQuantitativeLiterals('一台设备、一条产线和一套服务器需要分别验收。').sort(),
    ['一台', '一条', '一套'].sort(),
  );
  assert.deepEqual(extractQuantitativeLiterals('1 条报警和一次停机仍是量化事实。').sort(), ['1条', '一次'].sort());
  assert.deepEqual(extractQuantitativeLiterals('建议先做一次数据对齐，再进行一次人工复核。'), []);
  assert.deepEqual(extractQuantitativeLiterals('需要完成一次检查，然后做一次原因回溯。'), []);
  assert.deepEqual(extractQuantitativeLiterals('现场发生一次停机并出现一次故障。').sort(), ['一次'].sort());
  assert.deepEqual(extractQuantitativeLiterals('从两个层面筛出一批候选，再形成两个判断。'), []);
  assert.deepEqual(
    extractQuantitativeLiterals('两台设备、一批样品和两个反应器仍是具体数量。').sort(),
    ['两台', '一批', '两个'].sort(),
  );
  assert.deepEqual(extractQuantitativeLiterals('两个元素处在同一节点，结论分成三个层级；不要只报最好的一次。'), []);
  assert.deepEqual(extractQuantitativeLiterals('同一批样品要沿用记录，每一批都应保留谱图。'), []);
  assert.deepEqual(extractQuantitativeLiterals('现场发生两次停机、三个故障并发现三条裂纹。').sort(), ['两次', '三个', '三条'].sort());
});

test('standalone accelerator models are preserved and cannot be invented', () => {
  const initial = basePayload({
    mode: 'initial_generation',
    protectedFacts: ['H100'],
    brief: { ...basePayload().brief, topic: 'H100 服务器适配 VASP 的边界', materials: '' },
  });
  assert.match(validateInitialDraftFacts(initial, '只讨论服务器适配边界。').join('\n'), /H100/);
  assert.deepEqual(validateInitialDraftFacts(initial, 'H100 服务器只讨论适配边界。'), []);
  assert.match(validateInitialDraftFacts(basePayload({ mode: 'initial_generation' }), '推荐 H100 服务器。').join('\n'), /H100/);
  for (const model of ['B300', 'GB200', 'GH200', 'NVL72', 'Xeon 8592+']) {
    assert.match(validateInitialDraftFacts(basePayload({ mode: 'initial_generation' }), `推荐 ${model} 服务器。`).join('\n'), new RegExp(model.replace('+', '\\+')));
  }
});

test('explicit deletion of criticized quoted text does not unprotect equipment facts', () => {
  const payload = {
    mode: 'annotation_regeneration',
    currentDraft: 'M-04 和 M-07 在 02:15 使用 T-827。原稿声称“系统精准定位根因并彻底避免再次发生”。',
    previousGeneratedDraft: 'M-04 和 M-07 在 02:15 使用 T-827。原稿声称“系统精准定位根因并彻底避免再次发生”。',
    protectedFacts: ['M-04', 'M-07', '02:15', 'T-827', '“系统精准定位根因并彻底避免再次发生”'],
    activeAnnotations: [{
      id: 'remove-hype',
      kind: '表达调整',
      note: '删除“精准定位根因”和“彻底避免再次发生”；设备编号、时间和批次必须保留。',
      quote: '',
      anchor: undefined,
    }],
  };
  assert.deepEqual(validateDraftInvariants(payload, 'M-04 和 M-07 在 02:15 使用 T-827。现有记录不能证明共同根因。'), []);
  assert.match(validateDraftInvariants(payload, 'M-04 和 M-07 在 02:15。现有记录不能证明共同根因。').join('\n'), /T-827/);

  const keepQuoted = {
    ...payload,
    activeAnnotations: [{ ...payload.activeAnnotations[0], note: '不要删除“精准定位根因”，只解释它为什么证据不足。' }],
  };
  assert.match(validateDraftInvariants(keepQuoted, 'M-04 和 M-07 在 02:15 使用 T-827。').join('\n'), /受保护事实/);
  assert.match(buildPrompt({ ...basePayload({ mode: 'annotation_regeneration' }), ...payload }, 'writing'), /点名该引语或其中至少四个连续字符/);
});

test('manual edit guard protects key phrases instead of requiring a whole rewritten line', () => {
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '旧段落。',
    currentDraft: '作者新增了一段很长的现场判断：先核对测量系统，再看批次和版本差异。',
    protectedFacts: [],
    activeAnnotations: [],
  };
  const signals = extractAuthorSignals(payload.currentDraft);
  assert.ok(signals.some((signal) => /测量系统|版本差异/u.test(signal)));
  assert.deepEqual(
    validateDraftInvariants(payload, '改写后的段落保留测量系统和版本差异，再补充验证动作。'),
    [],
  );
});

test('adding a sentence before an existing paragraph is not misclassified as deleting the paragraph', () => {
  const original = '当多个工序同时出现良率波动，先核对共同输入，再安排验证。';
  const current = `先别急着给每个工序分别派单。${original}`;
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: original,
    currentDraft: current,
    protectedFacts: [],
    activeAnnotations: [],
  };
  assert.deepEqual(validateDraftInvariants(payload, current), []);
  assert.match(
    validateDraftInvariants(payload, original).join('\n'),
    /新增关键片段/,
    'the inserted author sentence must still be protected',
  );
});

test('annotating one phrase does not exempt unannotated author text, and deletions do not reflow', () => {
  const annotated = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '旧段落。',
    currentDraft: '作者新增关键观点。待改句。',
    protectedFacts: [],
    activeAnnotations: [{ id: 'a1', kind: '改写', note: '改写选区', quote: '待改句' }],
  };
  assert.match(validateDraftInvariants(annotated, '待改句。').join('\n'), /新增|关键|作者/);
  const deleted = {
    ...annotated,
    previousGeneratedDraft: '保留句。用户明确删除的普通句。',
    currentDraft: '保留句。',
    activeAnnotations: [],
  };
  assert.match(validateDraftInvariants(deleted, '保留句。用户明确删除的普通句。').join('\n'), /删除/);
  assert.equal(summarizeDraftDiff('段落', '段落 ').manualEditsDetected, true);
});

test('a preserve annotation cannot exempt loss of the author manual edit it names', () => {
  const preserve = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '旧段落。',
    currentDraft: '作者新增关键观点。',
    protectedFacts: [],
    activeAnnotations: [{
      id: 'keep-exact',
      kind: '表达调整',
      note: '这句话必须逐字保留：作者新增关键观点。',
      quote: '',
      anchor: undefined,
    }],
  };
  assert.match(validateDraftInvariants(preserve, '完全删除了作者手改。').join('\n'), /新增关键片段/);

  const rewrite = {
    ...preserve,
    activeAnnotations: [{ ...preserve.activeAnnotations[0], note: '改写这句话：作者新增关键观点。' }],
  };
  assert.deepEqual(validateDraftInvariants(rewrite, '作者换了一种表达。'), []);

  const deleted = {
    ...preserve,
    previousGeneratedDraft: '保留句。用户删除的旧模板句。',
    currentDraft: '保留句。',
    activeAnnotations: [{ ...preserve.activeAnnotations[0], note: '不要写回用户删除的旧模板句。' }],
  };
  assert.match(validateDraftInvariants(deleted, '保留句。用户删除的旧模板句。').join('\n'), /写回/);
});

test('replacement and deleted template fragments stay out of regenerated drafts', () => {
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '在这个快节奏的时代，我们必须全面提升效率。',
    currentDraft: '先核对事件主键和测量系统，再安排人工复核。',
    protectedFacts: [],
    activeAnnotations: [],
  };
  assert.match(validateDraftInvariants(payload, '在这个快节奏的时代，我们必须全面提升效率。\n先核对事件主键和测量系统。').join('\n'), /删除/);
});

test('initial generation blocks invented quantitative facts while allowing quality standard markers', () => {
  const payload = basePayload({ mode: 'initial_generation' });
  assert.deepEqual(validateInitialDraftFacts(payload, '按 8D 的 D2-D4 分析，并与 PFMEA、CAPA 衔接。'), []);
  assert.match(validateInitialDraftFacts(payload, '过程良率提升37%，连续运行12小时。').join('\n'), /37%/);
});

test('initial generation rejects silent loss of user-protected material facts', () => {
  const payload = basePayload({
    mode: 'initial_generation',
    protectedFacts: ['RW-03', 'AL-240827-B', '178'],
    brief: {
      ...basePayload().brief,
      materials: '产线 RW-03，批次 AL-240827-B，设定值178 A。',
    },
  });
  assert.match(validateInitialDraftFacts(payload, 'RW-03 当前只作为待核实线索。').join('\n'), /AL-240827-B/);
  assert.deepEqual(validateInitialDraftFacts(payload, 'RW-03、AL-240827-B 与178 A均为待核实线索。'), []);
});

test('initial generation also blocks less-common quantitative units', () => {
  const payload = basePayload({ mode: 'initial_generation' });
  const draft = '效率提高2倍，响应耗时3分钟，覆盖4亿元业务，复核5次，提升2个百分点。';
  const issues = validateInitialDraftFacts(payload, draft).join('\n');
  assert.match(issues, /2倍/);
  assert.match(issues, /3分钟/);
  assert.match(issues, /4亿元/);
  assert.match(issues, /5次/);
  assert.match(issues, /2个百分点/);
  assert.deepEqual(validateInitialDraftFacts(payload, '方案分为2点：先核对数据，再做人工复核。'), []);
});

test('initial generation blocks unprovided Chinese calendar dates', () => {
  const payload = basePayload({ mode: 'initial_generation' });
  const issues = validateInitialDraftFacts(payload, '资料发布于2024年8月26日，复核日期为2024-08-27。').join('\n');
  assert.match(issues, /2024年8月26日/);
  assert.match(issues, /2024-08-27/);
  const sourced = basePayload({
    mode: 'initial_generation',
    brief: {
      ...basePayload().brief,
      materials: '资料截至2024年8月。',
    },
  });
  assert.deepEqual(validateInitialDraftFacts(sourced, '资料截至2024年8月。'), []);
});

test('quality diagnostics distinguish protected fact loss from unauthorized additions', () => {
  assert.deepEqual(classifyQualityFlags(['受保护事实缺失或被改写：37%']), ['protected_fact_missing']);
  assert.deepEqual(classifyQualityFlags(['出现未获批的新数字/日期/链接/型号：40%']), ['unauthorized_literal_added', 'unauthorized_percent']);
  assert.deepEqual(classifyQualityFlags(['出现未获批的新数字/日期/链接/型号：“测量口径”']), ['unauthorized_literal_added']);
  assert.deepEqual(classifyQualityFlags(['出现未获批的新数字/日期/链接/型号：“增长%”']), ['unauthorized_literal_added']);
  assert.deepEqual(classifyQualityFlags(['出现未获批的新数字/日期/链接/型号：“今年”']), ['unauthorized_literal_added']);
  assert.deepEqual(classifyQualityFlags(['出现未获批的新数字/日期/链接/型号：https://example.test']), ['unauthorized_literal_added', 'unauthorized_url']);
  assert.deepEqual(
    classifyQualityFlags(['出现未获批的新数字/日期/链接/型号：40%、https://example.test、2026-08-28、H100']),
    ['unauthorized_literal_added', 'unauthorized_percent', 'unauthorized_url', 'unauthorized_date', 'unauthorized_model_id'],
  );
  assert.deepEqual(classifyQualityFlags(['编辑评分 98/100，低于 99 分提交门禁']), ['editorial_score_gate']);
  assert.deepEqual(classifyQualityFlags(['证据仍需人工补充']), ['server_quality_gate']);
});

test('ordinary quoted evidence labels do not trip the protected-fact gate', () => {
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '原稿。',
    currentDraft: '原稿。',
    protectedFacts: [],
    activeAnnotations: [],
  };
  assert.deepEqual(
    validateDraftInvariants(payload, '原稿。“原始记录—关联规则—分析结果—人工复核”。'),
    [],
  );
  assert.deepEqual(validateDraftInvariants(payload, '原稿。测量口径要先统一。'), []);
  assert.match(
    validateDraftInvariants(payload, '原稿。“本次提升40%”。').join('\n'),
    /40%/,
  );
  assert.match(
    validateDraftInvariants(payload, '原稿。“客户说很好”。').join('\n'),
    /未获批/,
  );
  assert.match(
    validateDraftInvariants(payload, '原稿。“客户说很好—老板说更好—数据证明”。').join('\n'),
    /未获批/,
  );
  assert.match(
    validateDraftInvariants(payload, '原稿。“普通短语—第二段—第三段”。').join('\n'),
    /未获批/,
  );
});

test('standard quality identifiers are not treated as invented quantitative additions', () => {
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '原稿',
    currentDraft: '原稿',
    protectedFacts: [],
    activeAnnotations: [],
  };
  assert.deepEqual(validateDraftInvariants(payload, '原稿，按8D、D2-D4、API 6A衔接。'), []);
});

test('cross-site prompt states measurement baseline and common-cause limits', () => {
  const payload = basePayload();
  const prompt = buildPrompt(validateRequestPayload(payload), 'writing');
  assert.match(prompt, /跨站点共因/);
  assert.match(prompt, /跨站点.*共因|跨站点≠共因/);
  assert.match(prompt, /测量系统/);
  assert.match(prompt, /历史回放.*影子运行.*受控接入/s);
  assert.match(prompt, /authorizedQuantitativeLiterals/);
  assert.match(prompt, /draft 只可使用 input_data\.authorizedQuantitativeLiterals/);
  assert.match(prompt, /targetLengthUpper/);
  assert.match(prompt, /"targetLengthUpper": 1575/);
  const annotationPayload = validateRequestPayload({
    ...payload,
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '原稿。',
    currentDraft: '原稿。',
    annotations: [],
    versionId: `v1:${draftFingerprint('原稿。')}`,
  });
  assert.match(
    buildPrompt(annotationPayload, 'quality_review', validResponse('annotation_regeneration', annotationPayload)),
    /不得新增.*数字、日期、型号、URL、DOI.*中文引号/s,
  );
  assert.match(
    buildPrompt(annotationPayload, 'quality_review', validResponse('annotation_regeneration', annotationPayload)),
    /只有 activeAnnotation 对该具体事实明确授权新增证据时才可加入/,
  );
});

test('server quality gate does not pass a self-reported failed review', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => validResponse(context.payload.mode, context.payload, { passed: context.stage === 'writing' }),
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'review_failed');
  });
});

test('all quality checks and issue list are hard gates when passed is claimed', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      const result = validResponse(context.payload.mode, context.payload);
      if (context.stage === 'quality_review') {
        result.qualityReview.issues = ['遗漏证据边界'];
        result.qualityReview.checks.terminology = false;
      }
      return result;
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'review_failed');
  });
});

test('a reviewer score below 99 rejects without returning a replacement draft', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => validResponse(context.payload.mode, context.payload, {
      score: context.stage === 'quality_review' ? 94 : 100,
    }),
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'review_failed');
    assert.equal(response.body.stage, 'quality_review');
    assert.equal('draft' in response.body, false);
    assert.match(response.body.diagnostics.editorialScore.total.toString(), /^94$/u);
  });
});

test('a deterministic anti-AI hard flag rejects a self-reported perfect score', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      const result = validResponse(context.payload.mode, context.payload, { score: 100 });
      if (context.stage === 'quality_review') {
        result.draft = '在这个快节奏的时代，我亲测这套方案，保证提升效率。';
      }
      return result;
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'review_failed');
    assert.ok(response.body.diagnostics.serverFlagCategories.includes('anti_ai_quality'));
    assert.ok(response.body.diagnostics.serverFlagDetails.includes('空泛模板化开场'));
  });
});

test('observable AI-flavor scan catches fake experience and generic opener', () => {
  const flags = scanDraftForQuality('在这个快节奏的时代，我亲测这套方案，保证提升效率。');
  assert.ok(flags.includes('空泛模板化开场'));
  assert.ok(flags.includes('虚构第一人称经历'));
  assert.ok(flags.includes('夸张或保证式表述'));
});

test('quality scan enforces target cap, plain heading count, and repeated audit template limits', () => {
  const payload = basePayload({ targetLength: 900 });
  assert.match(validateTargetLength(payload, '字'.repeat(1_600)).join('\n'), /目标长度超出/);
  assert.deepEqual(validateTargetLength(payload, '字'.repeat(1_500)), []);
  const fourSections = ['一、边界', '二、数据', '三、动作', '四、验收']
    .map((line) => `${line}\n具体说明该段如何执行。`).join('\n\n');
  assert.ok(!scanDraftForQuality(fourSections).includes('机械序号堆叠'));
  const fiveSections = `${fourSections}\n\n五、复盘\n补充复盘动作。`;
  assert.ok(scanDraftForQuality(fiveSections).includes('机械序号堆叠'));
  const headings = ['问题边界', '数据对象', '分析动作', '处置流程', '试点验收'].map((line) => `${line}\n具体说明该段如何执行。`).join('\n\n');
  assert.ok(scanDraftForQuality(headings).includes('小标题过量'));
  const labels = Array.from({ length: 3 }, () => '支持证据、反证、缺失字段、验证动作、责任人。').join('\n');
  assert.ok(scanDraftForQuality(labels).includes('同构审查模板重复'));
  const repeatedHypotheses = Array.from({ length: 3 }, () => '若条件成立再查记录，反证可以推翻，缺少字段时由负责人补齐。').join('\n');
  assert.ok(scanDraftForQuality(repeatedHypotheses).includes('同构假设句法重复'));
  assert.ok(!scanDraftForQuality('这里不是要求立刻下结论，而是先核对材料。').includes('翻案句式重复'));
  const repeatedReversals = '这里不是要求立刻下结论，而是先核对材料。问题不在信息数量，而在证据是否可追溯。';
  assert.ok(scanDraftForQuality(repeatedReversals).includes('翻案句式重复'));
  assert.ok(scanDraftForQuality('资料截止日期待确认。').includes('审校待确认项误写入正文'));
});

test('long manual edits require author signals to continue beyond the opening', () => {
  const firstEdit = '作者判断先核对测量系统和分母，再看批次版本差异。';
  const secondEdit = '作者判断还要把设备状态和批次关联起来，再安排人工复核。';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: '旧稿。',
    currentDraft: `${firstEdit.repeat(8)}\n${secondEdit}`,
    protectedFacts: [],
    activeAnnotations: [],
  };
  assert.match(validateAuthorVoiceContinuation(payload, `${firstEdit.repeat(2)}\n${'后文完全改成泛泛表述。'.repeat(20)}`).join('\n'), /语气/);
});

test('an imported draft with one appended author sentence does not require repetition', () => {
  const base = '外部文章已经写明事件主键、批次和版本，但没有把分母口径与时间窗口放在一起。'.repeat(5);
  const appended = '我的判断是先把测量系统和分母核对清楚，再讨论是否存在共因。';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: base,
    currentDraft: `${base}\n${appended}`,
    protectedFacts: [],
    activeAnnotations: [{ id: 'global-1', kind: '结构建议', note: '删掉套话，保留作者判断', quote: '' }],
  };
  const regenerated = `${base}\n${appended}\n后文按字段和责任人展开，保留证据缺口。`;
  assert.deepEqual(validateAuthorVoiceContinuation(payload, regenerated), []);
});

test('later manual edit is not hidden by a long opening edit signal budget', () => {
  const previousGeneratedDraft = `${'旧导语只作背景说明。'.repeat(12)}\n${'中段原句用于占位。'.repeat(12)}`;
  const openingEdit = '跨站点多发不等于共同根因；这是一份待补证据的分析方案，不冒充已核验调研。'.repeat(5);
  const laterEdit = '相关性和聚类只能支持分层归因（工位—批次—设备状态），不能确认根因。';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft,
    currentDraft: `${openingEdit}\n${laterEdit}\n${'后续流程说明。'.repeat(20)}`,
    protectedFacts: [],
    activeAnnotations: [],
  };
  const regenerated = `${openingEdit}\n${'数据口径与验证责任说明。'.repeat(12)}\n${laterEdit}\n${'试点验收说明。'.repeat(20)}`;
  assert.deepEqual(validateAuthorVoiceContinuation(payload, regenerated), []);
});

test('continuation scan samples a late clause in one long edited paragraph', () => {
  const openingEdit = '跨站点多发不等于共同根因；待补证据，不冒充已核验调研。'.repeat(4);
  const paragraphPrefix = '问题分散只描述分布，普通因或特殊因才描述变异机制。'.repeat(7);
  const lateClause = '相关性和聚类只能支持分层归因（工位—批次—设备状态）';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: `${'旧导语。'.repeat(30)}\n${'旧段落。'.repeat(50)}`,
    currentDraft: `${openingEdit}\n${paragraphPrefix}${lateClause}，不能确认根因。\n${'后续流程。'.repeat(50)}`,
    protectedFacts: [],
    activeAnnotations: [],
  };
  const regenerated = `${openingEdit}\n${paragraphPrefix}${lateClause}的候选排序，不能确认根因。\n${'后续流程。'.repeat(50)}`;
  assert.deepEqual(validateAuthorVoiceContinuation(payload, regenerated), []);
});

test('manual edit invariant gate catches a later independent edit that is lost', () => {
  const firstEdit = '先保留作者关于测量口径的具体判断 AUTHORFIRST_MARKER。';
  const secondEdit = '再保留作者关于分层归因的具体判断 AUTHORSECOND_MARKER。';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: `${'旧导语。'.repeat(30)}\n旧中段。`,
    currentDraft: `${firstEdit}\n${'过渡内容。'.repeat(30)}\n${secondEdit}`,
    protectedFacts: [],
    activeAnnotations: [],
  };
  const regenerated = `新导语。\n一、正文\n${firstEdit}\n${'后文泛泛表述。'.repeat(40)}`;
  assert.match(validateDraftInvariants(payload, regenerated).join('\n'), /受保护事实缺失|新增关键片段未被保留/);
});

test('selected opening edit may change while a later author edit continues in the body', () => {
  const openingEdit = '跨站点多发不等于共同根因。这是一份待补证据的分析方案。';
  const laterEdit = '相关性和聚类只能支持分层归因（工位—批次—设备状态），不能确认根因。';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: `${'旧导语。'.repeat(30)}\n旧中段。`,
    currentDraft: `${openingEdit}\n${'过程说明。'.repeat(30)}\n${laterEdit}`,
    protectedFacts: [],
    activeAnnotations: [{ quote: openingEdit, note: '改写开头', kind: '表达调整' }],
  };
  const regenerated = `跨站点不自动等于共同根因。\n一、正文\n${'过程说明。'.repeat(20)}\n${laterEdit}`;
  assert.deepEqual(validateAuthorVoiceContinuation(payload, regenerated), []);
});

test('selected quote filtering uses quote text rather than quote plus annotation note', () => {
  const openingEdit = '跨站点多发不等于共同根因。这是一份待补证据的分析方案。';
  const payload = {
    mode: 'annotation_regeneration',
    previousGeneratedDraft: `${'旧导语。'.repeat(30)}\n旧判断。`,
    currentDraft: `${openingEdit}\n我不同意`,
    protectedFacts: [],
    activeAnnotations: [{ quote: openingEdit, note: '请重写这段开头并保持事实边界', kind: '表达调整' }],
  };
  const regenerated = `跨站点分布不能直接推出共同根因。\n一、正文\n后文按证据验证。`;
  assert.deepEqual(validateAuthorVoiceContinuation(payload, regenerated), []);
});

test('health and CORS expose only local CLI metadata', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, bridgeVersion: 'codex-bridge.v29-20260901', engine: 'codex-cli', cliAvailable: true, execReady: true, cliVersion: 'codex-cli test', authenticated: true }),
  }, async (port) => {
    const publicHealth = await httpJson(port, '/health', { headers: { Origin: 'https://gongzhonghao-content-desk.abellmosleynce.chatgpt.site' } });
    assert.equal(publicHealth.status, 403);
    assert.equal(publicHealth.body.code, 'origin_not_allowed');
    const health = await httpJson(port, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.bridgeVersion, 'codex-bridge.v40-20260903');
    assert.equal(health.body.productVersion, '0.40.0');
    assert.equal(health.body.execReady, true);
    assert.equal(health.body.authenticated, true);
    assert.equal(health.body.reason, 'ready');
    assert.equal(health.body.code, 'ready');
    assert.equal(health.body.rediscovered, false);
    assert.equal(health.body.busy, false);
    assert.equal(health.body.stage, 'idle');
    const localHealth = await httpJson(port, '/health', { headers: { Origin: 'http://127.0.0.1:43127' } });
    assert.equal(localHealth.status, 200);
    assert.equal(localHealth.headers['access-control-allow-origin'], 'http://127.0.0.1:43127');
    const preflight = await httpJson(port, '/v1/content', {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:3000', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
    const denied = await httpJson(port, '/health', { headers: { Origin: 'https://attacker.invalid' } });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'origin_not_allowed');
  });
});

test('health reports writing and quality review stages while a request is running', async () => {
  let releaseWriting;
  let releaseReview;
  let writingStartedResolve;
  let reviewStartedResolve;
  const writingStarted = new Promise((resolve) => { writingStartedResolve = resolve; });
  const reviewStarted = new Promise((resolve) => { reviewStartedResolve = resolve; });
  const writingGate = new Promise((resolve) => { releaseWriting = resolve; });
  const reviewGate = new Promise((resolve) => { releaseReview = resolve; });

  await withServer({
    statusProvider: async () => ({ ok: true, bridgeVersion: 'codex-bridge.v29-20260901', engine: 'codex-cli', cliAvailable: true, execReady: true, authenticated: true }),
    runner: async (_prompt, context) => {
      if (context.stage === 'writing') {
        writingStartedResolve();
        await writingGate;
      } else {
        reviewStartedResolve();
        await reviewGate;
      }
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const request = httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    await writingStarted;
    const writingHealth = await httpJson(port, '/health');
    assert.equal(writingHealth.body.busy, true);
    assert.equal(writingHealth.body.stage, 'writing');
    releaseWriting();
    await reviewStarted;
    const reviewHealth = await httpJson(port, '/health');
    assert.equal(reviewHealth.body.busy, true);
    assert.equal(reviewHealth.body.stage, 'quality_review');
    releaseReview();
    assert.equal((await request).status, 200);
    const idleHealth = await httpJson(port, '/health');
    assert.equal(idleHealth.body.stage, 'idle');
  });
});

test('pipeline emits the complete stage sequence', async () => {
  const stages = [];
  const payload = validateRequestPayload(basePayload());
  const result = await runPipeline(payload, {
    onStage: (stage) => stages.push(stage),
    runner: async (_prompt, context) => validResponse(context.payload.mode, context.payload),
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(stages, ['writing', 'quality_review', 'quality_gate']);
});

test('loopback root proxies only to the fixed local studio upstream', async () => {
  const studio = createHttpServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body data-build-marker="CONTENT_DESK_BUILD=v40">${req.url}</body></html>`);
  });
  studio.listen(0, '127.0.0.1');
  await once(studio, 'listening');
  const studioPort = studio.address().port;
  const bridge = createBridgeServer({ port: 0, studioPort, statusProvider: async () => ({ ok: true }) });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const response = await httpJson(bridge.address().port, '/');
  assert.equal(response.status, 200);
  assert.match(response.raw, /<html>/);
  assert.equal(response.headers['x-bridge-build'], 'codex-bridge.v40-20260903');
  const bridgeClosed = once(bridge, 'close');
  const studioClosed = once(studio, 'close');
  bridge.close();
  studio.close();
  await Promise.all([bridgeClosed, studioClosed]);
});

test('initial generation runs writing and independent review with fake Codex', async () => {
  const prompts = [];
  let calls = 0;
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (prompt, context) => {
      calls += 1;
      prompts.push(prompt);
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 200);
    assert.equal(response.body.diagnostics.engine, 'codex-cli');
    assert.equal(response.body.diagnostics.passes, 2);
    assert.equal(response.body.receipts.length, 0);
    assert.equal(calls, 2);
    assert.match(prompts[0], /MES、QMS、SCADA/);
    assert.match(prompts[1], /独立质量复审/);
    assert.equal(JSON.stringify(response.body).includes('run a shell command'), false);
  });
});

test('source_rewrite runs two stages from the external draft without requiring annotation receipts', async () => {
  const prompts = [];
  const external = validateRequestPayload({
    schemaVersion: 'content-desk.request.v2',
    task: { kind: 'rewrite', domain: 'general', genre: 'analysis', channel: 'wechat', purpose: 'clarify' },
    mode: 'source_rewrite',
    brief: { topic: '把外部原稿改得更清楚', audience: '知识创作者', format: '分析文章', tone: '克制', targetLength: '900', materials: '' },
    previousGeneratedDraft: '外部原稿中的原始判断，含 37% 基线。',
    currentDraft: '外部原稿中的原始判断，含 37% 基线。',
    referenceText: '只学习段落节奏。',
    protectedFacts: ['37%'],
    targetLength: 900,
  });
  const result = await runPipeline(external, {
    runner: async (prompt, context) => {
      prompts.push(prompt);
      const response = validResponse(context.payload.mode, context.payload);
      response.draft = '改写后的判断，含 37% 基线。';
      response.receipts = [];
      response.diagnostics.preservedUserEdits = [];
      response.editorialMemo.preservedUserEdits = [];
      response.qualityReview.checks.industrialData = null;
      response.qualityReview.checks.crossSiteReasoning = null;
      response.qualityReview.checks.workflowIntegration = null;
      response.qualityReview.checks.actionAuthority = null;
      response.qualityReview.checks.pilotAcceptance = null;
      response.qualityReview.checks.terminology = null;
      response.diagnostics.rulesVersion = 'nonfiction-editorial.v1';
      return response;
    },
  });
  assert.equal(result.mode, 'source_rewrite');
  assert.equal(result.receipts.length, 0);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /source_rewrite/);
  assert.match(prompts[0], /事实、数字、日期、型号、引文、URL、DOI/);
});

test('same-origin bridge entry accepts a local POST origin', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, execReady: true, authenticated: true }),
    runner: async (_prompt, context) => validResponse(context.payload.mode, context.payload),
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:43127' },
      body: basePayload(),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:43127');
    assert.equal(response.body.diagnostics.engine, 'codex-cli');
  });
});

test('annotation regeneration filters resolved annotations and returns every active receipt', async () => {
  const seen = [];
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (prompt, context) => {
      seen.push({ prompt, ids: context.payload.activeAnnotations.map((item) => item.id) });
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: basePayload({
        mode: 'annotation_regeneration',
        previousGeneratedDraft: '原始稿',
        currentDraft: '用户手改稿，保留这句',
        annotations: [
          { id: 'a1', kind: '事实', note: '补充数据边界', quote: '用户手改稿', resolved: false },
          { id: 'a2', kind: '语气', note: '更具体', quote: '', resolved: true },
        ],
        protectedFacts: ['用户手改稿'],
        versionId: `v1:${draftFingerprint('用户手改稿，保留这句')}`,
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.receipts.map((item) => item.id), ['a1']);
    assert.match(response.body.diagnostics.preservedUserEdits.join('\n'), /用户当前编辑/);
    assert.deepEqual(seen[0].ids, ['a1']);
    assert.match(seen[0].prompt, /用户手改稿/);
  });
});

test('imported draft uses previous=current as the authority and regenerates from an annotation', async () => {
  const imported = '外部文章原稿：先核对测量口径，再由质量负责人安排复核。';
  const payload = basePayload({
    mode: 'annotation_regeneration',
    previousGeneratedDraft: imported,
    currentDraft: imported,
    annotations: [{ id: 'import-a1', kind: '表达调整', note: '把复核动作写得更具体', quote: '安排复核', resolved: false }],
    protectedFacts: [imported],
    versionId: `v1:${draftFingerprint(imported)}`,
  });
  let seen;
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (prompt, context) => {
      seen = { prompt, currentDraft: context.payload.currentDraft, previousGeneratedDraft: context.payload.previousGeneratedDraft };
      const result = validResponse(context.payload.mode, context.payload, { score: 99 });
      result.draft = imported;
      return result;
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: payload });
    assert.equal(response.status, 200);
    assert.equal(response.body.qualityReview.editorialScore.total, 99);
    assert.deepEqual(response.body.receipts.map((item) => item.id), ['import-a1']);
    assert.equal(seen.currentDraft, imported);
    assert.equal(seen.previousGeneratedDraft, imported);
    assert.match(seen.prompt, /annotation_regeneration/);
  });
});

test('review failure never returns a draft', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      if (context.stage === 'quality_review') throw new Error('synthetic review failure');
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 502);
    assert.equal(response.body.code, 'review_failed');
    assert.equal('draft' in response.body, false);
  });
});

test('review retries one recoverable upstream failure and commits only the second valid response', async () => {
  let reviewCalls = 0;
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      if (context.stage === 'quality_review') {
        reviewCalls += 1;
        if (reviewCalls === 1) throw new BridgeError(502, 'invalid_cli_output', 'qualityReview.editorialScore 缺失', 'quality_review');
      }
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 200);
    assert.equal(reviewCalls, 2);
    assert.equal(response.body.draft, '跨站点问题需要按证据分层，先确认事件主键，再做共因分析。');
  });
});

test('two recoverable review failures expose safe upstream diagnostics and never return a draft', async () => {
  const runsPath = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-review-failure-runs-'));
  let reviewCalls = 0;
  await withServer({
    runsPath,
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      if (context.stage === 'quality_review') {
        reviewCalls += 1;
        throw new BridgeError(502, 'invalid_cli_output', '输出包含 secret prompt / tmp\\private\\draft.md', 'quality_review');
      }
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: basePayload({ clientRunId: 'two-review-failures' }),
    });
    assert.equal(response.status, 502);
    assert.equal(reviewCalls, 2);
    assert.equal(response.body.code, 'review_failed');
    assert.equal(response.body.stage, 'quality_review');
    assert.equal('draft' in response.body, false);
    assert.equal(response.body.diagnostics.failure.upstreamCode, 'invalid_cli_output');
    assert.equal(response.body.diagnostics.failure.category, 'output_contract');
    assert.equal(response.body.diagnostics.failure.contractReasonCode, 'output_contract_invalid');
    assert.match(response.body.diagnostics.failure.action, /重试/);
    assert.equal(response.body.diagnostics.failure.details.retryAttempts, 2);
    assert.equal('upstreamMessage' in response.body.diagnostics.failure, false);
    assert.equal(JSON.stringify(response.body).includes('secret prompt'), false);
    assert.equal(JSON.stringify(response.body).includes('private\\draft.md'), false);
    const ledger = await httpJson(port, '/v1/runs/two-review-failures');
    assert.equal(ledger.body.status, 'failed');
    assert.equal(ledger.body.error.diagnostics.failure.upstreamCode, 'invalid_cli_output');
    assert.equal(ledger.body.error.diagnostics.failure.contractReasonCode, 'output_contract_invalid');
    assert.equal(ledger.body.error.diagnostics.failure.details.contractReasonCode, 'output_contract_invalid');
    assert.equal('draft' in ledger.body.error, false);
  });
});

test('failure diagnostics keep quality-gate score shape while removing model prose', () => {
  const score = validEditorialScore(94);
  score.dimensions.factualBoundaries.reasons = ['secret draft excerpt should not leave Bridge'];
  const failure = new BridgeError(502, 'review_failed', '质量门禁未通过', 'quality_review', {
    editorialScore: score,
    serverFlagCategories: ['anti_ai_quality'],
    serverFlagDetails: ['空泛模板化开场'],
  });
  const diagnostics = buildFailureDiagnostics(failure, { stage: 'quality_review' });
  assert.equal(diagnostics.upstreamCode, 'review_failed');
  assert.equal(diagnostics.category, 'quality_gate');
  assert.equal(diagnostics.details.editorialScore.total, 94);
  assert.equal(diagnostics.details.editorialScore.dimensions.factualBoundaries.reasons[0], '该分项未达到满分，需按复审结果人工核对。');
  assert.equal(JSON.stringify(diagnostics).includes('空泛模板化开场'), true);
  assert.equal(JSON.stringify(diagnostics).includes('secret draft excerpt'), false);
});

test('failure diagnostics retain a safe Bridge-owned upstream message', () => {
  const diagnostics = buildFailureDiagnostics(new BridgeError(
    502,
    'invalid_cli_output',
    'qualityReview.editorialScore 缺失',
    'quality_review',
  ), { stage: 'quality_review' });
  assert.equal(diagnostics.upstreamCode, 'invalid_cli_output');
  assert.equal(diagnostics.upstreamMessage, 'qualityReview.editorialScore 缺失');
});

test('failure diagnostics retain only allow-listed mechanical padding reason codes', () => {
  const diagnostics = buildFailureDiagnostics(new BridgeError(
    502,
    'length_target_unmet',
    '最终冻结正文存在机械填充，当前稿未被覆盖',
    'writing',
    { reason: 'low_sentence_prefix_diversity', visibleLength: 18000, raw: '不得泄漏的正文' },
  ));
  assert.equal(diagnostics.details.reason, 'low_sentence_prefix_diversity');
  assert.equal(diagnostics.details.visibleLength, 18000);
  assert.equal(JSON.stringify(diagnostics).includes('不得泄漏的正文'), false);
});

test('failure diagnostics expose a fixed contract reason without echoing model text', () => {
  const diagnostics = buildFailureDiagnostics(new BridgeError(
    502,
    'invalid_cli_output',
    '未达到长文下限的初始 writer 不得提前输出参考文献区，避免续写正文落入参考文献',
    'writing',
  ), { stage: 'writing' });
  assert.equal(diagnostics.contractReasonCode, 'initial_references_before_length_gate');
  assert.match(diagnostics.contractReason, /延后引用再续写/u);
  assert.equal(diagnostics.details.contractReasonCode, 'initial_references_before_length_gate');
  assert.equal(JSON.stringify(diagnostics).includes('落入参考文献'), false);
});

test('HTTP validation failures expose a stable diagnostic stage', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: { ...basePayload(), targetLength: 299 },
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, 'invalid_request');
    assert.equal(response.body.stage, 'validation');
  });
});

test('CLI timeout keeps its public timeout code instead of stage remapping', async () => {
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, execReady: true, authenticated: true }),
    runner: async (_prompt, context) => {
      if (context.stage === 'writing') throw new BridgeError(504, 'cli_timeout', 'internal timeout', 'writing');
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const response = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(response.status, 504);
    assert.equal(response.body.code, 'cli_timeout');
    assert.equal(response.body.stage, 'writing');
    assert.match(response.body.error, /写作超时/);
  });
});

test('busy requests are rejected while the one active run is in progress', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      await gate;
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const first = httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await httpJson(port, '/v1/content', { method: 'POST', body: basePayload() });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'busy');
    assert.equal(second.body.stage, 'writing');
    release();
    const completed = await first;
    assert.equal(completed.status, 200);
  });
});

test('oversized and wrong content type requests fail before Codex', async () => {
  let calls = 0;
  await withServer({
    statusProvider: async () => ({ ok: true, engine: 'codex-cli', cliAvailable: true, authenticated: true }),
    runner: async (_prompt, context) => {
      calls += 1;
      return validResponse(context.payload.mode, context.payload);
    },
  }, async (port) => {
    const wrongType = await httpJson(port, '/v1/content', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } });
    assert.equal(wrongType.status, 415);
    const huge = JSON.stringify({ ...basePayload(), brief: { ...basePayload().brief, materials: 'x'.repeat(530_000) } });
    const tooLarge = await httpJson(port, '/v1/content', { method: 'POST', body: huge });
    assert.equal(tooLarge.status, 413);
    assert.equal(calls, 0);
  });
});
