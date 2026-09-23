import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { request } from 'node:http';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendContinuationSection,
  buildDeterministicReferences,
  buildPrompt,
  contentHash,
  createBridgeServer,
  createCancellationController,
  detachPrematureReferences,
  EDITORIAL_SCORE_DIMENSIONS,
  evidenceCitationBoundIssues,
  referencesSectionInfo,
  runPipeline,
  validateAuthorVoiceContinuation,
  validateDraftInvariants,
  validateLongformReviewResponse,
  validateContinuationResponse,
  validateRequestPayload,
  validateTargetLength,
} from '../server.mjs';

const TARGET = 20_000;
const LOWER = 18_000;

test('continuation schema stays within the Codex structured-output subset', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../content-continuation.schema.json', import.meta.url), 'utf8'));
  assert.equal(JSON.stringify(schema).includes('"uniqueItems"'), false);
});

function payload(overrides = {}) {
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
      topic: '长文分段续写回归测试',
      audience: '知识创作者',
      format: '分析文章',
      tone: '克制',
      materials: '',
    },
    targetLength: TARGET,
    ...overrides,
  });
}

function fullScore() {
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

function responseFor(request, draft) {
  return {
    schemaVersion: 'codex.bridge.response.v1',
    status: 'succeeded',
    mode: request.mode,
    versionId: 'v37-longform-test',
    draft,
    titleCandidates: ['分段续写测试', '长文如何安全组装', '证据边界下的长文生成'],
    recommendedTitle: '分段续写测试',
    outline: ['起点', '证据', '限制'],
    tags: ['长文', '续写', '回归'],
    receipts: [],
    diagnostics: {
      humanized: true,
      changes: [],
      remainingFlags: [],
      engine: 'codex-cli',
      rulesVersion: 'nonfiction-editorial.v1',
      model: 'v37-test-model',
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
      editorialScore: fullScore(),
    },
    warnings: [],
  };
}

function compactReviewFor(request, draft, overrides = {}) {
  return {
    schemaVersion: 'codex.bridge.review.v1',
    status: 'succeeded',
    mode: request.mode,
    draftHash: contentHash(draft),
    receipts: [],
    diagnostics: {
      humanized: true,
      changes: [],
      remainingFlags: [],
      engine: 'codex-cli',
      rulesVersion: 'nonfiction-editorial.v1',
      model: 'v37-review-test-model',
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
      editorialScore: fullScore(),
    },
    warnings: [],
    ...overrides,
  };
}

function httpJson(port, route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const headers = encoded === undefined
      ? {}
      : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) };
    const req = request({ host: '127.0.0.1', port, path: route, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = raw ? JSON.parse(raw) : undefined; } catch { parsed = undefined; }
        resolve({ status: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (encoded !== undefined) req.write(encoded);
    req.end();
  });
}

function contentRequestBody(overrides = {}) {
  return {
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
      topic: 'HTTP 长文失败原子性',
      audience: '知识创作者',
      format: '分析文章',
      tone: '克制',
      materials: '',
    },
    targetLength: 600,
    ...overrides,
  };
}

function draft(length, marker = '首稿') {
  const unit = `${marker}保留原始论点并等待分段证据解释，当前段落仅作结构起点。`;
  const alphabet = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  let value = '';
  while (value.length < length) value += `${unit}${alphabet.slice(0, (value.length % 12) + 1)}`;
  return value.slice(0, length);
}

function uniqueChunk(index, length, { claimId = undefined } = {}) {
  const prefix = claimId ? `[${claimId}]` : '';
  const alphabet = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌亥';
  let value = prefix;
  let cursor = 0;
  while (value.length < length) {
    const token = Array.from({ length: 36 }, (_, offset) => (
      String.fromCharCode(0x4e00 + ((index * 173 + cursor + offset * 37) % 2_000))
    )).join('');
    value += `${token}第${index}段只补充当前证据包允许的边界、限制和可执行核验动作，${alphabet[(index + cursor) % alphabet.length]}。`;
    cursor += 1;
  }
  return value.slice(0, length);
}

function continuation(request, index, length, options = {}) {
  const claimId = options.claimId;
  const chunk = uniqueChunk(index, length, { claimId });
  return {
    schemaVersion: 'codex.bridge.continuation.v1',
    status: 'succeeded',
    mode: request.mode,
    sectionId: `section-${index}`,
    sectionTitle: `计划段落${index}`,
    chunk,
    usedClaimIds: claimId ? [claimId] : [],
    warnings: [],
  };
}

function packet() {
  return {
    sources: [{ sourceId: 's-1', title: '受控回归来源', url: 'https://example.com/source-1' }],
    claims: [{ claimId: 'c-1', text: '受控回归主张', sourceIds: ['s-1'] }],
    uncertainties: [],
  };
}

test('20,000 目标使用 section-only 响应追加，组装后达到 18,000—20,000 且保留正文与证据标记', async () => {
  const request = payload({ researchPacket: packet() });
  const initial = draft(5_000);
  const calls = [];
  const result = await runPipeline(request, {
    runner: async (_prompt, context) => {
      calls.push(context.stage);
      if (context.stage === 'writing') return responseFor(request, initial);
      if (context.stage === 'writing_continuation') {
        const section = calls.filter((stage) => stage === 'writing_continuation').length;
        return continuation(request, section, 3_500, { claimId: 'c-1' });
      }
      return responseFor(request, context.writer.draft);
    },
  });

  const visible = Array.from(result.draft.replace(/\s+/gu, '')).length;
  assert.ok(visible >= LOWER, `visible length ${visible} should reach ${LOWER}`);
  assert.ok(visible <= TARGET, `visible length ${visible} should not exceed ${TARGET}`);
  assert.ok(result.draft.startsWith(initial), 'assembly must preserve the complete initial manuscript prefix');
  assert.equal((result.draft.match(/\[c-1\]/gu) ?? []).length, 4, 'each evidence-bounded chunk keeps its claim marker');
  assert.match(result.draft, /参考文献\n- \[source:s-1\] 受控回归来源 https:\/\/example\.com\/source-1/u);
  assert.deepEqual(calls, [
    'writing',
    'writing_continuation',
    'writing_continuation',
    'writing_continuation',
    'writing_continuation',
    'quality_review',
  ]);
  assert.equal(result.diagnostics.writerPasses, 5);
  assert.equal(result.diagnostics.passes, 6);
});

