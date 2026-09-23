import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  RESEARCH_REQUEST_SCHEMA_VERSION,
  buildCodexExecArgs,
  buildWorkflowReceipt,
  contentHash,
  createBridgeServer,
  createEvidencePacketStore,
  runTopicEvidenceResearch,
  validateResearchRequest,
  validateSkillChain,
} from '../server.mjs';

const NOW = '2026-09-01T00:00:00.000Z';

function source(sourceId = 's-1') {
  return {
    sourceId,
    title: '公开官方资料',
    url: `https://example.com/${sourceId}`,
    publisher: 'Example',
    sourceType: 'official',
    authority: 'A',
    publishedAt: null,
    accessedAt: NOW,
    accessStatus: 'accessible',
    usageStatus: 'allowed',
    sourceFamilyId: null,
    excerpt: '这是用于核对主张的公开短摘录。',
    locator: '正文第 1 段',
    contentHash: null,
  };
}

function claim(claimId = 'c-1', sourceId = 's-1') {
  return {
    claimId,
    text: '公开资料明确描述了一个可核对的事实。',
    kind: 'fact',
    sourceIds: [sourceId],
    evidence: [{ sourceId, excerpt: '这是用于核对主张的公开短摘录。', locator: '正文第 1 段' }],
    confidence: 'high',
    status: 'supported',
    basis: null,
  };
}

function researchStage() {
  return {
    schemaVersion: 'content-desk.research-result.v1',
    status: 'complete',
    topic: '工业智能体',
    scope: { question: '工业智能体的公开证据', cutoff: '2026-09-01' },
    retrieval: { queries: ['工业智能体'], mode: 'codex-cli-search', startedAt: NOW, completedAt: NOW },
    sources: [source()],
    claims: [claim()],
    uncertainties: [],
  };
}

function researchAudit() {
  return {
    schemaVersion: 'content-desk.research-audit.v1',
    status: 'passed',
    auditorModel: 'ignored-by-bridge',
    auditedAt: NOW,
    sourceChecks: [{ sourceId: 's-1', status: 'pass', issues: [] }],
    claimChecks: [{ claimId: 'c-1', status: 'supported', issues: [] }],
    issues: [],
    summary: '来源和主张均可回溯。',
    independence: '审计阶段未读取研究阶段评分。',
  };
}

function request(overrides = {}) {
  return {
    schemaVersion: RESEARCH_REQUEST_SCHEMA_VERSION,
    topic: '工业智能体',
    purpose: '判断公开资料支持的事实边界',
    audience: '研发管理者',
    domain: '工业研发',
    genre: '调研报告',
    channel: 'wechat',
    cutoff: '2026-09-01',
    depth: 'standard',
    ...overrides,
  };
}

function httpJson(port, route, { method = 'GET', body } = {}) {
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
}

test('research skill is pinned first and produces one exact packet_frozen workflow receipt', () => {
  assert.throws(
    () => validateSkillChain(['writing-dna', 'topic-evidence-research']),
    /必须位于 skillChain 首位/,
  );
  const receipt = buildWorkflowReceipt({
    mode: 'initial_generation',
    skillChain: ['topic-evidence-research', 'writing-dna'],
    evidencePacketId: 'ep-one',
    evidencePacketHash: 'a'.repeat(64),
  }, {
    status: 'succeeded',
    draft: '正文',
    qualityReview: { passed: true, editorialScore: { total: 99, threshold: 99 }, issues: [] },
  });
  const evidenceNodes = receipt.nodes.filter((node) => node.nodeId === 'skill:topic-evidence-research');
  assert.equal(evidenceNodes.length, 1);
  assert.equal(evidenceNodes[0].verb, 'packet_frozen');
  assert.equal(evidenceNodes[0].artifactHash, 'a'.repeat(64));
});

