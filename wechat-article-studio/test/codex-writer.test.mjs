import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  buildCodexWriterPrompt,
  createArgumentMap,
  createWriterRequest,
  fetchCodexWriter,
  runPipeline,
  sampleInput,
} from '../src/index.mjs';

function request() {
  const result = runPipeline(sampleInput);
  return createWriterRequest({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    styleProfile: null,
    provider: 'codex-cli',
  });
}

function fakeSpawn(output, { code = 0, error = null } = {}) {
  return (_command, _args, _options) => {
    const child = new EventEmitter();
    child.stdin = { end() {} };
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      if (error) child.emit('error', error);
      else child.emit('close', code, null);
    });
    return child;
  };
}

const validOutput = {
  title: '结构化标题', digest: '结构化摘要', lead: '结构化导语',
  sections: [
    { sectionId: 'section-1', order: 1, heading: '第一节', paragraphs: [{ paragraphId: 'p-1', text: '围绕第一条主张展开。', claimIds: ['claim-1'] }] },
    { sectionId: 'section-2', order: 2, heading: '第二节', paragraphs: [{ paragraphId: 'p-2', text: '围绕第二条主张展开。', claimIds: ['claim-2'] }] },
  ],
  closingCta: '请在交付前复核。', tags: ['证据写作'], assetSlots: [],
};

test('Codex prompt names evidence and fail-closed constraints', () => {
  const prompt = buildCodexWriterPrompt(request());
  assert.match(prompt, /EvidencePacket/);
  assert.match(prompt, /claimIds/);
  assert.match(prompt, /不得补写/);
  assert.match(prompt, /只能使用其 claimIds 对应 claims 的 evidenceIds/);
  assert.match(prompt, /kind=inference/);
  assert.match(prompt, /可以使用空数组/);
  assert.doesNotMatch(prompt, /必须使用“基于这些证据的判断”“推断”“仍需验证”等限定语/);
});

test('Codex prompt and validator are scoped to claims selected by the argument map without full-coverage gating', async () => {
  const result = runPipeline(sampleInput);
  const argumentMap = createArgumentMap(result.brief, result.evidencePacket, {
    status: 'confirmed',
    points: [{
      pointId: 'point-selected',
      order: 1,
      heading: '只写选中的主张',
      thesis: '正文只推进第一个主张。',
      claimIds: ['claim-1'],
    }],
  });
  const selectedRequest = createWriterRequest({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap,
    provider: 'codex-cli',
  });
  const prompt = buildCodexWriterPrompt(selectedRequest);
  assert.match(prompt, /只写 ArgumentMap 选中的 claims/);
  assert.match(prompt, /仅是背景资料/);
  assert.match(prompt, /claim-1/);
  const selectedOutput = structuredClone(validOutput);
  selectedOutput.sections = [selectedOutput.sections[0]];
  selectedOutput.sections[0].paragraphs[0].claimIds = ['claim-1'];
  const response = await fetchCodexWriter(selectedRequest, {
    executable: 'fake-codex', schemaPath: 'schema.json', spawnImpl: fakeSpawn(),
    mkdtempImpl: async () => 'C:\\temp\\writer-test', readFileImpl: async () => JSON.stringify(selectedOutput), rmImpl: async () => {},
  });
  assert.equal(response.status, 'completed');
});

test('Codex writer parses structured output and preserves request lineage', async () => {
  const result = await fetchCodexWriter(request(), {
    executable: 'fake-codex',
    schemaPath: 'schema.json',
    spawnImpl: fakeSpawn(),
    mkdtempImpl: async () => 'C:\\temp\\writer-test',
    readFileImpl: async () => JSON.stringify(validOutput),
    rmImpl: async () => {},
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.requestId, request().requestId);
  assert.equal(result.draftInput.sections[0].paragraphs[0].claimIds[0], 'claim-1');
  assert.equal(result.diagnostics.executableSource, 'option');
});

test('Codex writer accepts an unbound transition paragraph without inventing a citation', async () => {
  const unbound = structuredClone(validOutput);
  unbound.sections[0].paragraphs[0] = { paragraphId: 'p', text: '这是承上启下的组织文字。', claimIds: [] };
  const response = await fetchCodexWriter(request(), {
    executable: 'fake-codex', schemaPath: 'schema.json', spawnImpl: fakeSpawn(),
    mkdtempImpl: async () => 'C:\\temp\\writer-test', readFileImpl: async () => JSON.stringify(unbound), rmImpl: async () => {},
  });
  assert.deepEqual(response.draftInput.sections[0].paragraphs[0].claimIds, []);
});

test('Codex writer rejects an unknown claim reference explicitly and never falls back', async () => {
  const unknown = structuredClone(validOutput);
  unknown.sections[0].paragraphs[0].claimIds = ['claim-unknown'];
  await assert.rejects(
    fetchCodexWriter(request(), {
      executable: 'fake-codex', schemaPath: 'schema.json', spawnImpl: fakeSpawn(),
      mkdtempImpl: async () => 'C:\\temp\\writer-test', readFileImpl: async () => JSON.stringify(unknown), rmImpl: async () => {},
    }),
    (error) => error.code === 'writer_response_invalid' && error.details.claimId === 'claim-unknown',
  );
});

test('Codex writer exposes provider startup failure as writer_unavailable', async () => {
  await assert.rejects(
    fetchCodexWriter(request(), {
      executable: 'missing-codex', schemaPath: 'schema.json', spawnImpl: fakeSpawn('', { error: Object.assign(new Error('not found'), { code: 'ENOENT' }) }),
      mkdtempImpl: async () => 'C:\\temp\\writer-test', readFileImpl: async () => '', rmImpl: async () => {},
    }),
    (error) => error.code === 'writer_unavailable',
  );
});

test('Codex writer rejects non-JSON output instead of constructing a sample draft', async () => {
  await assert.rejects(
    fetchCodexWriter(request(), {
      executable: 'fake-codex', schemaPath: 'schema.json', spawnImpl: fakeSpawn(),
      mkdtempImpl: async () => 'C:\\temp\\writer-test', readFileImpl: async () => '一大段纯文本', rmImpl: async () => {},
    }),
    (error) => error.code === 'writer_response_invalid',
  );
});
