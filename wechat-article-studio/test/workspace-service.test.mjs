import test from 'node:test';
import assert from 'node:assert/strict';

import { runPipeline } from '../src/orchestrator.mjs';
import { sampleInput } from '../src/sample-data.mjs';
import {
  finalizationCheck,
  mergeAnnotationHistory,
  normaliseWorkspacePayload,
  reviewWorkspacePayload,
} from '../src/lib/workspace-service.mjs';
import { LocalWorkspaceStore } from '../src/lib/workspace-store.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function validPayload() {
  return normaliseWorkspacePayload({ payload: runPipeline(sampleInput) });
}

test('workspace service accepts an uncited transition paragraph', () => {
  const payload = validPayload();
  const broken = structuredClone(payload);
  broken.draft.sections[0].paragraphs[0].claimIds = [];
  assert.deepEqual(normaliseWorkspacePayload({ payload: broken }).draft.sections[0].paragraphs[0].claimIds, []);
});

test('workspace review preserves an open high-priority annotation when incoming list is empty', () => {
  const payload = validPayload();
  const paragraphId = payload.draft.sections[0].paragraphs[0].paragraphId;
  const reviewed = reviewWorkspacePayload({
    payload,
    annotations: [{ annotationId: 'high-1', kind: 'replace_paragraph', targetParagraphId: paragraphId, replacementText: '请核对依据', priority: 'high', status: 'open' }],
  });
  assert.equal(reviewed.reviewReport.status, 'review_required');
  const rereviewed = reviewWorkspacePayload({ payload: reviewed.payload, previousAnnotations: reviewed.annotationHistory, annotations: [] });
  assert.equal(rereviewed.annotationHistory.find((item) => item.annotationId === 'high-1').status, 'open');
  assert.equal(rereviewed.reviewReport.status, 'review_required');
  assert.doesNotThrow(() => finalizationCheck({ payload: rereviewed.payload, annotationHistory: rereviewed.annotationHistory }));
  const resolved = reviewWorkspacePayload({ payload: rereviewed.payload, previousAnnotations: rereviewed.annotationHistory, resolvedAnnotationIds: ['high-1'] });
  assert.equal(resolved.reviewReport.status, 'approved');
  assert.doesNotThrow(() => finalizationCheck({ payload: resolved.payload, annotationHistory: resolved.annotationHistory }));
});


test('annotation history merges by id and never treats an empty array as deletion', () => {
  const first = [{ annotationId: 'a', status: 'open', priority: 'high' }];
  assert.deepEqual(mergeAnnotationHistory(first, []), first);
  assert.equal(mergeAnnotationHistory(first, [], ['a'])[0].status, 'resolved');
});

test('workspace store versions independent workspaces and quarantines known QA snapshots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wechat-workspace-v2-'));
  try {
    const filePath = join(dir, 'workspace.json');
    const store = new LocalWorkspaceStore({ filePath });
    const first = store.save({ workspaceId: 'topic-a', baseVersion: 0, mode: 'brief', payload: { brief: { topic: '甲' } } });
    const second = store.save({ workspaceId: 'topic-b', baseVersion: 0, mode: 'brief', payload: { brief: { topic: '乙' } } });
    assert.equal(first.version, 1);
    assert.equal(second.version, 1);
    assert.equal(store.list({ includeLegacy: false }).length, 2);
    assert.throws(() => store.save({ workspaceId: 'topic-a', baseVersion: 0, mode: 'brief', payload: { brief: { topic: '覆盖' } } }), (error) => error.code === 'workspace_conflict');
    writeFileSync(filePath, JSON.stringify({ version: 1, workspace: { schemaVersion: 'wechat-article-studio.workspace.v1', sessionId: 'old', mode: 'verified_materials', savedAt: new Date().toISOString(), payload: { brief: { topic: '旧', marker: 'qa-annotation' } } } }), 'utf8');
    const migrated = new LocalWorkspaceStore({ filePath });
    assert.equal(migrated.latest(), null);
    assert.equal(migrated.list({ includeLegacy: true })[0].needsExplicitRestore, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