async function withServer(options, callback) {
  const server = createBridgeServer({ port: 0, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { return await callback(server.address().port); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('research request is bounded and search flag is opt-in', () => {
  assert.equal(validateResearchRequest(request()).depth, 'standard');
  assert.throws(() => validateResearchRequest(request({ schemaVersion: 'wrong' })), /schemaVersion/);
  const ordinary = buildCodexExecArgs({ outputSchema: 'x', outputPath: 'y' });
  const search = buildCodexExecArgs({ outputSchema: 'x', outputPath: 'y', search: true });
  assert.equal(ordinary.includes('--search'), false);
  assert.equal(search.includes('--search'), true);
  assert.ok(search.indexOf('--search') < search.indexOf('exec'));
});

test('two structured stages produce a server-hashable frozen packet', async () => {
  const calls = [];
  const packet = await runTopicEvidenceResearch(request(), {
    runner: async (_prompt, context) => {
      calls.push(context.stage);
      return {
        ...researchStage(),
        retrieval: { ...researchStage().retrieval, mode: 'model-claimed-mode', startedAt: 'not-a-date', completedAt: 'not-a-date' },
        sources: [{ ...source(), publishedAt: '2024-07', accessedAt: 'not-a-date' }],
      };
    },
    auditor: async (_prompt, context) => {
      calls.push(context.stage);
      return researchAudit();
    },
  });
  assert.deepEqual(calls, ['research', 'research_audit']);
  assert.equal(packet.schemaVersion, 'content-desk.evidence-packet.v1');
  assert.equal(packet.audit.status, 'passed');
  assert.equal(packet.retrieval.mode, 'codex-cli-search');
  assert.notEqual(packet.retrieval.startedAt, 'not-a-date');
  assert.notEqual(packet.sources[0].accessedAt, 'not-a-date');
  assert.equal(packet.sources[0].publishedAt, null);
  assert.equal(packet.packetHash, contentHash(JSON.stringify({ ...packet, packetHash: undefined })));
});

test('audit failure repairs the complete research result and freezes only after a passing retry', async () => {
  const badSource = {
    ...source(),
    sourceId: 's-bad',
    title: '无法核验的来源',
    url: 'https://example.com/bad-source',
  };
  const brokenStage = {
    ...researchStage(),
    sources: [source(), badSource],
    claims: [{
      ...claim(),
      text: '未经核验的主张。',
      sourceIds: ['s-bad'],
      evidence: [{ sourceId: 's-bad', excerpt: badSource.excerpt, locator: badSource.locator }],
    }],
  };
  const repairedStage = {
    ...researchStage(),
    claims: [{
      ...claim(),
      claimId: 'c-2',
      text: '修正后的主张由公开资料支持。',
      sourceIds: ['s-1'],
      evidence: [{ sourceId: 's-1', excerpt: source().excerpt, locator: source().locator }],
    }],
  };
  const stages = [];
  const runnerCalls = [];
  const auditorCalls = [];
  const packet = await runTopicEvidenceResearch(request(), {
    onStage: (stage) => stages.push(stage),
    runner: async (prompt, context) => {
      runnerCalls.push({ prompt, context });
      if (context.stage === 'research') return brokenStage;
      if (context.stage === 'research_repair') return repairedStage;
      assert.fail(`unexpected research runner stage: ${context.stage}`);
    },
    auditor: async (prompt, context) => {
      auditorCalls.push({ prompt, context });
      if (context.stage === 'research_audit') {
        return {
          ...researchAudit(),
          status: 'failed',
          sourceChecks: [
            { sourceId: 's-1', status: 'pass', issues: [] },
            { sourceId: 's-bad', status: 'manual', issues: ['来源不可核验'] },
          ],
          claimChecks: [{ sourceId: 's-bad', claimId: 'c-1', status: 'unverified', issues: ['主张证据不足'] }],
        };
      }
      if (context.stage === 'research_audit_retry') {
        return {
          ...researchAudit(),
          claimChecks: [{ claimId: 'c-2', status: 'supported', issues: [] }],
        };
      }
      assert.fail(`unexpected research auditor stage: ${context.stage}`);
    },
  });

  assert.deepEqual(stages, [
    'research_retrieval',
    'research_audit',
    'research_repair',
    'research_audit_retry',
    'research_freeze',
  ]);
  assert.deepEqual(runnerCalls.map(({ context }) => context.stage), ['research', 'research_repair']);
  assert.deepEqual(auditorCalls.map(({ context }) => context.stage), ['research_audit', 'research_audit_retry']);
  assert.deepEqual(runnerCalls.map(({ context }) => context.modelLabel), ['writerModel', 'writerModel']);
  assert.deepEqual(auditorCalls.map(({ context }) => context.modelLabel), ['reviewerModel', 'reviewerModel']);
  assert.deepEqual(runnerCalls.map(({ context }) => context.search), [true, true]);
  assert.deepEqual(auditorCalls.map(({ context }) => context.search), [true, true]);
  assert.equal(runnerCalls[1].context.repairAttempt, 1);
  assert.deepEqual(auditorCalls.map(({ context }) => context.auditAttempt), [1, 2]);
  assert.match(runnerCalls[1].prompt, /schemaVersion=content-desk\.research-result\.v1/u);
  assert.match(auditorCalls[1].prompt, /schemaVersion=content-desk\.research-audit\.v1/u);
  assert.equal(packet.audit.status, 'passed');
  assert.equal(packet.sources.some((item) => item.sourceId === 's-bad'), false);
  assert.equal(packet.claims.length, 1);
  assert.equal(packet.claims[0].claimId, 'c-2');
  assert.equal(packet.claims[0].text, '修正后的主张由公开资料支持。');
  assert.equal(packet.packetHash.length, 64);
});

test('repair output cannot reintroduce audited ids or dangling source references', async () => {
  const goodSource = source('s-good');
  const badSource = source('s-bad');
  const goodClaim = claim('c-good', 's-good');
  const badClaim = claim('c-bad', 's-bad');
  const brokenStage = {
    ...researchStage(),
    sources: [goodSource, badSource],
    claims: [goodClaim, badClaim],
  };
  const repairIgnoredAudit = {
    ...brokenStage,
    uncertainties: [{
      uncertaintyId: 'u-repair',
      text: '部分来源仍需人工核对。',
      claimIds: ['c-good', 'c-dangling'],
      action: '复核公开正文。',
    }],
    claims: [
      ...brokenStage.claims,
      claim('c-dangling', 's-missing'),
      {
        ...claim('c-evidence-dangling', 's-good'),
        evidence: [{ sourceId: 's-missing', excerpt: '不存在来源的摘录。', locator: null }],
      },
    ],
  };
  const calls = [];
  const packet = await runTopicEvidenceResearch(request(), {
    runner: async (_prompt, context) => {
      calls.push({ stage: context.stage, researchResult: context.researchResult });
      return context.stage === 'research' ? brokenStage : repairIgnoredAudit;
    },
    auditor: async (_prompt, context) => {
      calls.push({ stage: context.stage, researchResult: context.researchResult });
      if (context.stage === 'research_audit') {
        return {
          ...researchAudit(),
          status: 'failed',
          sourceChecks: [
            { sourceId: 's-good', status: 'pass', issues: [] },
            { sourceId: 's-bad', status: 'manual', issues: ['来源不可核验'] },
          ],
          claimChecks: [
            { claimId: 'c-good', status: 'supported', issues: [] },
            { claimId: 'c-bad', status: 'unverified', issues: ['主张证据不足'] },
          ],
        };
      }
      assert.deepEqual(context.researchResult.sources.map((item) => item.sourceId), ['s-good']);
      assert.deepEqual(context.researchResult.claims.map((item) => item.claimId), ['c-good']);
      assert.equal(context.researchResult.sources.some((item) => item.sourceId === 's-bad'), false);
      assert.equal(context.researchResult.claims.some((item) => item.claimId === 'c-bad'), false);
      assert.equal(context.researchResult.claims.some((item) => item.claimId === 'c-dangling'), false);
      assert.equal(context.researchResult.claims.some((item) => item.claimId === 'c-evidence-dangling'), false);
      assert.deepEqual(context.researchResult.uncertainties[0].claimIds, ['c-good']);
      return {
        ...researchAudit(),
        sourceChecks: [{ sourceId: 's-good', status: 'pass', issues: [] }],
        claimChecks: [{ claimId: 'c-good', status: 'supported', issues: [] }],
      };
    },
  });
  assert.equal(packet.audit.status, 'passed');
  assert.deepEqual(packet.sources.map((item) => item.sourceId), ['s-good']);
  assert.deepEqual(packet.claims.map((item) => item.claimId), ['c-good']);
  assert.deepEqual(packet.uncertainties[0].claimIds, ['c-good']);
  assert.deepEqual(calls.map((item) => item.stage), ['research', 'research_audit', 'research_repair', 'research_audit_retry']);
});

test('repair that leaves no claims fails explicitly and never reaches the auditor again', async () => {
  const failedStage = {
    ...researchStage(),
    sources: [source('s-bad')],
    claims: [claim('c-bad', 's-bad')],
  };
  const stages = [];
  const auditorCalls = [];
  await assert.rejects(
    runTopicEvidenceResearch(request(), {
      onStage: (stage) => stages.push(stage),
      runner: async (_prompt, context) => context.stage === 'research' ? failedStage : failedStage,
      auditor: async (_prompt, context) => {
        auditorCalls.push(context);
        return {
          ...researchAudit(),
          status: 'failed',
          sourceChecks: [{ sourceId: 's-bad', status: 'manual', issues: ['来源不可核验'] }],
          claimChecks: [{ claimId: 'c-bad', status: 'unverified', issues: ['主张证据不足'] }],
        };
      },
    }),
    (error) => {
      assert.equal(error.code, 'research_repair_insufficient');
      assert.equal(error.stage, 'research_repair');
      assert.deepEqual(error.details.sourceFailures, ['s-bad']);
      assert.deepEqual(error.details.claimFailures, ['c-bad']);
      assert.deepEqual(error.details.removedSourceIds, ['s-bad']);
      assert.deepEqual(error.details.removedClaimIds, ['c-bad']);
      assert.equal(error.details.remainingSourceCount, 0);
      assert.equal(error.details.remainingClaimCount, 0);
      assert.equal(error.details.reason, 'no_claims');
      return true;
    },
  );
  assert.deepEqual(stages, ['research_retrieval', 'research_audit', 'research_repair']);
  assert.equal(auditorCalls.length, 1);
});

test('three failed audits stop after two repairs and never fabricate a packet', async () => {
  const stages = [];
  const runnerCalls = [];
  const auditorCalls = [];

  await assert.rejects(
    runTopicEvidenceResearch(request(), {
      onStage: (stage) => stages.push(stage),
      runner: async (prompt, context) => {
        runnerCalls.push({ prompt, context });
        assert.ok(context.stage === 'research' || context.stage === 'research_repair');
        if (context.stage === 'research') return researchStage();
        const id = context.repairAttempt + 1;
        if (context.repairAttempt === 2) {
          const renamedRejectedSource = {
            ...source('s-reintroduced'),
            // Same canonical URL as the first audited source, with a case,
            // default port, and fragment variation that must not evade the
            // cumulative source-identity quarantine.
            url: 'https://EXAMPLE.com:443/s-1#fragment',
          };
          return {
            ...researchStage(),
            sources: [renamedRejectedSource, source('s-3')],
            claims: [
              claim('c-reintroduced', 's-reintroduced'),
              // The first rejected claim id is also reused with a valid new
              // source; cumulative claim-id quarantine must still remove it.
              claim('c-1', 's-3'),
              claim('c-3', 's-3'),
            ],
          };
        }
        return {
          ...researchStage(),
          sources: [source(`s-${id}`)],
          claims: [claim(`c-${id}`, `s-${id}`)],
        };
      },
      auditor: async (prompt, context) => {
        auditorCalls.push({ prompt, context });
        const id = context.auditAttempt;
        if (context.auditAttempt === 3) {
          assert.deepEqual(context.researchResult.sources.map((item) => item.sourceId), ['s-3']);
          assert.deepEqual(context.researchResult.claims.map((item) => item.claimId), ['c-3']);
        }
        return {
          ...researchAudit(),
          status: 'failed',
          sourceChecks: [{ sourceId: `s-${id}`, status: 'manual', issues: [`第 ${id} 轮仍需人工复核`] }],
          claimChecks: [{ claimId: `c-${id}`, status: 'unverified', issues: [`第 ${id} 轮主张仍未支持`] }],
        };
      },
    }),
    (error) => {
      assert.equal(error.code, 'research_audit_failed');
      assert.deepEqual(error.details.sourceFailures, ['s-3']);
      assert.deepEqual(error.details.claimFailures, ['c-3']);
      assert.equal(error.details.researchCandidate.schemaVersion, 'content-desk.research-candidate.v1');
      assert.equal(error.details.researchCandidate.status, 'audit_failed');
      assert.equal(error.details.researchCandidate.sources[0].auditStatus, 'manual');
      assert.equal(error.details.researchCandidate.claims[0].auditStatus, 'unverified');
      assert.equal('packetId' in error.details.researchCandidate, false);
      assert.equal('packetHash' in error.details.researchCandidate, false);
      return true;
    },
  );

  assert.deepEqual(stages, [
    'research_retrieval',
    'research_audit',
    'research_repair',
    'research_audit_retry',
    'research_repair',
    'research_audit_retry',
  ]);
  assert.deepEqual(runnerCalls.map(({ context }) => context.stage), ['research', 'research_repair', 'research_repair']);
  assert.deepEqual(runnerCalls.map(({ context }) => context.modelLabel), ['writerModel', 'writerModel', 'writerModel']);
  assert.deepEqual(runnerCalls.map(({ context }) => context.search), [true, true, true]);
  assert.deepEqual(runnerCalls.map(({ context }) => context.repairAttempt), [undefined, 1, 2]);
  assert.deepEqual(auditorCalls.map(({ context }) => context.stage), ['research_audit', 'research_audit_retry', 'research_audit_retry']);
  assert.deepEqual(auditorCalls.map(({ context }) => context.modelLabel), ['reviewerModel', 'reviewerModel', 'reviewerModel']);
  assert.deepEqual(auditorCalls.map(({ context }) => context.search), [true, true, true]);
  assert.deepEqual(auditorCalls.map(({ context }) => context.auditAttempt), [1, 2, 3]);
  assert.equal(stages.includes('research_freeze'), false);
});

test('third source-only audit failure is quarantined and independently re-audited before freeze', async () => {
  const good = source('s-good');
  const stages = [];
  const runnerCalls = [];
  const auditorCalls = [];
  const stageWithBadSource = (badId) => ({
    ...researchStage(),
    sources: [good, source(badId)],
    claims: [claim('c-good', 's-good')],
  });

  const packet = await runTopicEvidenceResearch(request(), {
    onStage: (stage) => stages.push(stage),
    runner: async (_prompt, context) => {
      runnerCalls.push(context);
      if (context.stage === 'research') return stageWithBadSource('s-bad-1');
      return stageWithBadSource(`s-bad-${context.repairAttempt + 1}`);
    },
    auditor: async (_prompt, context) => {
      auditorCalls.push(context);
      const ids = context.researchResult.sources.map((item) => item.sourceId);
      if (context.auditAttempt === 4) {
        assert.deepEqual(ids, ['s-good']);
        assert.deepEqual(context.researchResult.claims.map((item) => item.claimId), ['c-good']);
        return {
          ...researchAudit(),
          sourceChecks: [{ sourceId: 's-good', status: 'pass', issues: [] }],
          claimChecks: [{ claimId: 'c-good', status: 'supported', issues: [] }],
        };
      }
      const badId = `s-bad-${context.auditAttempt}`;
      assert.deepEqual(ids, ['s-good', badId]);
      return {
        ...researchAudit(),
        status: 'failed',
        sourceChecks: [
          { sourceId: 's-good', status: 'pass', issues: [] },
          { sourceId: badId, status: 'manual', issues: ['公开正文无法稳定核验'] },
        ],
        claimChecks: [{ claimId: 'c-good', status: 'supported', issues: [] }],
      };
    },
  });

  assert.deepEqual(stages, [
    'research_retrieval',
    'research_audit',
    'research_repair',
    'research_audit_retry',
    'research_repair',
    'research_audit_retry',
    'research_repair',
    'research_audit_retry',
    'research_freeze',
  ]);
  assert.deepEqual(runnerCalls.map((item) => item.stage), ['research', 'research_repair', 'research_repair']);
  assert.deepEqual(auditorCalls.map((item) => item.auditAttempt), [1, 2, 3, 4]);
  assert.deepEqual(packet.sources.map((item) => item.sourceId), ['s-good']);
  assert.deepEqual(packet.claims.map((item) => item.claimId), ['c-good']);
  assert.deepEqual(packet.audit.sourceChecks.map((item) => item.sourceId), ['s-good']);
  assert.equal(packet.audit.status, 'passed');
  assert.equal(packet.packetHash.length, 64);
});

test('audit failure exposes a quarantined stage artifact without creating a writable evidence packet', async () => {
  await assert.rejects(
    runTopicEvidenceResearch(request(), {
      runner: async (_prompt, context) => context.stage === 'research'
        ? researchStage()
        : { ...researchStage(), sources: [source(`s-${context.repairAttempt + 1}`)], claims: [claim(`c-${context.repairAttempt + 1}`, `s-${context.repairAttempt + 1}`)] },
      auditor: async (_prompt, context) => ({
        ...researchAudit(),
        status: 'failed',
        sourceChecks: [{ sourceId: `s-${context.auditAttempt}`, status: 'manual', issues: ['需要人工复核'] }],
        claimChecks: [{ claimId: `c-${context.auditAttempt}`, status: 'unverified', issues: ['证据不足'] }],
      }),
    }),
    (error) => {
      assert.equal(error.code, 'research_audit_failed');
      assert.deepEqual(error.details.sourceFailures, ['s-3']);
      assert.deepEqual(error.details.claimFailures, ['c-3']);
      assert.equal(error.details.researchCandidate.schemaVersion, 'content-desk.research-candidate.v1');
      assert.equal(error.details.researchCandidate.status, 'audit_failed');
      assert.equal(error.details.researchCandidate.sources[0].auditStatus, 'manual');
      assert.equal(error.details.researchCandidate.claims[0].auditStatus, 'unverified');
      assert.equal('packetId' in error.details.researchCandidate, false);
      assert.equal('packetHash' in error.details.researchCandidate, false);
      return true;
    },
  );
});

test('POST /v1/research persists packet and GET returns the same hash', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-research-http-'));
  try {
    await withServer({
      evidencePacketPath: directory,
      researchRunner: async () => ({
        schemaVersion: 'content-desk.evidence-packet.v1',
        packetId: 'ep-http',
        topic: '工业智能体',
        scope: { question: '工业智能体', cutoff: '2026-09-01' },
        retrieval: researchStage().retrieval,
        researchStatus: 'complete',
        retrievalStatus: 'complete',
        createdAt: NOW,
        sources: [source()],
        claims: [claim()],
        uncertainties: [],
        audit: {
          status: 'passed', auditorModel: 'test', auditedAt: NOW,
          sourceChecks: [{ sourceId: 's-1', status: 'pass', issues: [] }],
          claimChecks: [{ claimId: 'c-1', status: 'supported', issues: [] }],
          issues: [], summary: 'ok', independence: 'test',
        },
      }),
    }, async (port) => {
      const created = await httpJson(port, '/v1/research', { method: 'POST', body: request() });
      assert.equal(created.status, 200);
      assert.equal(created.body.packetId, 'ep-http');
      assert.equal(created.body.packetHash.length, 64);
      assert.equal(created.body.sourceCount, 1);
      const loaded = await httpJson(port, '/v1/research/packets/ep-http');
      assert.equal(loaded.status, 200);
      assert.equal(loaded.body.packetHash, created.body.packetHash);
      const missing = await httpJson(port, '/v1/research/packets/ep-missing');
      assert.equal(missing.status, 404);
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('research audit failure is fail-closed and leaves no packet', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-research-fail-'));
  try {
    await withServer({
      evidencePacketPath: directory,
      researchRunner: async () => {
        throw Object.assign(new Error('audit failed'), { status: 422, code: 'research_audit_failed', stage: 'research_audit' });
      },
    }, async (port) => {
      const response = await httpJson(port, '/v1/research', { method: 'POST', body: request() });
      assert.equal(response.status, 502);
      assert.equal(response.body.code, 'research_failed');
      const files = await fs.readdir(directory).catch(() => []);
      assert.deepEqual(files, []);
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('HTTP audit failure returns the quarantined candidate and deterministic failed ids', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-research-candidate-'));
  try {
    await withServer({
      evidencePacketPath: directory,
      researchRunner: async (validatedRequest) => runTopicEvidenceResearch(validatedRequest, {
        runner: async (_prompt, context) => context.stage === 'research'
          ? researchStage()
          : { ...researchStage(), sources: [source(`s-${context.repairAttempt + 1}`)], claims: [claim(`c-${context.repairAttempt + 1}`, `s-${context.repairAttempt + 1}`)] },
        auditor: async (_prompt, context) => ({
          ...researchAudit(),
          status: 'failed',
          sourceChecks: [{ sourceId: `s-${context.auditAttempt}`, status: 'manual', issues: [] }],
          claimChecks: [{ claimId: `c-${context.auditAttempt}`, status: 'unverified', issues: [] }],
        }),
      }),
    }, async (port) => {
      const response = await httpJson(port, '/v1/research', { method: 'POST', body: request() });
      assert.equal(response.status, 422);
      assert.equal(response.body.code, 'research_audit_failed');
      assert.deepEqual(response.body.details.sourceFailures, ['s-3']);
      assert.deepEqual(response.body.details.claimFailures, ['c-3']);
      assert.equal(response.body.candidate.schemaVersion, 'content-desk.research-candidate.v1');
      assert.equal(response.body.candidate.sources[0].auditStatus, 'manual');
      assert.equal(response.body.candidate.claims[0].auditStatus, 'unverified');
      const files = await fs.readdir(directory).catch(() => []);
      assert.deepEqual(files, []);
    });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('research cancellation uses the existing /v1/cancel controller', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-research-cancel-'));
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  try {
    await withServer({
      evidencePacketPath: directory,
      researchRunner: async (_request, { cancelController }) => {
        await blocked;
        cancelController.throwIfCancelled('research');
        return { ...researchStage(), schemaVersion: 'content-desk.evidence-packet.v1', packetId: 'ep-never' };
      },
    }, async (port) => {
      const pending = httpJson(port, '/v1/research', { method: 'POST', body: request({ clientRunId: 'research-cancel-1' }) });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const stopped = await httpJson(port, '/v1/cancel', { method: 'POST', body: { clientRunId: 'research-cancel-1' } });
      assert.equal(stopped.status, 200);
      assert.equal(stopped.body.code, 'cancel_requested');
      release();
      const response = await pending;
      assert.equal(response.status, 409);
      assert.equal(response.body.code, 'cancelled');
    });
  } finally { release?.(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('raw researchPacket cannot satisfy research_writing; packet refs are validated server-side', async () => {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'content-desk-research-ref-'));
  try {
    const store = createEvidencePacketStore({ directory: storeDir });
    const packet = await store.save({
      schemaVersion: 'content-desk.evidence-packet.v1', packetId: 'ep-ref', topic: '工业智能体',
      scope: { question: '工业智能体', cutoff: '2026-09-01' }, retrieval: researchStage().retrieval,
      researchStatus: 'complete', retrievalStatus: 'complete', createdAt: NOW,
      sources: [source()], claims: [claim()], uncertainties: [], audit: {
        status: 'passed', auditorModel: 'test', auditedAt: NOW,
        sourceChecks: [{ sourceId: 's-1', status: 'pass', issues: [] }],
        claimChecks: [{ claimId: 'c-1', status: 'supported', issues: [] }],
        issues: [], summary: 'ok', independence: 'test',
      },
    });
    await withServer({
      evidencePacketStore: store,
      runner: async () => { throw new Error('writer must not be called'); },
    }, async (port) => {
      const base = {
        schemaVersion: 'content-desk.request.v2',
        task: { kind: 'research_writing', domain: '', genre: '', channel: '', purpose: '' },
        mode: 'initial_generation', brief: { topic: '工业智能体' },
      };
      const rawOnly = await httpJson(port, '/v1/content', { method: 'POST', body: { ...base, researchPacket: { sources: [], claims: [], uncertainties: [] } } });
      assert.equal(rawOnly.status, 409);
      assert.equal(rawOnly.body.code, 'evidence_packet_required');
      const wrongHash = await httpJson(port, '/v1/content', { method: 'POST', body: { ...base, evidencePacketId: packet.packetId, evidencePacketHash: '0'.repeat(64) } });
      assert.equal(wrongHash.status, 409);
      assert.equal(wrongHash.body.code, 'evidence_packet_hash_mismatch');
    });
  } finally { await fs.rm(storeDir, { recursive: true, force: true }); }
});
