import {
  assertContractVersion,
  assertUnique,
  ensureArray,
  freezeContract,
  makeId,
  optionalText,
  requiredText,
  sha256,
  assertOneOf,
  ContractError,
} from '../lib/primitives.mjs';
import { DRAFT_SCHEMA_VERSION, reviseDraft } from './draft.mjs';

export const ANNOTATION_SET_SCHEMA_VERSION = 'wechat-article-studio.annotation-set.v1';

function flattenParagraphIds(draft) {
  return new Set(draft.sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.paragraphId)));
}

function normalizeAnnotation(annotation, index, paragraphIds) {
  const kind = assertOneOf(annotation?.kind, `annotations[${index}].kind`, ['replace_paragraph', 'delete_paragraph']);
  const targetParagraphId = requiredText(annotation?.targetParagraphId, `annotations[${index}].targetParagraphId`);
  if (!paragraphIds.has(targetParagraphId)) {
    throw new ContractError('missing_paragraph', `Annotation targets unknown paragraph ${targetParagraphId}`, {
      targetParagraphId,
    });
  }
  const normalized = {
    annotationId: requiredText(annotation?.annotationId ?? `annotation-${index + 1}`, `annotations[${index}].annotationId`),
    kind,
    targetParagraphId,
    instruction: optionalText(annotation?.instruction, `annotations[${index}].instruction`),
    priority: assertOneOf(annotation?.priority ?? 'normal', `annotations[${index}].priority`, ['low', 'normal', 'high']),
    // Existing candidate-revision calls are treated as resolved for backward
    // compatibility. An explicit open high-priority comment is a hard gate.
    status: assertOneOf(annotation?.status ?? 'resolved', `annotations[${index}].status`, ['open', 'resolved']),
  };
  if (kind === 'replace_paragraph') {
    normalized.replacementText = requiredText(annotation?.replacementText, `annotations[${index}].replacementText`);
  }
  return normalized;
}

/** Capture review comments against one exact draft hash. */
export function createAnnotationSet({ draft, annotations = [] } = {}) {
  assertContractVersion(draft, 'draft', DRAFT_SCHEMA_VERSION);
  const paragraphIds = flattenParagraphIds(draft);
  const normalizedAnnotations = ensureArray(annotations, 'annotationSet.annotations', { allowEmpty: false }).map((annotation, index) =>
    normalizeAnnotation(annotation, index, paragraphIds),
  );
  assertUnique(normalizedAnnotations.map((annotation) => annotation.annotationId), 'annotationSet.annotations.annotationId');
  assertUnique(
    normalizedAnnotations.map((annotation) => annotation.targetParagraphId),
    'annotationSet.annotations.targetParagraphId',
  );

  const core = {
    schemaVersion: ANNOTATION_SET_SCHEMA_VERSION,
    parentIds: [draft.draftId],
    baseDraftId: draft.draftId,
    baseDraftHash: draft.draftHash,
    annotations: normalizedAnnotations,
  };
  return freezeContract({
    ...core,
    annotationSetId: makeId('annotations', core),
    annotationSetHash: sha256(core),
  });
}

/** Apply comments without mutating either the original draft or annotation set. */
export function applyAnnotationSet(draft, annotationSet) {
  assertContractVersion(draft, 'draft', DRAFT_SCHEMA_VERSION);
  assertContractVersion(annotationSet, 'annotationSet', ANNOTATION_SET_SCHEMA_VERSION);
  if (draft.draftId !== annotationSet.baseDraftId || draft.draftHash !== annotationSet.baseDraftHash) {
    throw new ContractError('stale_annotation_set', 'Annotation set was created for a different draft revision', {
      baseDraftId: annotationSet.baseDraftId,
      receivedDraftId: draft.draftId,
    });
  }

  const requested = new Map(annotationSet.annotations.map((annotation) => [annotation.targetParagraphId, annotation]));
  const receipts = [];
  const nextSections = draft.sections.map((section) => {
    const paragraphs = [];
    for (const paragraph of section.paragraphs) {
      const annotation = requested.get(paragraph.paragraphId);
      if (!annotation) {
        paragraphs.push(paragraph);
        continue;
      }
      if (annotation.kind === 'delete_paragraph') {
        receipts.push({ annotationId: annotation.annotationId, targetParagraphId: paragraph.paragraphId, status: 'applied' });
        continue;
      }
      paragraphs.push({
        ...paragraph,
        text: annotation.replacementText,
      });
      receipts.push({ annotationId: annotation.annotationId, targetParagraphId: paragraph.paragraphId, status: 'applied' });
    }
    return { ...section, paragraphs };
  });

  const revisedDraft = reviseDraft(draft, nextSections, {
    revision: draft.revision + 1,
    parentIds: [draft.draftId, annotationSet.annotationSetId],
  });
  return freezeContract({
    annotationSetId: annotationSet.annotationSetId,
    draft: revisedDraft,
    receipts,
  });
}