test('v2 初始 writer 直接用周期重复凑到 18,000 字时立即拒绝，不进入续写或审核', async () => {
  const request = payload();
  const unit = '这是一段用于验证机械填充拦截的固定说明，不能因为重复出现就成为新的证据或有效论证。';
  const repeated = unit.repeat(Math.ceil(18_000 / unit.length)).slice(0, 18_000);
  const calls = [];
  await assert.rejects(
    () => runPipeline(request, {
      runner: async (_prompt, context) => {
        calls.push(context.stage);
        return responseFor(request, repeated);
      },
    }),
    (error) => error.code === 'length_target_unmet'
      && error.stage === 'writing'
      && /机械填充/u.test(error.message),
  );
  assert.deepEqual(calls, ['writing']);
});

test('长文首稿提前输出参考文献时由 Bridge 安全剥离，并在最终正文后确定性重建', async () => {
  const request = payload({ researchPacket: packet() });
  const initial = `${draft(4_900)}\n\n参考文献\n- [source:s-1] 旧模型条目 https://evil.example/stale\n\n参考文献\n- [source:s-1] 第二个旧条目 https://evil.example/stale-2`;
  const calls = [];
  const continuationDrafts = [];
  const result = await runPipeline(request, {
    runner: async (_prompt, context) => {
      calls.push(context.stage);
      if (context.stage === 'writing') return responseFor(request, initial);
      if (context.stage === 'writing_continuation') {
        continuationDrafts.push(context.writer.draft);
        const section = calls.filter((stage) => stage === 'writing_continuation').length;
        return continuation(request, section, 3_500, { claimId: 'c-1' });
      }
      return compactReviewFor(request, context.writer.draft);
    },
  });
  assert.ok(result.draft.startsWith(draft(4_900)), 'the body prefix must survive detachment');
  assert.equal(result.draft.includes('旧模型条目'), false, 'stale model bibliography must not reach the final draft');
  assert.match(result.draft, /参考文献\n- \[source:s-1\] 受控回归来源 https:\/\/example\.com\/source-1/u);
  assert.equal((result.draft.match(/(?:^|\n)参考文献\n/gu) ?? []).length, 1, 'final draft must have exactly one deterministic references section');
  assert.equal(continuationDrafts.every((value) => !value.includes('参考文献')), true, 'continuation context must remain body-only');
  assert.ok(calls.includes('writing_continuation'));
});

test('批注重写提前输出参考文献时同样剥离续写，并回填确定性文献与批注回执', async () => {
  const oldBody = draft(4_900);
  const oldDraft = `${oldBody}\n\n参考文献\n- [source:s-1] 受控回归来源 https://example.com/source-1 · 人工保留注记`;
  const request = payload({
    mode: 'annotation_regeneration',
    previousGeneratedDraft: oldDraft,
    currentDraft: oldDraft,
    protectedFacts: ['https://example.com/source-1'],
    annotations: [{ id: 'structure-1', kind: '结构建议', note: '压缩重复段落', quote: '', resolved: false }],
    researchPacket: packet(),
  });
  const receipt = { id: 'structure-1', status: 'applied', message: '已压缩重复段落。' };
  const initial = {
    ...responseFor(request, `${oldBody}\n\n参考文献\n- [source:s-1] 模型提前输出 https://example.com/source-1`),
    receipts: [receipt],
  };
  const seenContinuationDrafts = [];
  const seenContinuationPrompts = [];
  const result = await runPipeline(request, {
    runner: async (prompt, context) => {
      if (context.stage === 'writing') return initial;
      if (context.stage === 'writing_continuation') {
        seenContinuationDrafts.push(context.writer.draft);
        seenContinuationPrompts.push(prompt);
        const section = seenContinuationDrafts.length;
        return continuation(request, section, 3_500, { claimId: 'c-1' });
      }
      return { ...compactReviewFor(request, context.writer.draft), receipts: [receipt] };
    },
  });
  assert.equal(seenContinuationDrafts.every((value) => !value.includes('参考文献')), true);
  assert.equal(seenContinuationPrompts.every((value) => /所有 section（包括最后一个）都只能写正文/u.test(value)), true);
  assert.equal(seenContinuationPrompts.every((value) => !/参考文献只能在最后一个 section 出现/u.test(value)), true);
  assert.equal((result.draft.match(/(?:^|\n)参考文献\n/gu) ?? []).length, 1);
  assert.match(result.draft, /\[source:s-1\] 受控回归来源 https:\/\/example\.com\/source-1/u);
  assert.match(result.draft, /人工保留注记/u);
  assert.deepEqual(result.receipts, [receipt]);
});

