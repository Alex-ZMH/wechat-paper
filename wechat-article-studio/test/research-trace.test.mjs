import test from 'node:test';
import assert from 'node:assert/strict';

import { createBrief } from '../src/contracts/brief.mjs';
import {
  bridgeProfileReceipt,
  DEFAULT_RESEARCH_TIMEOUT_MS,
  fetchBridgeEvidenceEnvelope,
} from '../src/adapters/bridge-research.mjs';

const brief = createBrief({
  topic: '凹凸棒石在新能源领域面临的挑战与实际应用',
  purpose: '评估技术与产业化可行性',
  audience: '投资人',
  materials: [],
});

const packet = {
  schemaVersion: 'content-desk.evidence-packet.v1',
  packetId: 'ep-trace-1',
  packetHash: 'a'.repeat(64),
  researchStatus: 'complete',
  retrievalStatus: 'complete',
  auditPassed: true,
  unresolvedCriticalClaims: 0,
  audit: { status: 'passed' },
  sources: [{
    sourceId: 's-1',
    title: '一手资料',
    url: 'https://example.test/source',
    excerpt: '可核验的摘录',
  }],
  claims: [{ claimId: 'c-1', text: '主张', sourceIds: ['s-1'], confidence: 'high' }],
};

test('research adapter has no implicit studio wall-clock deadline', () => {
  assert.equal(DEFAULT_RESEARCH_TIMEOUT_MS, undefined);
});

test('profile receipt records provider/model mapping without changing the request', () => {
  assert.deepEqual(bridgeProfileReceipt('codex-sol'), {
    requested: 'codex-sol',
    mapped: { provider: 'codex-cli', model: 'gpt-5.6-sol' },
  });
  assert.equal(bridgeProfileReceipt('unknown').mapped.allowListed, false);
});

test('research hooks expose request, parse and completion stages', async () => {
  const trace = [];
  const progress = [];
  const envelope = await fetchBridgeEvidenceEnvelope(brief, {
    clientRunId: 'trace-success-1',
    writerModel: 'codex-sol',
    reviewerModel: 'codex-sol',
    onTrace: (event) => trace.push(event),
    onProgress: (event) => progress.push(event),
    fetchImpl: async (_url, options) => {
      assert.equal(JSON.parse(options.body).clientRunId, 'trace-success-1');
      return { ok: true, status: 200, json: async () => packet };
    },
  });
  assert.equal(envelope.clientRunId, 'trace-success-1');
  assert.deepEqual(trace.map((item) => item.event), [
    'request_received', 'request_sent', 'response_received', 'response_parsed',
    'source_audit_result', 'research_complete', 'request_finished',
  ]);
  assert.ok(progress.every((item) => item.schemaVersion === 'wechat-article-studio.research-trace.v1'));
  assert.equal(trace.find((item) => item.event === 'request_sent').profileMapping.writer.mapped.model, 'gpt-5.6-sol');
});

test('HTTP 504 is classified as upstream timeout and is not local timeout', async () => {
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      clientRunId: 'trace-upstream-504',
      fetchImpl: async () => ({
        ok: false,
        status: 504,
        json: async () => ({ code: 'gateway_timeout', error: 'upstream timed out' }),
      }),
    }),
    (error) => error.code === 'research_upstream_504'
      && error.details.classification === 'upstream_504'
      && error.details.status === 504,
  );
});

test('non-JSON HTTP 504 still preserves upstream classification', async () => {
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      clientRunId: 'trace-upstream-504-html',
      fetchImpl: async () => ({
        ok: false,
        status: 504,
        json: async () => { throw new Error('Unexpected token < in JSON'); },
      }),
    }),
    (error) => error.code === 'research_upstream_504'
      && error.details.classification === 'upstream_504'
      && error.details.status === 504,
  );
});

test('local timeout cancels only the matching run and records release', async () => {
  const trace = [];
  let cancelled;
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      clientRunId: 'trace-local-timeout',
      timeoutMs: 10,
      onTrace: (event) => trace.push(event),
      fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('client timeout');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }),
      cancelImpl: async (_url, options) => {
        cancelled = JSON.parse(options.body).clientRunId;
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, code: 'cancel_requested', clientRunId: cancelled }),
        };
      },
      healthFetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ busy: false, stage: 'idle' }),
      }),
    }),
    (error) => error.code === 'research_timeout'
      && error.details.classification === 'studio_timeout'
      && error.details.cancel?.matchedClientRunId === true
      && error.details.cancel?.release?.status === 'released',
  );
  assert.equal(cancelled, 'trace-local-timeout');
  assert.ok(trace.some((item) => item.event === 'cancel_release_health'));
});

test('busy response is surfaced without sending a cancellation request', async () => {
  let cancelCalled = false;
  await assert.rejects(
    () => fetchBridgeEvidenceEnvelope(brief, {
      clientRunId: 'trace-busy',
      fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ code: 'busy', error: 'busy' }) }),
      cancelImpl: async () => { cancelCalled = true; return { ok: true }; },
    }),
    (error) => error.code === 'busy' && error.details.classification === 'busy',
  );
  assert.equal(cancelCalled, false);
});

test('health observer reports owned stage progress only after an idle preflight', async () => {
  const events = [];
  let healthCalls = 0;
  const healthFetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      healthCalls += 1;
      return healthCalls === 1
        ? { busy: false, stage: 'idle' }
        : { busy: true, stage: 'research_retrieval' };
    },
  });
  const result = await fetchBridgeEvidenceEnvelope(brief, {
    clientRunId: 'trace-progress-1',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => packet }),
    healthFetchImpl,
    healthPollMs: 250,
    onProgress: (event) => events.push(event),
  });
  assert.ok(result.packet.packetId);
  // The request completed before the first scheduled post-send poll on this
  // deterministic fixture; the preflight remains explicitly unowned rather
  // than inventing a retrieval percentage/stage.
  assert.ok(events.some((event) => event.event === 'bridge_health_initial' && event.ownership === 'unknown'));
  assert.ok(!events.some((event) => event.event === 'research_progress' && event.stage === 'research_retrieval'));
});

test('health observer claims a pending POST after an unavailable preflight', async () => {
  const trace = [];
  const controller = new AbortController();
  let healthCalls = 0;
  const healthFetchImpl = async () => {
    healthCalls += 1;
    if (healthCalls === 1) throw new Error('health unavailable during preflight');
    if (healthCalls === 2) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ busy: true, stage: 'research_audit_retry' }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ busy: false, stage: 'idle' }),
    };
  };
  const pendingFetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('caller aborted research');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const promise = fetchBridgeEvidenceEnvelope(brief, {
    clientRunId: 'trace-pending-post-1',
    fetchImpl: pendingFetch,
    signal: controller.signal,
    cancelImpl: async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => ({
        code: 'cancel_requested',
        clientRunId: JSON.parse(options.body).clientRunId,
      }),
    }),
    healthFetchImpl,
    healthPollMs: 5,
    onTrace: (event) => trace.push(event),
  });
  // The observer keeps a 250 ms floor between health requests.
  setTimeout(() => controller.abort(), 400);
  const aborted = promise.catch((error) => error);
  assert.equal((await aborted).code, 'research_aborted');
  assert.ok(trace.some((event) => event.event === 'research_accepted' && event.ownership === 'request_pending'));
  assert.ok(trace.some((event) => event.event === 'research_progress' && event.stage === 'research_audit_retry'));
});
