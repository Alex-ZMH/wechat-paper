import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { createBrief } from '../src/contracts/brief.mjs';
import {
  fetchBridgeEvidenceEnvelope,
  runCodexResearchRecovery,
  validateResearchRecoveryCandidate,
} from '../src/adapters/bridge-research.mjs';

const brief = createBrief({
  topic: '凹凸棒石在新能源领域面临的挑战与实际应用',
  purpose: '评估技术与产业化可行性',
  audience: '投资人',
  materials: [],
});

function candidate(overrides = {}) {
  return {
    schemaVersion: 'content-desk.research-candidate.v1',
    status: 'audit_failed',
    topic: brief.topic,
    sources: [
      {
        sourceId: 's-1',
        title: '公开论文',
        url: 'https://example.test/paper',
        publisher: 'Example Journal',
        publishedAt: '2024-01-02',
        sourceType: 'paper',
        authority: 'A',
        auditStatus: 'pass',
      },
      {
        sourceId: 's-2',
        title: '官方资料',
        url: 'https://example.test/official',
        publisher: 'Example Agency',
        publishedAt: '2024-02-03',
        sourceType: 'official',
        authority: 'A',
        auditStatus: 'pass',
      },
    ],
    claims: [
      {
        claimId: 'c-1',
        text: '凹凸棒石具有可核验的材料特征。',
        sourceIds: ['s-1'],
        confidence: 'high',
        status: 'supported',
        auditStatus: 'supported',
      },
      {
        claimId: 'c-2',
        text: '其产业化路径仍需结合应用条件判断。',
        sourceIds: ['s-1', 's-2'],
        confidence: 'medium',
        status: 'supported',
        auditStatus: 'mixed',
      },
    ],
    ...overrides,
  };
}

function failedResponse(value) {
  return {
    ok: false,
    status: 422,
    json: async () => ({
      code: 'research_audit_failed',
      error: '来源审计未通过，证据包未冻结',
      stage: 'research_audit',
      candidate: value,
    }),
  };
}

test('audited candidate with complete recovery excerpts becomes realtime EvidencePacket', async () => {
  const events = [];
  let called = false;
  const result = await fetchBridgeEvidenceEnvelope(brief, {
    clientRunId: 'recovery-success',
    fetchImpl: async () => failedResponse(candidate()),
    recoveryRunner: async (value, context) => {
      called = true;
      assert.equal(value.topic, brief.topic);
      assert.equal(typeof context.signal?.aborted, 'boolean');
      context.onProgress?.({ stage: 'research_recovery' });
      return {
        sources: [
          { sourceId: 's-1', excerpt: '原文摘录一。', locator: '第 2 页，表 1' },
          { sourceId: 's-2', excerpt: '原文摘录二。', locator: '第 4 节' },
        ],
      };
    },
    onTrace: (event) => events.push(event),
  });
  assert.equal(called, true);
  assert.equal(result.packet.sources.length, 2);
  assert.equal(result.packet.sources[0].sourceOrigin, 'realtime_research');
  assert.equal(result.packet.sources[0].title, '公开论文');
  assert.equal(result.packet.sources[0].locator, '第 2 页，表 1');
  assert.deepEqual(result.packet.claims[1].evidenceIds, ['s-1', 's-2']);
  assert.ok(events.some((event) => event.event === 'research_recovery_started'));
  assert.ok(events.some((event) => event.event === 'research_recovery_completed'));
  assert.ok(events.some((event) => event.event === 'research_complete' && event.recovery === true));
});

test('inconsistent candidate is rejected without invoking local recovery', async () => {
  let called = false;
  const invalid = candidate({
    claims: [{
      claimId: 'c-1',
      text: '未绑定候选来源。',
      sourceIds: ['missing-source'],
      auditStatus: 'supported',
    }],
  });
  assert.equal(validateResearchRecoveryCandidate(invalid, brief).eligible, false);
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      fetchImpl: async () => failedResponse(invalid),
      recoveryRunner: async () => { called = true; return { sources: [] }; },
    }),
    (error) => error.code === 'research_audit_failed' && error.details.recovery === undefined,
  );
  assert.equal(called, false);
});

test('missing recovery excerpt remains a real audit failure', async () => {
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      fetchImpl: async () => failedResponse(candidate()),
      recoveryRunner: async () => ({
        sources: [
          { sourceId: 's-1', excerpt: '只有第一条。', locator: '第 1 页' },
          { sourceId: 's-2', excerpt: '', locator: '未知' },
        ],
      }),
    }),
    (error) => error.code === 'research_audit_failed'
      && error.details.recovery?.code === 'research_recovery_excerpt_missing',
  );
});

test('recovery runner failure remains a real audit failure', async () => {
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      fetchImpl: async () => failedResponse(candidate()),
      recoveryRunner: async () => { throw new Error('Codex unavailable'); },
    }),
    (error) => error.code === 'research_audit_failed'
      && error.details.recovery?.code === 'research_recovery_failed',
  );
});

test('local Codex recovery runner opts into search and honors the caller signal', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stdin = { end(prompt) { assert.match(prompt, /只能访问这些 URL/); } };
  child.stderr = new EventEmitter();
  child.kill = () => {};
  const output = JSON.stringify({ sources: [
    { sourceId: 's-1', excerpt: '摘录一', locator: '第 1 页' },
    { sourceId: 's-2', excerpt: '摘录二', locator: '第 2 页' },
  ] });
  const result = await runCodexResearchRecovery(candidate(), {
    executable: 'codex.exe',
    schemaPath: 'recovery.schema.json',
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
    mkdtempImpl: async () => 'C:\\temp\\recovery-test',
    readFileImpl: async () => output,
    rmImpl: async () => {},
  });
  assert.deepEqual(result.sources.map((item) => item.sourceId), ['s-1', 's-2']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.includes('--search'), true);
  assert.ok(calls[0].args.indexOf('--search') < calls[0].args.indexOf('exec'));
});