test('正文与参考文献重复出现的 URL 仍是正文受保护事实，不能被过滤', () => {
  const url = 'https://example.com/source-1';
  const plainBody = draft(4_900);
  const currentDraft = `${plainBody}\n正文核验入口：${url}\n\n参考文献\n- [source:s-1] 受控回归来源 ${url}`;
  const outputDraft = `${plainBody}\n\n参考文献\n- [source:s-1] 受控回归来源 ${url}`;
  const request = payload({
    mode: 'source_rewrite',
    previousGeneratedDraft: currentDraft,
    currentDraft,
    protectedFacts: [url],
    researchPacket: packet(),
  });
  assert.match(validateDraftInvariants(request, outputDraft).join('\n'), /受保护事实缺失或被改写/u);
});

test('外部原稿重写的长文提示与校验同样保持 section-only，并由 Bridge 重建文献', async () => {
  const currentDraft = `${draft(4_900)}\n\n参考文献\n- [source:s-1] 受控回归来源 https://example.com/source-1\n- [source:s-2] 作者保留来源 https://example.com/source-2`;
  const rewritePacket = {
    ...packet(),
    sources: [
      ...packet().sources,
      { sourceId: 's-2', title: '作者保留来源', url: 'https://example.com/source-2' },
    ],
  };
  const request = payload({
    mode: 'source_rewrite',
    previousGeneratedDraft: currentDraft,
    currentDraft,
    researchPacket: rewritePacket,
  });
  const initial = `${currentDraft}\n\n参考文献\n- [source:s-1] 模型提前输出 https://example.com/source-1`;
  const continuationPrompts = [];
  const result = await runPipeline(request, {
    runner: async (prompt, context) => {
      if (context.stage === 'writing') return responseFor(request, initial);
      if (context.stage === 'writing_continuation') {
        continuationPrompts.push(prompt);
        return continuation(request, continuationPrompts.length, 3_500, { claimId: 'c-1' });
      }
      return compactReviewFor(request, context.writer.draft);
    },
  });
  assert.ok(continuationPrompts.length > 0);
  assert.equal(continuationPrompts.every((value) => /所有 section（包括最后一个）都只能写正文/u.test(value)), true);
  assert.equal(result.draft.includes('模型提前输出'), false);
  assert.equal((result.draft.match(/(?:^|\n)参考文献\n/gu) ?? []).length, 1);
  assert.match(result.draft, /\[source:s-1\] 受控回归来源 https:\/\/example\.com\/source-1/u);
  assert.match(result.draft, /\[source:s-2\] 作者保留来源 https:\/\/example\.com\/source-2/u);
});

test('packet-backed 重写在模型启动前拒绝无法映射的作者参考文献，避免静默丢失', async () => {
  const currentDraft = `${draft(4_900)}\n\n参考文献\n- 作者手工来源 https://outside.example/manual`;
  const request = payload({
    mode: 'source_rewrite',
    previousGeneratedDraft: currentDraft,
    currentDraft,
    researchPacket: packet(),
  });
  let calls = 0;
  await assert.rejects(
    () => runPipeline(request, { runner: async () => { calls += 1; return responseFor(request, currentDraft); } }),
    (error) => error.code === 'research_citation_invalid'
      && error.stage === 'writing'
      && /未被当前冻结证据包完整授权/u.test(error.message),
  );
  assert.equal(calls, 0);
});

test('显式 sourceId 优先于重复题名，重写不会误判两个同名来源', async () => {
  const sharedPacket = {
    sources: [
      { sourceId: 's-1', title: '同名研究', url: 'https://example.com/source-1' },
      { sourceId: 's-2', title: '同名研究', url: 'https://example.com/source-2' },
    ],
    claims: [{ claimId: 'c-1', text: '受控回归主张', sourceIds: ['s-1'] }],
    uncertainties: [],
  };
  const body = draft(4_900);
  const currentDraft = `${body}\n\n参考文献\n- [source:s-1] 同名研究 https://example.com/source-1`;
  const request = payload({
    mode: 'source_rewrite',
    previousGeneratedDraft: currentDraft,
    currentDraft,
    researchPacket: sharedPacket,
  });
  const calls = [];
  const result = await runPipeline(request, {
    runner: async (_prompt, context) => {
      calls.push(context.stage);
      if (context.stage === 'writing') return responseFor(request, currentDraft);
      if (context.stage === 'writing_continuation') {
        const section = calls.filter((stage) => stage === 'writing_continuation').length;
        return continuation(request, section, 3_500, { claimId: 'c-1' });
      }
      return compactReviewFor(request, context.writer.draft);
    },
  });
  assert.ok(calls.length > 0);
  assert.match(result.draft, /\[source:s-1\] 同名研究 https:\/\/example\.com\/source-1/u);
  assert.equal(result.draft.includes('source-2'), false);
});

test('未知 source、claim 或裸证据标记即使题名与 URL 匹配，也在模型启动前拒绝', async () => {
  for (const marker of ['[source:s-404]', '[claim:c-404]', '[s-404]']) {
    const currentDraft = `${draft(4_900)}\n\n参考文献\n- ${marker} 受控回归来源 https://example.com/source-1`;
    const request = payload({
      mode: 'source_rewrite',
      previousGeneratedDraft: currentDraft,
      currentDraft,
      researchPacket: packet(),
    });
    let calls = 0;
    await assert.rejects(
      () => runPipeline(request, { runner: async () => { calls += 1; return responseFor(request, currentDraft); } }),
      (error) => error.code === 'research_citation_invalid'
        && error.stage === 'writing'
        && /冻结证据包外标记/u.test((error.details?.issues ?? []).join('\n')),
    );
    assert.equal(calls, 0, `${marker} must fail before any model call`);
  }
});

