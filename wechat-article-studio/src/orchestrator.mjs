import { createAnnotationSet, applyAnnotationSet } from './contracts/annotation-set.mjs';
import { createArgumentMap } from './contracts/argument-map.mjs';
import { createBrief } from './contracts/brief.mjs';
import { createDraft } from './contracts/draft.mjs';
import { createEvidencePacket } from './contracts/evidence-packet.mjs';
import { reviewDraft } from './contracts/review-report.mjs';
import { createWechatPackage } from './contracts/wechat-package.mjs';
import { createStyleProfile } from './contracts/style-profile.mjs';
import { freezeContract, ensureArray } from './lib/primitives.mjs';
import { sampleInput } from './sample-data.mjs';

function nonEmptyAnnotations(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return ensureArray(input.annotations ?? [], 'annotationInput.annotations');
}

/**
 * Run the deterministic vertical slice. Each stage receives the previous
 * immutable contract, making lineage and invalidation explicit. Callers may
 * override any input stage; omitted stages use the local sample fixture.
 */
export function runPipeline(input = {}) {
  const request = input && typeof input === 'object' ? input : {};
  const brief = createBrief({ ...sampleInput.brief, ...(request.brief ?? {}) });
  const styleProfile = request.styleProfile === null
    ? null
    : createStyleProfile(request.styleProfile ?? sampleInput.styleProfile);
  const evidencePacket = createEvidencePacket(brief, request.evidence ?? request.evidenceInput ?? sampleInput.evidence);
  const argumentMap = createArgumentMap(brief, evidencePacket, request.argumentMap ?? request.argumentMapInput ?? sampleInput.argumentMap);
  const draftInput = request.draft ?? request.draftInput ?? sampleInput.draft;
  const initialDraft = createDraft(brief, argumentMap, { ...draftInput, styleProfileId: styleProfile?.styleProfileId ?? null });

  const annotationInput = request.annotationSet ?? request.annotationSetInput ??
    (request.annotations ? { annotations: request.annotations } : (request.draft || request.draftInput ? { annotations: [] } : sampleInput.annotationSet));
  const annotations = nonEmptyAnnotations(annotationInput);
  let annotationSet = null;
  let revisedDraft = initialDraft;
  let annotationReceipts = [];
  if (annotations.length > 0) {
    annotationSet = createAnnotationSet({ draft: initialDraft, annotations });
    const applied = applyAnnotationSet(initialDraft, annotationSet);
    revisedDraft = applied.draft;
    annotationReceipts = applied.receipts;
  }

  const reviewReport = reviewDraft({
    brief,
    evidencePacket,
    argumentMap,
    draft: revisedDraft,
    styleProfile,
    annotationSet,
  });
  const wechatPackage = createWechatPackage({
    brief,
    evidencePacket,
    argumentMap,
    draft: revisedDraft,
    review: reviewReport,
  });

  return freezeContract({
    brief,
    styleProfile,
    evidencePacket,
    argumentMap,
    initialDraft,
    annotationSet,
    annotationReceipts,
    draft: revisedDraft,
    reviewReport,
    // Alias retained for callers that use the shorter contract name.
    review: reviewReport,
    wechatPackage,
  });
}
