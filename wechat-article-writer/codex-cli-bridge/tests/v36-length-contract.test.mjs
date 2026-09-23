import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  contentHash,
  createEvidencePacketStore,
  EDITORIAL_SCORE_DIMENSIONS,
  runPipeline,
  targetLengthLower,
  validateRequestPayload,
} from '../server.mjs';
import { canonicalEvidencePacket } from '../../skills/topic-evidence-research/scripts/evidence_packet_validator.mjs';

const TARGET_LENGTH = 20_000;
const TARGET_LENGTH_LOWER = 18_000;

function requestPayload(overrides = {}) {
  return validateRequestPayload({
    schemaVersion: 'content-desk.request.v2',
    task: {
      kind: 'article',
      domain: 'general',
      genre: 'analysis',
      channel: 'wechat',
      purpose: 'explain',
    },
    mode: 'initial_generation',
    brief: {
      topic: '长文长度契约回归测试',
      audience: '知识创作者',
      format: '分析文章',
      tone: '克制',
      materials: '',
    },
    targetLength: TARGET_LENGTH,
    ...overrides,
  });
}

function draftOfLength(length) {
  const alphabet = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  let draft = '';
  let index = 0;
  while (draft.length < length) {
    const varied = Array.from({ length: 18 }, (_, offset) => (
      String.fromCharCode(0x4e00 + ((index * 97 + offset * 41) % 2_000))
    )).join('');
    draft += `${varied}第${alphabet[index % alphabet.length]}段用于测试长度链路，事实边界保持在输入材料内，下一步动作需要人工确认。`;
    index += 1;
  }
  return draft.slice(0, length);
}

function fullEditorialScore() {
  return {
    total: 100,
    threshold: 99,
    dimensions: Object.fromEntries(Object.entries(EDITORIAL_SCORE_DIMENSIONS).map(([key, definition]) => [
      key,
      { score: definition.max, max: definition.max, reasons: [] },
    ])),
    deductions: [],
  };
}

function responseFor(payload, draft) {
  return {
    schemaVersion: 'codex.bridge.response.v1',
    status: 'succeeded',
    mode: payload.mode,
    versionId: 'v36-length-test',
    draft,
    titleCandidates: ['长度契约测试', '让长文达到可审阅下限', '写作阶段的长度边界'],
    recommendedTitle: '长度契约测试',
    outline: ['目标与下限', '扩写阶段', '审核边界'],
    tags: ['长度契约', '写作链路', '回归测试'],
    receipts: [],
    diagnostics: {
      humanized: true,
      changes: [],
      remainingFlags: [],
      engine: 'codex-cli',
      rulesVersion: 'nonfiction-editorial.v1',
      model: 'v36-test-model',
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
        industrialData: null,
        crossSiteReasoning: null,
        workflowIntegration: null,
        actionAuthority: null,
        pilotAcceptance: null,
        terminology: null,
      },
      editorialScore: fullEditorialScore(),
    },
    warnings: [],
  };
}

test('20,000 字任务连续返回约 5,000 字时在写作阶段失败，不得进入审核或成功提交', async () => {
  const payload = requestPayload();
  assert.equal(targetLengthLower(payload.targetLength), TARGET_LENGTH_LOWER);
  const calls = [];
  const stages = [];

  await assert.rejects(
    () => runPipeline(payload, {
      onStage: (stage) => stages.push(stage),
      runner: async (_prompt, context) => {
        calls.push(context.stage);
        return responseFor(payload, draftOfLength(5_000));
      },
    }),
    (error) => {
      assert.equal(error.code, 'length_target_unmet');
      assert.equal(error.stage, 'writing');
      assert.match(`${error.message}\n${JSON.stringify(error.details ?? {})}`, /18,?000/u);
      return true;
    },
  );

  // The initial writer call plus exactly three bounded continuation attempts
  // are auditable. A short candidate must never be handed to quality review.
  assert.deepEqual(calls, [
    'writing',
    'writing_continuation',
    'writing_continuation',
    'writing_continuation',
  ]);
  assert.deepEqual(stages, [
    'writing',
    'writing_continuation',
    'writing_continuation',
    'writing_continuation',
  ]);
  assert.equal(calls.includes('quality_review'), false);
});