test('已知 source 条目夹带冻结来源外 URL 或 DOI 时在模型启动前拒绝', async () => {
  for (const extra of ['https://outside.example/forged', '10.9999/forged']) {
    const currentDraft = `${draft(4_900)}\n\n参考文献\n- [source:s-1] 受控回归来源 https://example.com/source-1 ${extra}`;
    const request = payload({
      mode: 'source_rewrite',
      previousGeneratedDraft: currentDraft,
      currentDraft,
      researchPacket: packet(),
    });
    let calls = 0;
    await assert.rejects(
      () => runPipeline(request, { runner: async () => { calls += 1; return responseFor(request, currentDraft); } }),
      (error) => error.code === 'research_citation_invalid'
        && error.stage === 'writing'
        && /冻结来源外 URL\/DOI/u.test((error.details?.issues ?? []).join('\n')),
    );
    assert.equal(calls, 0, `${extra} must fail before any model call`);
  }
});

test('仅修改 Bridge 参考文献不会被误判为正文作者语气未延续', () => {
  const body = draft(1_200);
  const request = payload({
    mode: 'annotation_regeneration',
    previousGeneratedDraft: `${body}\n\n参考文献\n- [source:s-1] 受控回归来源 https://example.com/source-1`,
    currentDraft: `${body}\n\n参考文献\n- [source:s-1] 受控回归来源 https://example.com/source-1 · 作者排版一\n- [source:s-2] 另一条作者排版`,
    annotations: [{ id: 'format-refs', kind: '结构建议', note: '保留正文，只整理文献', quote: '', resolved: false }],
    researchPacket: packet(),
  });
  assert.deepEqual(validateAuthorVoiceContinuation(request, body), []);
});

