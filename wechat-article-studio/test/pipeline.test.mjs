import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAnnotationSet,
  createArgumentMap,
  createArgumentMapSkeleton,
  createAnnotationSet,
  createEvidencePacket,
  createDraft,
  createWechatPackage,
  deliverWechatPackage,
  reviewDraft,
  runPipeline,
  sampleInput,
} from '../src/index.mjs';
import { createBrief } from '../src/contracts/brief.mjs';

test('deterministic sample runs through every structured contract', () => {
  const first = runPipeline(sampleInput);
  const second = runPipeline(sampleInput);

  assert.equal(first.brief.schemaVersion, 'wechat-article-studio.brief.v1');
  assert.equal(first.evidencePacket.schemaVersion, 'wechat-article-studio.evidence-packet.v1');
  assert.equal(first.argumentMap.schemaVersion, 'wechat-article-studio.argument-map.v1');
  assert.equal(first.styleProfile.schemaVersion, 'wechat-article-studio.style-profile.v1');
  assert.equal(first.initialDraft.schemaVersion, 'wechat-article-studio.draft.v1');
  assert.equal(first.annotationSet.schemaVersion, 'wechat-article-studio.annotation-set.v1');
  assert.equal(first.reviewReport.schemaVersion, 'wechat-article-studio.review-report.v1');
  assert.equal(first.wechatPackage.schemaVersion, 'wechat-article-studio.wechat-package.v1');
  assert.equal(first.brief.briefHash.length, 64);

  assert.deepEqual(first.brief.parentIds, []);
  assert.deepEqual(first.styleProfile.parentIds, []);
  assert.deepEqual(first.evidencePacket.parentIds, [first.brief.briefId]);
  assert.deepEqual(first.argumentMap.parentIds, [first.brief.briefId, first.evidencePacket.packetId]);
  assert.deepEqual(first.initialDraft.parentIds, [
    first.brief.briefId,
    first.argumentMap.mapId,
    first.styleProfile.styleProfileId,
  ]);
  assert.deepEqual(first.annotationSet.parentIds, [first.initialDraft.draftId]);
  assert.deepEqual(first.reviewReport.parentIds, [
    first.brief.briefId,
    first.evidencePacket.packetId,
    first.argumentMap.mapId,
    first.draft.draftId,
    first.annotationSet.annotationSetId,
    first.styleProfile.styleProfileId,
  ]);
  assert.deepEqual(first.wechatPackage.parentIds, [
    first.brief.briefId,
    first.evidencePacket.packetId,
    first.argumentMap.mapId,
    first.draft.draftId,
    first.reviewReport.reviewId,
  ]);
  assert.ok(Object.isFrozen(first.evidencePacket.parentIds));

  assert.equal(first.reviewReport.status, 'approved');
  assert.equal(first.wechatPackage.status, 'ready');
  assert.equal(first.reviewReport.checks.logic, true);
  assert.equal(first.reviewReport.checks.evidence, true);
  assert.equal(first.reviewReport.checks.repetition, true);
  assert.equal(first.reviewReport.checks.style, true);
  assert.equal(first.reviewReport.checks.readability, true);
  assert.equal(first.reviewReport.checks.annotationGate, true);
  assert.equal(first.reviewReport.styleProfileId, first.styleProfile.styleProfileId);
  assert.equal(first.reviewReport.annotationSetId, first.annotationSet.annotationSetId);
  assert.equal(first.draft.revision, 2);
  assert.equal(first.draft.styleProfileId, first.styleProfile.styleProfileId);
  assert.deepEqual(first.draft.parentIds, [first.initialDraft.draftId, first.annotationSet.annotationSetId]);
  assert.equal(first.annotationReceipts[0].status, 'applied');
  assert.equal(first.draft.sections[1].paragraphs[0].text, sampleInput.draft.sections[1].paragraphs[0].text.replace(
    '写作时把事实、推断和行动建议分层，编辑就能逐项核对，读者也更容易跟上。',
    '把事实、推断和行动建议分层，再逐项核对，文章就不必靠重复来制造“信息量”。',
  ));

  assert.equal(first.brief.briefId, second.brief.briefId);
  assert.equal(first.evidencePacket.packetHash, second.evidencePacket.packetHash);
  assert.equal(first.argumentMap.mapHash, second.argumentMap.mapHash);
  assert.equal(first.draft.draftHash, second.draft.draftHash);
  assert.equal(first.reviewReport.reportHash, second.reviewReport.reportHash);
  assert.equal(first.wechatPackage.contentHash, second.wechatPackage.contentHash);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.wechatPackage));
});

