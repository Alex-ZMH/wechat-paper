import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBrief } from '../src/contracts/brief.mjs';
import { createEvidencePacket } from '../src/contracts/evidence-packet.mjs';
import { createResearchSession } from '../src/contracts/research-session.mjs';
import { ResearchSessionStore } from '../src/lib/research-session-store.mjs';
import { LocalWorkspaceStore } from '../src/lib/workspace-store.mjs';

const brief = createBrief({
  topic: '研究会话测试',
  purpose: '确认真实证据能被保存和重新载入。',
  audience: '编辑',
});
const evidencePacket = createEvidencePacket(brief, {
  sources: [{ sourceId: 'source-1', title: '测试来源', excerpt: '测试摘录', sourceOrigin: 'fixture' }],
  claims: [{ claimId: 'claim-1', text: '测试主张', evidenceIds: ['source-1'] }],
});

test('research session is an immutable, provider-neutral evidence boundary', () => {
  const session = createResearchSession(brief, evidencePacket, { clientRunId: 'run-1' });
  assert.equal(session.status, 'accepted');
  assert.equal(session.provider, 'bridge');
  assert.deepEqual(session.parentIds, [brief.briefId, evidencePacket.packetId]);
  assert.equal(session.evidencePacketId, evidencePacket.packetId);
  assert.ok(Object.isFrozen(session));
});

test('research session rejects evidence from another brief', () => {
  const otherBrief = createBrief({ topic: '另一个主题', purpose: '另一个目的', audience: '编辑' });
  assert.throws(
    () => createResearchSession(otherBrief, evidencePacket),
    (error) => error.code === 'lineage_mismatch',
  );
});

test('session store can save, list, and reload a complete record', () => {
  const store = new ResearchSessionStore();
  const researchSession = createResearchSession(brief, evidencePacket);
  const saved = store.save({ researchSession, brief, evidencePacket });
  assert.equal(store.get(researchSession.sessionId), saved);
  assert.deepEqual(store.list().map((item) => item.sessionId), [researchSession.sessionId]);
  assert.equal(saved.evidencePacket.packetId, evidencePacket.packetId);
  assert.ok(Object.isFrozen(saved));
});

test('session store rejects a mismatched record instead of hiding lineage errors', () => {
  const store = new ResearchSessionStore();
  const researchSession = createResearchSession(brief, evidencePacket);
  const otherBrief = createBrief({ topic: '另一个主题', purpose: '另一个目的', audience: '编辑' });
  assert.throws(
    () => store.save({ researchSession, brief: otherBrief, evidencePacket }),
    (error) => error.code === 'lineage_mismatch',
  );
});

test('local workspace survives a store re-instantiation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wechat-workspace-test-'));
  const filePath = join(directory, 'workspace.json');
  try {
    const session = createResearchSession(brief, evidencePacket, { provider: 'human_curated' });
    const sessions = new ResearchSessionStore({ filePath: join(directory, 'sessions.json') });
    sessions.save({ researchSession: session, brief, evidencePacket });
    const writerPayload = { brief, evidencePacket, draft: { title: '保存后的文章' } };
    const first = new LocalWorkspaceStore({ filePath });
    first.save({ sessionId: session.sessionId, mode: 'verified_materials', payload: writerPayload, annotationHistory: [{ status: 'resolved' }] });
    const second = new LocalWorkspaceStore({ filePath });
    assert.equal(second.latest().payload.draft.title, '保存后的文章');
    assert.equal(second.latest().mode, 'verified_materials');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