test('四个正文标题加 Bridge 参考文献标题不会被误判为小标题过量', async () => {
  const request = payload({ researchPacket: packet() });
  const headings = '## 定义与边界\n## 合成路线\n## 结构验证\n## 应用限制\n';
  const initial = `${headings}${draft(4_900 - headings.length)}`;
  const calls = [];
  const result = await runPipeline(request, {
    runner: async (_prompt, context) => {
      calls.push(context.stage);
      if (context.stage === 'writing') return responseFor(request, initial);
      if (context.stage === 'writing_continuation') {
        const section = calls.filter((stage) => stage === 'writing_continuation').length;
        return continuation(request, section, 3_500, { claimId: 'c-1' });
      }
      return compactReviewFor(request, context.writer.draft);
    },
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.blockingReasons.length, 0);
  assert.equal(result.diagnostics.remainingFlags.some((item) => /小标题过量/u.test(item)), false);
});

test('首稿剥离和确定性参考文献生成只保留正文实际使用的 packet source', () => {
  const request = payload({
    researchPacket: {
      sources: [
        { sourceId: 's-1', title: '来源一', url: 'https://example.com/source-1' },
        { sourceId: 's-2', title: '未使用来源', url: 'https://example.com/source-2' },
      ],
      claims: [
        { claimId: 'c-1', text: '受控主张', sourceIds: ['s-1'] },
        { claimId: 'c-2', text: '未使用主张', sourceIds: ['s-2'] },
      ],
      uncertainties: [],
    },
  });
  const detached = detachPrematureReferences(
    '[c-1] 首段正文。\n\n参考文献\n- [source:s-2] 旧条目 https://example.com/source-2',
    { lower: 18_000 },
  );
  assert.equal(detached.detached, true);
  assert.equal(detached.draft.includes('旧条目'), false);
  assert.match(detached.detachedReferences, /旧条目/u);
  const refs = buildDeterministicReferences(request, '[c-1] 仅使用来源一。');
  assert.equal(refs, '参考文献\n- [source:s-1] 来源一 https://example.com/source-1');
  assert.equal(refs.includes('s-2'), false);
});

test('长文首轮 prompt 与续写 prompt 明确禁止模型提前或自由生成参考文献', () => {
  const request = payload({ researchPacket: packet() });
  const initialPrompt = buildPrompt(request, 'writing');
  assert.match(initialPrompt, /首段候选/u);
  assert.match(initialPrompt, /不要输出“参考文献”/u);
  assert.match(initialPrompt, /确定性生成参考文献/u);
  assert.doesNotMatch(initialPrompt, /只有最后一个续写 section 才能追加该区/u);
  assert.match(initialPrompt, /首轮只要求 4,000—6,000 个可见字符/u);
  const continuationPrompt = buildPrompt(request, 'writing_continuation', responseFor(request, draft(6_000)), {
    continuationPass: 1,
    remainingChars: 2_000,
    maxNewChars: 2_000,
    usedSectionIds: [],
    allowedSectionIds: ['section-1'],
    deterministicReferences: true,
  });
  assert.match(continuationPrompt, /所有 section（包括最后一个）都只能写正文/u);
  assert.match(continuationPrompt, /禁止输出参考文献标题/u);
  assert.match(continuationPrompt, /本 section 只需满足本轮 continuation\.remainingChars/u);
  const reviewPrompt = buildPrompt(request, 'quality_review', responseFor(request, draft(18_500)));
  assert.match(reviewPrompt, /Bridge 已将参考文献区排除后计算正文可见长度/u);
  assert.match(reviewPrompt, /不得仅因该参考文献区存在而扣分/u);
  assert.match(reviewPrompt, /不得返回或改写正文/u);
});

test('续写 prompt 明确列出整稿已重复的句首并禁止继续复用', () => {
  const request = payload({ researchPacket: packet() });
  const prefix = '这个句首专门用于验证跨章节重复预防约束是否进入模型输入';
  const existing = `${prefix}，第一次说明不同的事实边界。${prefix}，第二次说明另一项限制条件。`;
  const prompt = buildPrompt(request, 'writing_continuation', responseFor(request, existing), {
    continuationPass: 1,
    remainingChars: 12000,
    maxNewChars: 12000,
    usedSectionIds: [],
    allowedSectionIds: ['section-1'],
    deterministicReferences: true,
  });
  assert.match(prompt, /avoidSentencePrefixes/u);
  assert.match(prompt, new RegExp(prefix.slice(0, 24), 'u'));
  assert.match(prompt, /不得再以其中任一字符串开头/u);
});

test('参考文献边界取第一个合法标题，重复标题不能把引用区计入正文长度', () => {
  const body = '正文'.repeat(8_952); // 17,904 visible chars
  const text = `${body}\n\n参考文献\n- [source:s-1] 首个条目 https://example.com/one\n\n参考文献\n- [source:s-2] 第二个条目 https://example.com/two`;
  const info = referencesSectionInfo(text);
  assert.equal(Array.from(info.body.replace(/\s+/gu, '')).length, 17_904);
  assert.match(info.references, /首个条目/u);
  assert.match(info.references, /第二个条目/u);
  assert.equal(validateTargetLength(payload({ targetLength: TARGET }), text).some((issue) => /目标长度不足/u.test(issue)), true);
});

test('source_rewrite 与 annotation_regeneration 的长文长度同样只计参考文献前正文', () => {
  const body = '正文'.repeat(8_950); // 17,900 visible chars
  const withReferences = `${body}\n\n参考文献\n- 用户已有来源 https://example.com/user-source`;
  for (const mode of ['source_rewrite', 'annotation_regeneration']) {
    const issues = validateTargetLength({ contractVersion: 'v2', mode, targetLength: TARGET }, withReferences);
    assert.equal(issues.some((issue) => /目标长度不足/u.test(issue)), true, `${mode} must not count references toward 18k`);
  }
});

test('section-only 续写拒绝同一 section、未知 claimId 和正文未标记的 claimId', () => {
  const request = payload({ researchPacket: packet() });
  const valid = continuation(request, 1, 800, { claimId: 'c-1' });
  assert.equal(validateContinuationResponse(valid, request, {
    allowedSectionIds: ['section-1'],
    remainingChars: 1_000,
    maxNewChars: 1_000,
  }).sectionId, 'section-1');
  assert.throws(
    () => validateContinuationResponse({ ...valid, usedClaimIds: ['c-404'], chunk: '[c-404]未知来源' }, request, {
      allowedSectionIds: ['section-1'],
      remainingChars: 1_000,
      maxNewChars: 1_000,
    }),
    (error) => error.code === 'invalid_cli_output',
  );
  assert.throws(
    () => validateContinuationResponse({ ...valid, usedClaimIds: ['c-1'], chunk: uniqueChunk(1, 800) }, request, {
      allowedSectionIds: ['section-1'],
      remainingChars: 1_000,
      maxNewChars: 1_000,
    }),
    (error) => error.code === 'invalid_cli_output',
  );
  assert.throws(
    () => validateContinuationResponse({ ...valid, chunk: `${uniqueChunk(1, 800)} https://not-in-packet.example/x` }, request, {
      allowedSectionIds: ['section-1'],
      remainingChars: 1_000,
      maxNewChars: 1_000,
    }),
    (error) => error.code === 'invalid_cli_output',
  );
  assert.throws(
    () => validateContinuationResponse(valid, request, {
      usedSectionIds: ['section-1'],
      allowedSectionIds: ['section-1'],
      remainingChars: 1_000,
      maxNewChars: 1_000,
    }),
    (error) => error.code === 'invalid_cli_output',
  );
  assert.throws(
    () => validateContinuationResponse({ ...valid, usedClaimIds: [], chunk: uniqueChunk(1, 800) }, request, {
      allowedSectionIds: ['section-1'],
      remainingChars: 1_000,
      maxNewChars: 1_000,
    }),
    (error) => error.code === 'invalid_cli_output',
  );
});

test('无冻结证据包的长文续写拒绝自造 source refs，且不要求虚假参考文献', () => {
  const request = payload();
  const noPacketPrompt = buildPrompt(request, 'writing_continuation', responseFor(request, draft(6_000)), {
    continuationPass: 1,
    remainingChars: 2_000,
    maxNewChars: 2_000,
    usedSectionIds: [],
    allowedSectionIds: ['section-1'],
  });
  assert.match(noPacketPrompt, /没有冻结证据包/u);
  assert.match(noPacketPrompt, /不得输出未经核验的参考文献/u);
  const valid = continuation(request, 1, 800);
  assert.equal(validateContinuationResponse(valid, request, {
    allowedSectionIds: ['section-1'],
    remainingChars: 1_000,
    maxNewChars: 1_000,
  }).sectionId, 'section-1');
  assert.throws(
    () => validateContinuationResponse({
      ...valid,
      chunk: `${valid.chunk}\nhttps://example.com/forged-source`,
    }, request, {
      allowedSectionIds: ['section-1'],
      remainingChars: 1_000,
      maxNewChars: 1_000,
    }),
    (error) => error.code === 'invalid_cli_output' && /冻结证据包/u.test(error.message),
  );
});

test('appendContinuationSection 去除零宽字符伪装的重复段落，并拒绝超出长文上限', () => {
  const request = payload();
  const first = continuation(request, 1, 800);
  const appended = appendContinuationSection('首稿。', first, {
    allowedSectionIds: ['section-1'],
    targetUpper: TARGET,
  });
  assert.ok(appended.draft.includes(first.chunk));
  const disguised = { ...continuation(request, 2, 800), chunk: first.chunk.replace(/第1段/gu, '第1\u200B段') };
  assert.throws(
    () => appendContinuationSection(appended.draft, disguised, { targetUpper: TARGET }),
    (error) => error.code === 'length_target_unmet',
  );
  assert.throws(
    () => appendContinuationSection('甲'.repeat(TARGET - 100), continuation(request, 2, 800), { targetUpper: TARGET }),
    (error) => error.code === 'length_target_unmet',
  );
});

test('appendContinuationSection 拒绝仅修改尾字符的近重复机械段落', () => {
  const nearRepeat = Array.from({ length: 100 }, (_, index) => (
    `这是一段用于测试的专业说明，重点解释证据边界、限制条件和可执行核验动作，尾部变体${String.fromCharCode(0x4e00 + index)}。`
  )).join('');
  assert.throws(
    () => appendContinuationSection('起稿。', {
      schemaVersion: 'codex.bridge.continuation.v1',
      status: 'succeeded',
      mode: 'initial_generation',
      sectionId: 'section-1',
      sectionTitle: '近重复',
      chunk: nearRepeat,
      usedClaimIds: [],
      warnings: [],
    }, { targetUpper: TARGET }),
    (error) => error.code === 'length_target_unmet' && /机械重复/u.test(error.message),
  );
});

test('长文 section 仍不足时在预分配次数后 fail-closed，不进入审核', async () => {
  const request = payload();
  const calls = [];
  await assert.rejects(
    () => runPipeline(request, {
      runner: async (_prompt, context) => {
        calls.push(context.stage);
        if (context.stage === 'writing') return responseFor(request, draft(5_000));
        if (context.stage === 'writing_continuation') {
          const section = calls.filter((stage) => stage === 'writing_continuation').length;
          return continuation(request, section, 600);
        }
        throw new Error('review must not run');
      },
    }),
    (error) => error.code === 'length_target_unmet' && error.stage === 'writing',
  );
  assert.equal(calls.filter((stage) => stage === 'writing_continuation').length, 8);
  assert.equal(calls.includes('quality_review'), false);
});

test('取消发生在 section 之间时停止后续模型调用，当前稿不进入审核', async () => {
  const request = payload({ clientRunId: 'v37-cancel-test' });
  const cancellation = createCancellationController();
  cancellation.begin({ clientRunId: request.clientRunId, kind: 'content', stage: 'writing' });
  const calls = [];
  await assert.rejects(
    () => runPipeline(request, {
      cancelController: cancellation,
      runner: async (_prompt, context) => {
        calls.push(context.stage);
        if (context.stage === 'writing') return responseFor(request, draft(5_000));
        cancellation.cancel(request.clientRunId);
        return continuation(request, 1, 800);
      },
    }),
    (error) => error.code === 'cancelled',
  );
  assert.deepEqual(calls, ['writing', 'writing_continuation']);
  assert.equal(calls.includes('quality_review'), false);
});

test('长文审核使用独立紧凑 schema，仅回显 Bridge 提供的冻结 draftHash，不携带正文', async () => {
  const request = payload();
  const initial = draft(5_000);
  const calls = [];
  const result = await runPipeline(request, {
    runner: async (prompt, context) => {
      calls.push({ stage: context.stage, prompt });
      if (context.stage === 'writing') return responseFor(request, initial);
      if (context.stage === 'writing_continuation') {
        const section = calls.filter((item) => item.stage === 'writing_continuation').length;
        return continuation(request, section, 3_500);
      }
      assert.match(prompt, /frozenDraftHash/u);
      assert.match(prompt, /codex\.bridge\.review\.v1/u);
      return compactReviewFor(request, context.writer.draft);
    },
  });
  assert.ok(result.draft.length >= LOWER);
  const reviewCall = calls.find((item) => item.stage === 'quality_review');
  assert.ok(reviewCall);
  assert.equal(reviewCall.prompt.includes(contentHash(result.draft)), true);
  assert.equal(result.draft, initial + result.draft.slice(initial.length));
  assert.equal(result.diagnostics.reviewPasses, 1);
});

test('紧凑审核拒绝 hash 不匹配或任何 draft 替换字段，并保留严格长度边界', () => {
  const request = payload();
  const frozen = draft(18_000);
  const expectedHash = contentHash(frozen);
  const valid = compactReviewFor(request, frozen);
  assert.equal(validateLongformReviewResponse(valid, request, expectedHash).draftHash, expectedHash);
  assert.throws(
    () => validateLongformReviewResponse({ ...valid, draftHash: '0'.repeat(64) }, request, expectedHash),
    (error) => error.code === 'review_failed',
  );
  assert.throws(
    () => validateLongformReviewResponse({ ...valid, draft: frozen }, request, expectedHash),
    (error) => error.code === 'review_failed',
  );
  assert.deepEqual(validateTargetLength(request, draft(18_000)), []);
  assert.match(validateTargetLength(request, draft(17_999))[0], /目标长度不足/u);
  assert.match(
    validateTargetLength(request, `${draft(17_999)}\u200B`.repeat(2))[0],
    /目标长度超出/u,
    '零宽字符不能替真实正文凑字数，重复正文仍应按真实字符判超限',
  );
  assert.match(
    validateTargetLength(request, `甲`.repeat(17_999) + '\u200B'.repeat(2_001))[0],
    /目标长度不足/u,
    '零宽字符不能把 17,999 个真实字符伪装成 20,000 字',
  );
  assert.match(validateTargetLength(request, draft(20_001))[0], /目标长度超出/u);
});

test('审核提示将服务器冻结 hash 原样注入 input_data，避免模型自行计算 20k hash', () => {
  const request = payload({ researchPacket: packet() });
  const frozen = draft(18_000);
  const prompt = buildPrompt(request, 'quality_review', {
    draft: frozen,
    recommendedTitle: '冻结稿',
    titleCandidates: ['一', '二', '三'],
    outline: ['甲', '乙', '丙'],
    tags: ['长文', '审校', '测试'],
  });
  assert.match(prompt, new RegExp(contentHash(frozen), 'u'));
  assert.match(prompt, /"targetLengthUpper": 20000/u);
  assert.match(prompt, /"frozenVisibleLength": 18000/u);
  assert.match(prompt, /"bridgeGeneratedReferences": true/u);
  assert.match(prompt, /draftHash 必须逐字复制 input_data\.frozenDraftHash/u);
  assert.match(prompt, /不得仅因该参考文献区存在而扣分/u);
  assert.match(prompt, /不得自行目测、估算/u);
});

test('组装后的长文拒绝证据包外的 claimId、URL、DOI，并报告丢失的续写标记', () => {
  const request = payload({
    researchPacket: {
      sources: [{ sourceId: 's-1', title: '允许来源标题', url: 'https://example.com/source-1', doi: '10.1234/allowed' }],
      claims: [{ claimId: 'c-1', text: '受控主张', sourceIds: ['s-1'] }],
      uncertainties: [],
    },
  });
  const valid = '[c-1] 正文 https://example.com/source-1 10.1234/allowed\n\n参考文献\n- [source:s-1] 允许来源标题 https://example.com/source-1 10.1234/allowed';
  assert.deepEqual(evidenceCitationBoundIssues(request, valid, { requiredClaimIds: ['c-1'] }), []);
  const forged = evidenceCitationBoundIssues(
    request,
    '[c-404] 伪造主张 https://evil.example/claim 10.1234/forged',
    { requiredClaimIds: ['c-1'] },
  );
  assert.equal(forged.some((issue) => /引用 id/u.test(issue)), true);
  assert.equal(forged.some((issue) => /URL/u.test(issue)), true);
  assert.equal(forged.some((issue) => /DOI/u.test(issue)), true);
  assert.equal(forged.some((issue) => /claimId 标记/u.test(issue)), true);
});

test('研究长文执行正文 claim marker 与文末参考文献的双向闭环', () => {
  const request = payload({
    researchPacket: {
      sources: [
        { sourceId: 's-1', title: '来源一标题', url: 'https://example.com/source-1' },
        { sourceId: 's-2', title: '来源二标题', url: 'https://example.com/source-2' },
      ],
      claims: [{ claimId: 'c-1', text: '受控主张', sourceIds: ['s-1'] }],
      uncertainties: [],
    },
  });
  const noMarker = evidenceCitationBoundIssues(
    request,
    '正文没有 claim 标记。\n\n参考文献\n- [source:s-1] 来源一标题 https://example.com/source-1',
  );
  assert.equal(noMarker.some((issue) => /至少需要一个有效 claim marker/u.test(issue)), true);

  const orphanReference = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文引用受控主张。\n\n参考文献\n- [source:s-1] 来源一标题 https://example.com/source-1\n- [source:s-2] 来源二标题 https://example.com/source-2',
  );
  assert.equal(orphanReference.some((issue) => /孤儿 sourceId：s-2/u.test(issue)), true);

  const missingReference = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文引用受控主张。\n\n参考文献\n- [source:s-2] 来源二标题 https://example.com/source-2',
  );
  assert.equal(missingReference.some((issue) => /缺少文末参考文献条目：s-1/u.test(issue)), true);
});

