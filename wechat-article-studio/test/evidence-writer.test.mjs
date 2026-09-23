import test from 'node:test';
import assert from 'node:assert/strict';

import { composeEvidenceDraft, createWechatPackage, reviewDraft, runPipeline, sampleInput } from '../src/index.mjs';

test('evidence writer composes a reviewable draft from confirmed arguments', () => {
  const result = runPipeline(sampleInput);
  const draft = composeEvidenceDraft(result.brief, result.evidencePacket, result.argumentMap);
  assert.equal(draft.title, result.brief.topic);
  assert.equal(draft.sections.length, result.argumentMap.points.length);
  assert.ok(draft.sections.every((section) => section.paragraphs.every((paragraph) => paragraph.claimIds.length > 0)));
  assert.ok(draft.sections.flatMap((section) => section.paragraphs).every((paragraph) => paragraph.text.includes('来源摘录')));

  const review = reviewDraft({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    draft,
  });
  assert.equal(review.status, 'approved');
  const pkg = createWechatPackage({
    brief: result.brief,
    evidencePacket: result.evidencePacket,
    argumentMap: result.argumentMap,
    draft,
    review,
  });
  assert.equal(pkg.status, 'ready');
});

test('pipeline can keep style optional for real-research drafts', () => {
  const result = runPipeline({ ...sampleInput, styleProfile: null });
  assert.equal(result.styleProfile, null);
  assert.equal(result.draft.styleProfileId, null);
  assert.equal(result.reviewReport.styleProfileId, null);
  assert.equal(result.reviewReport.status, 'approved');
});