test('首稿不足时自动扩写到 18,000 字下限，之后才进入审核', async () => {
  const payload = requestPayload();
  const calls = [];
  const stages = [];
  const result = await runPipeline(payload, {
    onStage: (stage) => stages.push(stage),
    runner: async (prompt, context) => {
      calls.push({ prompt, stage: context.stage, draftLength: context.writer?.draft?.length ?? 0 });
      if (context.stage === 'writing') return responseFor(payload, draftOfLength(5_000));
      return responseFor(payload, draftOfLength(TARGET_LENGTH_LOWER));
    },
  });

  assert.equal(result.status, 'succeeded');
  assert.ok(Array.from(result.draft.replace(/\s+/gu, '')).length >= TARGET_LENGTH_LOWER);
  assert.deepEqual(calls.map((item) => item.stage), [
    'writing',
    'writing_continuation',
    'quality_review',
  ]);
  assert.deepEqual(stages, [
    'writing',
    'writing_continuation',
    'quality_review',
    'quality_gate',
  ]);
  assert.match(calls[1].prompt, /["']?targetLengthLower["']?\s*[:：]\s*18000/u);
  assert.equal(calls[2].draftLength, TARGET_LENGTH_LOWER);
});

test('审核阶段若把达标稿缩短到 18,000 字下限以下，质量门禁硬失败', async () => {
  const payload = requestPayload();
  const calls = [];
  const stages = [];

  await assert.rejects(
    () => runPipeline(payload, {
      onStage: (stage) => stages.push(stage),
      runner: async (_prompt, context) => {
        calls.push(context.stage);
        return responseFor(payload, context.stage === 'quality_review'
          ? draftOfLength(5_000)
          : draftOfLength(TARGET_LENGTH_LOWER));
      },
    }),
    (error) => {
      assert.equal(error.code, 'review_failed');
      assert.equal(error.stage, 'quality_review');
      assert.match(JSON.stringify(error.details ?? {}), /目标长度不足|18,?000/u);
      return true;
    },
  );

  assert.deepEqual(calls, ['writing', 'quality_review']);
  assert.deepEqual(stages, ['writing', 'quality_review', 'quality_gate']);
});

function oversizedEvidencePacket() {
  const now = '2026-09-02T00:00:00.000Z';
  const sources = Array.from({ length: 40 }, (_, index) => ({
    sourceId: `s-${index + 1}`,
    title: `固定来源 ${index + 1}`,
    url: `https://example.com/evidence/${index + 1}`,
    publisher: '回归测试资料库',
    sourceType: 'official',
    authority: 'A',
    publishedAt: '2026-01-01',
    accessedAt: now,
    accessStatus: 'accessible',
    usageStatus: 'allowed',
    sourceFamilyId: `family-${index + 1}`,
    excerpt: '来源摘录。'.repeat(600).slice(0, 1_200),
    locator: '第 1 段',
    contentHash: `hash-${index + 1}`,
  }));
  const claims = Array.from({ length: 100 }, (_, index) => {
    const sourceId = sources[index % sources.length].sourceId;
    return {
      claimId: `c-${index + 1}`,
      text: `固定主张 ${index + 1}。${'这是一条用于构造大证据包的受控主张。'.repeat(100).slice(0, 1_450)}`,
      kind: 'fact',
      sourceIds: [sourceId],
      evidence: [{
        sourceId,
        excerpt: '主张证据摘录。'.repeat(600).slice(0, 1_200),
        locator: '第 1 段',
      }],
      confidence: 'high',
      status: 'supported',
      basis: '回归测试使用固定证据摘录。',
    };
  });
  return {
    schemaVersion: 'content-desk.evidence-packet.v1',
    packetId: 'ep-v36-oversized',
    topic: '超大证据包 JSON 完整性',
    scope: {
      question: '验证超大 evidence packet 进入 prompt 时不会被截成半个 JSON',
      audience: '测试',
      domain: 'general',
      genre: 'research',
      channel: 'wechat',
      jurisdiction: null,
      include: [],
      exclude: [],
      cutoff: '2026-09-02',
      sourceTypes: ['official'],
    },
    retrieval: {
      queries: ['evidence packet regression'],
      mode: 'fixture',
      startedAt: now,
      completedAt: now,
    },
    researchStatus: 'complete',
    retrievalStatus: 'complete',
    createdAt: now,
    sources,
    claims,
    uncertainties: [],
    audit: {
      status: 'passed',
      auditorModel: 'v36-test-auditor',
      auditedAt: now,
      sourceChecks: sources.map(({ sourceId }) => ({ sourceId, status: 'passed', issues: [] })),
      claimChecks: claims.map(({ claimId }) => ({ claimId, status: 'passed', issues: [] })),
      issues: [],
      summary: '固定大包测试。',
      independence: '独立固定回执。',
    },
  };
}

test('超大 Evidence Packet 要么完整进入写作 prompt，要么在调用 runner 前明确拒绝，不能产生半截 JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-v36-evidence-'));
  try {
    const store = createEvidencePacketStore({ directory });
    const rawPacket = oversizedEvidencePacket();
    assert.ok(JSON.stringify(rawPacket).length > 200_000, 'fixture must exercise the former prompt clipping boundary');
    const packet = await store.save(rawPacket);
    assert.equal(packet.packetHash, contentHash(canonicalEvidencePacket(packet)));

    const payload = requestPayload({
      task: {
        kind: 'research_writing',
        domain: 'general',
        genre: 'research',
        channel: 'wechat',
        purpose: 'evidence review',
      },
      brief: {
        topic: '超大证据包 JSON 完整性',
        audience: '测试',
        format: '调研文章',
        tone: '克制',
        materials: '',
      },
      targetLength: 300,
      skillChain: ['topic-evidence-research'],
      evidencePacketId: packet.packetId,
      evidencePacketHash: packet.packetHash,
    });
    // Direct pipeline injection mirrors the server's post-lookup state while
    // keeping this regression test independent of the HTTP body-size limit.
    payload.researchPacket = packet;
    payload.evidencePacket = packet;

    let writingPrompt = '';
    let runnerCalls = 0;
    let result;
    let rejection;
    const evidenceDraft = '[c-1] 该段仅用于验证超大证据包不会被截断。\n\n参考文献\n- [source:s-1] 固定来源 1 https://example.com/evidence/1';
    try {
      result = await runPipeline(payload, {
        runner: async (prompt, context) => {
          runnerCalls += 1;
          if (context.stage === 'writing') writingPrompt = prompt;
          return responseFor(payload, evidenceDraft);
        },
      });
    } catch (error) {
      rejection = error;
    }

    if (rejection) {
      // A bounded, Bridge-owned rejection is an acceptable safety behavior;
      // it must happen before a model sees an untrusted/incomplete prompt.
      assert.equal(runnerCalls, 0);
      assert.ok(typeof rejection.code === 'string' && rejection.code.length > 0);
      assert.ok(['writing', 'validation', 'bridge'].includes(rejection.stage));
      return;
    }

    assert.equal(result.status, 'succeeded');
    assert.equal(runnerCalls, 2);
    const match = writingPrompt.match(/<input_data>\r?\n([\s\S]*?)\r?\n<\/input_data>/u);
    assert.ok(match, 'writing prompt must expose a complete input_data object');
    assert.doesNotThrow(() => JSON.parse(match[1]));
    const input = JSON.parse(match[1]);
    assert.equal(input.researchPacket.packetId, packet.packetId);
    assert.equal(input.researchPacket.claims.length, packet.claims.length);
    assert.equal(input.researchPacket.sources.length, packet.sources.length);
    assert.equal(writingPrompt.includes('[输入已截断]'), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
