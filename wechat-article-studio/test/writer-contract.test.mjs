import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createWriterRequest,
  normalizeBridgeWriterResponse,
  runPipeline,
  sampleInput,
  toBridgeWriterRequest,
  fetchBridgeWriter,
} from '../src/index.mjs';

test('WriterRequest freezes the complete evidence and argument context', () => {
  const result = runPipeline(sampleInput);
  const request = createWriterRequest({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    styleProfile: result.styleProfile,
    provider: 'bridge',
    mode: 'initial_generation',
    clientRunId: 'writer-run-1',
  });
  assert.equal(request.schemaVersion, 'wechat-article-studio.writer-request.v1');
  assert.equal(request.argumentMap.mapId, result.argumentMap.mapId);
  assert.equal(request.evidencePacket.packetHash, result.evidencePacket.packetHash);
  assert.ok(request.parentIds.includes(result.styleProfile.styleProfileId));
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.evidencePacket));
});

test('Bridge writer request sends only server-owned evidence id and hash', () => {
  const result = runPipeline(sampleInput);
  const request = createWriterRequest({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    provider: 'bridge',
  });
  const payload = toBridgeWriterRequest(request, {
    bridgeEvidenceRef: { packetId: 'ep-server-owned', packetHash: 'a'.repeat(64) },
    writerModel: 'codex-sol',
    reviewerModel: 'codex-terra',
  });
  assert.equal(payload.schemaVersion, 'content-desk.request.v2');
  assert.equal(payload.evidencePacketId, 'ep-server-owned');
  assert.equal(payload.evidencePacketHash, 'a'.repeat(64));
  assert.equal('researchPacket' in payload, false);
  assert.equal(payload.task.kind, 'research_writing');
  assert.equal(payload.dualReview, true);
});

test('Bridge adapter refuses an unstructured plain-text writer response', () => {
  const result = runPipeline(sampleInput);
  const request = createWriterRequest({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    provider: 'bridge',
  });
  assert.throws(
    () => normalizeBridgeWriterResponse(request, { schemaVersion: 'codex.bridge.response.v1', draft: '一段没有 claim 绑定的正文。' }),
    (error) => error.code === 'writer_response_unstructured',
  );
});

test('fetchBridgeWriter maps a future structured response and preserves request id', async () => {
  const result = runPipeline(sampleInput);
  const request = createWriterRequest({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    provider: 'bridge',
  });
  const response = await fetchBridgeWriter(request, {
    bridgeEvidenceRef: { packetId: 'ep-server-owned', packetHash: 'b'.repeat(64) },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.evidencePacketId, 'ep-server-owned');
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: 'succeeded', model: 'fixture', draftInput: { title: '结构化响应' } }),
      };
    },
  });
  assert.equal(response.schemaVersion, 'wechat-article-studio.writer-response.v1');
  assert.equal(response.requestId, request.requestId);
  assert.equal(response.status, 'completed');
});