test('研究参考文献条目必须逐条带 packet title、原始 URL 和 DOI', () => {
  const request = payload({
    researchPacket: {
      sources: [{
        sourceId: 's-1',
        title: '可核验来源标题',
        url: 'https://example.com/source-doi',
        doi: '10.1234/allowed',
      }],
      claims: [{ claimId: 'c-1', text: '受控主张', sourceIds: ['s-1'] }],
      uncertainties: [],
    },
  });
  const complete = '[c-1] 正文中的受控主张。\n\n参考文献\n- [source:s-1] 可核验来源标题 https://example.com/source-doi 10.1234/allowed';
  assert.deepEqual(evidenceCitationBoundIssues(request, complete), []);

  const bareMarker = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文中的受控主张。\n\n参考文献\n- [source:s-1]',
  );
  assert.equal(bareMarker.some((issue) => /缺少 packet title/u.test(issue)), true);
  assert.equal(bareMarker.some((issue) => /缺少 packet 原始 URL/u.test(issue)), true);
  assert.equal(bareMarker.some((issue) => /缺少 packet DOI/u.test(issue)), true);

  const missingTitle = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文中的受控主张。\n\n参考文献\n- [source:s-1] https://example.com/source-doi 10.1234/allowed',
  );
  assert.equal(missingTitle.some((issue) => /缺少 packet title/u.test(issue)), true);

  const missingUrl = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文中的受控主张。\n\n参考文献\n- [source:s-1] 可核验来源标题 10.1234/allowed',
  );
  assert.equal(missingUrl.some((issue) => /缺少 packet 原始 URL/u.test(issue)), true);

  const missingDoi = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文中的受控主张。\n\n参考文献\n- [source:s-1] 可核验来源标题 https://example.com/source-doi',
  );
  assert.equal(missingDoi.some((issue) => /缺少 packet DOI/u.test(issue)), true);
});

