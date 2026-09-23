import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrief } from '../src/contracts/brief.mjs';
import { fetchBridgeEvidence, fetchBridgeEvidenceEnvelope, normalizeBridgeEvidencePacket, toBridgeResearchRequest } from '../src/adapters/bridge-research.mjs';
import { styleProfileFromMarkdown } from '../src/adapters/style-profile-loader.mjs';

const brief = createBrief({
  topic: '证据驱动的公众号写作',
  purpose: '把事实、论点和人工批注接成一条可复核的生产线。',
  audience: '需要写深度文章的编辑',
  materials: [{ materialId: 'm-1', text: '优先使用可核验的一手材料。' }],
});

const bridgePacket = {
  schemaVersion: 'content-desk.evidence-packet.v1',
  packetId: 'ep-demo-1',
  packetHash: 'a'.repeat(64),
  topic: brief.topic,
  researchStatus: 'complete',
  retrievalStatus: 'complete',
  auditPassed: true,
  unresolvedCriticalClaims: 0,
  audit: { status: 'passed', auditorModel: 'fixture', summary: 'fixture passed' },
  sources: [{ sourceId: 's-1', title: '一手资料', url: 'https://example.test/source', publisher: 'Example', excerpt: '可核验的原文摘录。', sourceOrigin: 'realtime_research' }],
  claims: [{ claimId: 'c-1', text: '主张必须可以回到原文摘录。', sourceIds: ['s-1'], confidence: 'high', status: 'supported', kind: 'fact' }],
};

test('bridge request adapter keeps the core contract provider-neutral', () => {
  const request = toBridgeResearchRequest(brief, { clientRunId: 'run-1' });
  assert.equal(request.schemaVersion, 'content-desk.research-request.v1');
  assert.equal(request.topic, brief.topic);
  assert.deepEqual(request.include, ['优先使用可核验的一手材料。']);
  assert.equal(request.clientRunId, 'run-1');
});

test('audited Bridge packet maps into local EvidencePacket', async () => {
  const packet = normalizeBridgeEvidencePacket(brief, bridgePacket);
  assert.equal(packet.sources[0].excerpt, '可核验的原文摘录。');
  assert.equal(packet.sources[0].sourceOrigin, 'realtime_research');
  assert.equal(packet.claims[0].evidenceIds[0], 's-1');
  assert.equal(packet.claims[0].confidence, 0.9);

  const received = await fetchBridgeEvidence(brief, {
    fetchImpl: async (_url, options) => {
      assert.equal(options.method, 'POST');
      return { ok: true, status: 200, json: async () => bridgePacket };
    },
  });
  assert.equal(received.packetId, packet.packetId);

  const envelope = await fetchBridgeEvidenceEnvelope(brief, {
    clientRunId: 'run-success-1',
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).clientRunId, 'run-success-1');
      return { ok: true, status: 200, json: async () => bridgePacket };
    },
  });
  assert.equal(envelope.clientRunId, 'run-success-1');
});

test('unverified Bridge packets never enter the writing pipeline', () => {
  assert.throws(
    () => normalizeBridgeEvidencePacket(brief, { ...bridgePacket, audit: { status: 'failed' } }),
    (error) => error.code === 'research_unverified',
  );
  assert.throws(
    () => normalizeBridgeEvidencePacket(brief, { ...bridgePacket, unresolvedCriticalClaims: 1 }),
    (error) => error.code === 'research_unverified',
  );
});

test('source-free Bridge opinions do not invalidate audited evidence', () => {
  const packet = normalizeBridgeEvidencePacket(brief, {
    ...bridgePacket,
    claims: [
      ...bridgePacket.claims,
      {
        claimId: 'c-opinion',
        text: '这是没有证据绑定的建议。',
        sourceIds: [],
        evidence: [],
        confidence: 'medium',
        status: 'supported',
        kind: 'opinion',
      },
    ],
  });
  assert.deepEqual(packet.claims.map((claim) => claim.claimId), ['c-1']);
});

test('Bridge research timeout is bounded and classified without fallback', async () => {
  let researchRunId;
  let cancelledRunId;
  await assert.rejects(
    () => fetchBridgeEvidence(brief, {
      timeoutMs: 10,
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        researchRunId = JSON.parse(options.body).clientRunId;
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted by test timeout');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
      cancelImpl: async (_url, options) => {
        cancelledRunId = JSON.parse(options.body).clientRunId;
        return { ok: true };
      },
    }),
    (error) => error.code === 'research_timeout' && error.details.timeoutMs === 10,
  );
  assert.match(researchRunId, /^research-[0-9a-f-]{36}$/u);
  assert.equal(cancelledRunId, researchRunId);
});

test('style DNA markdown becomes an explicit StyleProfile', () => {
  const profile = styleProfileFromMarkdown(`# DNA\n\n## L1 语言\n- **语气**：克制、具体\n\n## L5 认知\n- **核心表达命题**：先限定主张，再说明机制\n\n避免“综上所述”`);
  assert.equal(profile.schemaVersion, 'wechat-article-studio.style-profile.v1');
  assert.ok(profile.principles.some((item) => item.includes('克制')));
  assert.deepEqual(profile.avoid, ['综上所述']);
});