test('every claim is mapped and has source evidence; duplicate checks pass', () => {
  const result = runPipeline(sampleInput);
  const sourceIds = new Set(result.evidencePacket.sources.map((source) => source.sourceId));
  for (const claim of result.evidencePacket.claims) {
    assert.ok(claim.evidenceIds.length > 0);
    assert.ok(claim.evidenceIds.every((sourceId) => sourceIds.has(sourceId)));
  }
  assert.equal(result.reviewReport.checks.claimCoverage, true);
  assert.equal(result.reviewReport.checks.evidenceCoverage, true);
  assert.equal(result.reviewReport.checks.noDuplicateClaims, true);
  assert.equal(result.reviewReport.checks.noDuplicateParagraphs, true);
});

test('changing an upstream brief invalidates downstream evidence and review inputs', () => {
  const result = runPipeline(sampleInput);
  const changedBrief = createBrief({ ...result.brief, topic: `${result.brief.topic}（修订）` });
  assert.notEqual(changedBrief.briefId, result.brief.briefId);
  assert.notEqual(result.evidencePacket.parentIds[0], changedBrief.briefId);
  assert.throws(
    () => reviewDraft({
      brief: changedBrief,
      evidencePacket: result.evidencePacket,
      argumentMap: result.argumentMap,
      draft: result.draft,
      styleProfile: result.styleProfile,
      annotationSet: result.annotationSet,
    }),
    (error) => error.code === 'lineage_mismatch',
  );
});

test('real claims produce a directly usable outline that remains editable', () => {
  const result = runPipeline(sampleInput);
  const skeleton = createArgumentMapSkeleton(result.brief, result.evidencePacket);
  assert.equal(skeleton.status, 'confirmed');
  assert.equal(skeleton.points.length, result.evidencePacket.claims.length);
  assert.ok(skeleton.points.every((point) => !point.heading.startsWith('待编辑：') && point.thesis));
  assert.doesNotThrow(() => createDraft(result.brief, skeleton, sampleInput.draft));

  const confirmed = createArgumentMap(result.brief, result.evidencePacket, {
    points: skeleton.points.map((point) => ({
      ...point,
      heading: `编辑：${point.heading}`,
      thesis: '这条主张需要结合来源摘录说明其适用边界。',
    })),
    status: 'confirmed',
  });
  assert.equal(confirmed.status, 'confirmed');
  assert.notEqual(confirmed.mapId, skeleton.mapId);
});

test('style profile is versioned and immutable', () => {
  const result = runPipeline(sampleInput);
  assert.ok(Object.isFrozen(result.styleProfile));
  assert.ok(Object.isFrozen(result.styleProfile.principles));
  assert.equal(result.draft.styleProfileId, result.styleProfile.styleProfileId);
  assert.throws(() => result.styleProfile.principles.push('新增规则'), TypeError);
});

test('annotation application is pure and rejects stale base revisions', () => {
  const result = runPipeline(sampleInput);
  const before = result.initialDraft.sections[1].paragraphs[0].text;
  const applied = applyAnnotationSet(result.initialDraft, result.annotationSet);
  assert.notEqual(applied.draft.draftId, result.initialDraft.draftId);
  assert.equal(result.initialDraft.sections[1].paragraphs[0].text, before);
  assert.throws(
    () => applyAnnotationSet(result.draft, result.annotationSet),
    (error) => error.code === 'stale_annotation_set',
  );
});

test('style review reports excluded phrases without blocking export', () => {
  const result = runPipeline({
    styleProfile: { ...sampleInput.styleProfile, avoid: ['未来已来'] },
  });
  const report = result.reviewReport;
  assert.equal(report.checks.style, false);
  assert.equal(report.status, 'approved');
  assert.ok(report.issues.some((issue) => issue.code === 'style_avoid_phrase' && issue.severity === 'warning'));
});

test('unresolved high-priority annotation blocks the package', () => {
  const result = runPipeline(sampleInput);
  const annotationSet = createAnnotationSet({
    draft: result.initialDraft,
    annotations: [{
      annotationId: 'annotation-blocking',
      kind: 'replace_paragraph',
      targetParagraphId: 'paragraph-symptom',
      replacementText: '需要编辑确认的候选修订。[claim:claim-1] [source:source-1]',
      priority: 'high',
      status: 'open',
    }],
  });
  const { draft } = applyAnnotationSet(result.initialDraft, annotationSet);
  const report = reviewDraft({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    draft,
    styleProfile: result.styleProfile,
    annotationSet,
  });
  assert.equal(report.checks.annotationGate, false);
  assert.equal(report.status, 'review_required');
  assert.ok(report.hardIssues.some((issue) => issue.code === 'unresolved_high_priority_annotation'));
});