test('参考文献字段不能跨 bullet 串线；同一条非 bullet 续行仍属于同一条目', () => {
  const request = payload({
    researchPacket: {
      sources: [
        { sourceId: 's-1', title: '来源一', url: 'https://example.com/source-1' },
        { sourceId: 's-2', title: '来源二', url: 'https://example.com/source-2' },
      ],
      claims: [{ claimId: 'c-1', text: '受控主张', sourceIds: ['s-1'] }],
      uncertainties: [],
    },
  });
  const crossBullet = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文中的受控主张。\n\n参考文献\n- [source:s-1] 来源一\n- [source:s-2] 来源二 https://example.com/source-1',
  );
  assert.equal(crossBullet.some((issue) => /s-1 缺少 packet 原始 URL/u.test(issue)), true);
  assert.equal(crossBullet.some((issue) => /s-2 缺少 packet 原始 URL/u.test(issue)), true);

  const continued = evidenceCitationBoundIssues(
    request,
    '[c-1] 正文中的受控主张。\n\n参考文献\n[source:s-1] 来源一\nhttps://example.com/source-1',
  );
  assert.deepEqual(continued, []);
});

test('HTTP 第 N 个长文 section 失败时，已有 document 的 revision/latest/hash 完全不变', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-v37-atomic-section-'));
  let phase = 'baseline';
  let continuationCalls = 0;
  const baselineDraft = draft(700);
  const server = createBridgeServer({
    port: 0,
    contentStorePath: directory,
    runsPath: path.join(directory, 'runs'),
    memoryPath: path.join(directory, 'writing-memory.json'),
    statusProvider: async () => ({ ok: true }),
    runner: async (_prompt, context) => {
      if (phase === 'baseline') return responseFor(context.payload, context.stage === 'writing'
        ? baselineDraft
        : context.writer?.draft ?? baselineDraft);
      if (context.stage === 'writing') return responseFor(context.payload, draft(5_000));
      if (context.stage === 'writing_continuation') {
        continuationCalls += 1;
        if (continuationCalls === 3) throw new Error('simulated section failure');
        return continuation(context.payload, continuationCalls, 3_500);
      }
      throw new Error('quality review must not run after section failure');
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const created = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: contentRequestBody({ targetLength: 600 }),
    });
    assert.equal(created.status, 200);
    const documentId = created.body.documentId;
    const before = await httpJson(port, `/v2/content/${encodeURIComponent(documentId)}`);
    assert.equal(before.status, 200);
    const beforeState = {
      revisions: before.body.revisions.length,
      latestRevisionId: before.body.latestRevisionId,
      latestContentHash: before.body.latestContentHash,
      latestDraftHash: before.body.revisions.find((item) => item.revisionId === before.body.latestRevisionId)?.contentHash,
    };
    phase = 'fail-section';
    const failed = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: contentRequestBody({
        targetLength: TARGET,
        clientRunId: 'v37-http-section-failure',
        documentId,
        baseRevisionId: before.body.latestRevisionId,
      }),
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'writing_failed');
    assert.equal(continuationCalls, 3);
    const after = await httpJson(port, `/v2/content/${encodeURIComponent(documentId)}`);
    assert.equal(after.status, 200);
    assert.deepEqual({
      revisions: after.body.revisions.length,
      latestRevisionId: after.body.latestRevisionId,
      latestContentHash: after.body.latestContentHash,
      latestDraftHash: after.body.revisions.find((item) => item.revisionId === after.body.latestRevisionId)?.contentHash,
    }, beforeState);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('HTTP 长文 reviewer hash 错误时，已有 document 不追加 revision 且 latest/hash 保持不变', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-v37-atomic-review-'));
  let phase = 'baseline';
  let continuationCalls = 0;
  const baselineDraft = draft(700);
  const server = createBridgeServer({
    port: 0,
    contentStorePath: directory,
    runsPath: path.join(directory, 'runs'),
    memoryPath: path.join(directory, 'writing-memory.json'),
    statusProvider: async () => ({ ok: true }),
    runner: async (_prompt, context) => {
      if (phase === 'baseline') return responseFor(context.payload, context.stage === 'writing'
        ? baselineDraft
        : context.writer?.draft ?? baselineDraft);
      if (context.stage === 'writing') return responseFor(context.payload, draft(5_000));
      if (context.stage === 'writing_continuation') {
        continuationCalls += 1;
        return continuation(context.payload, continuationCalls, 3_500);
      }
      if (context.stage === 'quality_review') {
        return compactReviewFor(context.payload, context.writer.draft, { draftHash: '0'.repeat(64) });
      }
      throw new Error('unexpected stage');
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const port = server.address().port;
    const created = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: contentRequestBody({ targetLength: 600 }),
    });
    assert.equal(created.status, 200);
    const documentId = created.body.documentId;
    const before = await httpJson(port, `/v2/content/${encodeURIComponent(documentId)}`);
    const beforeState = {
      revisions: before.body.revisions.length,
      latestRevisionId: before.body.latestRevisionId,
      latestContentHash: before.body.latestContentHash,
    };
    phase = 'review-hash';
    const failed = await httpJson(port, '/v1/content', {
      method: 'POST',
      body: contentRequestBody({
        targetLength: TARGET,
        clientRunId: 'v37-http-review-hash-failure',
        documentId,
        baseRevisionId: before.body.latestRevisionId,
      }),
    });
    assert.equal(failed.status, 502);
    assert.equal(failed.body.code, 'review_failed');
    assert.equal(continuationCalls, 4);
    const after = await httpJson(port, `/v2/content/${encodeURIComponent(documentId)}`);
    assert.equal(after.status, 200);
    assert.deepEqual({
      revisions: after.body.revisions.length,
      latestRevisionId: after.body.latestRevisionId,
      latestContentHash: after.body.latestContentHash,
    }, beforeState);
  } finally {
    const closed = once(server, 'close');
    server.close();
    await closed;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