test('pipeline preserves draft revision when applying a second candidate revision', () => {
  const first = runPipeline(sampleInput);
  const targetParagraphId = first.draft.sections[0].paragraphs[0].paragraphId;
  const replacementText = `更具体地说明重复从哪里发生。[claim:claim-1] [source:source-1]`;
  const second = runPipeline({
    brief: first.brief,
    styleProfile: first.styleProfile,
    evidence: first.evidencePacket,
    argumentMap: { points: first.argumentMap.points },
    draft: first.draft,
    annotations: [{ annotationId: 'annotation-second', kind: 'replace_paragraph', targetParagraphId, replacementText }],
  });
  assert.equal(second.draft.revision, first.draft.revision + 1);
  assert.deepEqual(second.draft.parentIds, [first.draft.draftId, second.annotationSet.annotationSetId]);
  assert.equal(second.draft.sections[0].paragraphs[0].text, replacementText);
});

test('Wechat package strips internal tokens before export', () => {
  const result = runPipeline(sampleInput);
  assert.match(result.wechatPackage.bodyHtml, /<h1>/);
  assert.doesNotMatch(result.wechatPackage.bodyHtml, /\[(?:claim|source):/iu);
  assert.doesNotMatch(result.wechatPackage.bodyHtml, /\{\{(?:claim|source):/iu);
  assert.match(result.wechatPackage.bodyHtml, /逐项核对/);
  assert.match(result.wechatPackage.bodyMarkdown, /^#/);
  assert.doesNotMatch(result.wechatPackage.bodyMarkdown, /\[(?:claim|source):/iu);
  assert.ok(result.wechatPackage.contentHash);
});

test('review suggestions do not authorize delivery, while invalid claim references remain errors', () => {
  const result = runPipeline(sampleInput);
  const brokenDraft = structuredClone(result.draft);
  brokenDraft.sections[0].paragraphs[0].claimIds = ['claim-does-not-exist'];
  const report = reviewDraft({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    draft: brokenDraft,
  });
  assert.equal(report.status, 'review_required');
  assert.ok(report.hardIssues.some((issue) => issue.code === 'unknown_claim_reference'));

  assert.throws(() => createWechatPackage({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    draft: brokenDraft,
    review: report,
  }), (error) => error.code === 'missing_claim');
  const advisory = createWechatPackage({ brief: result.brief, evidencePacket: result.evidencePacket, argumentMap: result.argumentMap, draft: result.draft, review: { ...result.reviewReport, status: 'review_required' } });
  assert.equal(advisory.status, 'ready');
  assert.equal(deliverWechatPackage(advisory).status, 'queued');
});

test('evidence packet rejects a claim without a source', () => {
  const result = runPipeline(sampleInput);
  assert.throws(
    () => createEvidencePacket(result.brief, {
      sources: [{ sourceId: 'source-only', title: 'Source', excerpt: 'Excerpt', sourceOrigin: 'fixture' }],
      claims: [{ claimId: 'claim-empty', text: 'Unsupported claim', evidenceIds: [] }],
    }),
    (error) => error.code === 'invalid_array',
  );
});

test('evidence packet requires an explicit source origin', () => {
  const brief = createBrief({ topic: '来源标记', purpose: '测试来源边界', audience: '编辑' });
  assert.throws(
    () => createEvidencePacket(brief, {
      sources: [{ sourceId: 'source-1', title: '未标记来源', excerpt: '摘录' }],
      claims: [{ claimId: 'claim-1', text: '主张', evidenceIds: ['source-1'] }],
    }),
    (error) => error.code === 'invalid_enum',
  );
});

test('evidence packet rejects duplicate source IDs before Set normalization', () => {
  const brief = createBrief({ topic: '重复来源', purpose: '测试来源 ID 唯一性', audience: '编辑' });
  assert.throws(
    () => createEvidencePacket(brief, {
      sources: [
        { sourceId: 'source-1', title: '来源一', excerpt: '摘录一', sourceOrigin: 'fixture' },
        { sourceId: 'source-1', title: '来源一的重复项', excerpt: '摘录二', sourceOrigin: 'fixture' },
      ],
      claims: [{ claimId: 'claim-1', text: '主张', evidenceIds: ['source-1'] }],
    }),
    (error) => error.code === 'duplicate_id' && error.details.duplicate === 'source-1',
  );
});

test('argument map may select a non-empty subset of packet claims', () => {
  const result = runPipeline(sampleInput);
  const subset = createArgumentMap(result.brief, result.evidencePacket, {
    status: 'confirmed',
    points: [{
      pointId: 'point-selected',
      order: 1,
      heading: '只推进一个已选论点',
      thesis: '本文这一节只解释第一个已选主张。',
      claimIds: ['claim-1'],
    }],
  });
  assert.deepEqual(subset.points.flatMap((point) => point.claimIds), ['claim-1']);
  assert.equal(subset.packetId, result.evidencePacket.packetId);
});
