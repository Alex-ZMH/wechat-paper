import { createArgumentMap } from '../contracts/argument-map.mjs';
import { createAnnotationSet } from '../contracts/annotation-set.mjs';
import { createBrief } from '../contracts/brief.mjs';
import { createDraft, reviseDraft } from '../contracts/draft.mjs';
import { createEvidencePacket } from '../contracts/evidence-packet.mjs';
import { reviewDraft } from '../contracts/review-report.mjs';
import { createStyleProfile } from '../contracts/style-profile.mjs';
import { ContractError, cloneJson } from './primitives.mjs';

const PRIORITY = { low: 1, normal: 2, high: 3 };

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function paragraphById(draft) {
  return new Map(draft.sections.flatMap((section) => section.paragraphs).map((paragraph) => [paragraph.paragraphId, paragraph]));
}

function normaliseAnnotation(annotation, index, paragraphs) {
  if (!isObject(annotation)) throw new ContractError('annotation_invalid', `Annotation ${index + 1} must be an object`);
  const targetParagraphId = String(annotation.targetParagraphId ?? '').trim();
  if (!targetParagraphId) throw new ContractError('annotation_invalid', `Annotation ${index + 1} has no target paragraph`);
  const target = paragraphs.get(targetParagraphId);
  if (!target) {
    throw new ContractError('missing_paragraph', `Annotation targets unknown paragraph ${targetParagraphId}`, { targetParagraphId });
  }
  const kind = annotation.kind ?? 'replace_paragraph';
  if (!['replace_paragraph', 'delete_paragraph'].includes(kind)) {
    throw new ContractError('annotation_invalid', `Unsupported annotation kind ${kind}`);
  }
  const priority = annotation.priority ?? 'normal';
  if (!Object.hasOwn(PRIORITY, priority)) throw new ContractError('annotation_invalid', `Unsupported annotation priority ${priority}`);
  const status = annotation.status ?? 'open';
  if (!['open', 'resolved'].includes(status)) throw new ContractError('annotation_invalid', `Unsupported annotation status ${status}`);
  const replacementText = kind === 'replace_paragraph'
    ? String(annotation.replacementText ?? target.text).trim()
    : undefined;
  if (kind === 'replace_paragraph' && !replacementText) throw new ContractError('annotation_invalid', 'Replacement text cannot be empty');
  return {
    annotationId: String(annotation.annotationId ?? `annotation-${index + 1}`).trim(),
    kind,
    targetParagraphId,
    instruction: String(annotation.instruction ?? '').trim(),
    priority,
    status,
    ...(kind === 'replace_paragraph' ? { replacementText } : {}),
  };
}

/** Merge incoming comments without allowing an empty array to erase history. */
export function mergeAnnotationHistory(previous = [], incoming = [], resolvedAnnotationIds = []) {
  const merged = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    if (isObject(item) && item.annotationId) merged.set(String(item.annotationId), cloneJson(item));
  }
  for (const [index, item] of (Array.isArray(incoming) ? incoming : []).entries()) {
    if (!isObject(item)) continue;
    const annotationId = String(item.annotationId ?? `annotation-${Date.now()}-${index}`).trim();
    const existing = merged.get(annotationId);
    if (existing) {
      // An existing comment can only be resolved through the explicit
      // resolvedAnnotationIds action. This prevents an empty/replayed save
      // from changing a high-priority open gate to resolved.
      merged.set(annotationId, {
        ...existing,
        ...cloneJson(item),
        annotationId,
        status: existing.status ?? 'open',
        priority: existing.priority ?? item.priority ?? 'normal',
      });
    } else {
      merged.set(annotationId, { ...cloneJson(item), annotationId, status: 'open' });
    }
  }
  for (const id of Array.isArray(resolvedAnnotationIds) ? resolvedAnnotationIds : []) {
    const current = merged.get(String(id));
    if (current) merged.set(String(id), { ...current, status: 'resolved', resolvedAt: new Date().toISOString() });
  }
  return [...merged.values()];
}

function strongestPerParagraph(annotations, draft) {
  const paragraphs = paragraphById(draft);
  const selected = new Map();
  for (const [index, raw] of annotations.entries()) {
    const annotation = normaliseAnnotation(raw, index, paragraphs);
    const existing = selected.get(annotation.targetParagraphId);
    if (!existing || PRIORITY[annotation.priority] > PRIORITY[existing.priority] ||
      (PRIORITY[annotation.priority] === PRIORITY[existing.priority] && annotation.status === 'open' && existing.status !== 'open')) {
      selected.set(annotation.targetParagraphId, annotation);
    }
  }
  return [...selected.values()];
}

function createReviewContext(draft, annotations) {
  if (!draft || annotations.length === 0) return { reviewDraft: draft, annotationSet: null };
  const selected = strongestPerParagraph(annotations, draft);
  const annotationSet = createAnnotationSet({ draft, annotations: selected });
  // reviewDraft validates that the annotation set belongs to the draft's
  // parent chain. This review-only revision is not persisted or shown to the
  // reader; the actual hand-edited draft remains untouched.
  const reviewDraftRevision = reviseDraft(draft, draft.sections, {
    revision: draft.revision,
    parentIds: [...new Set([...draft.parentIds, annotationSet.annotationSetId])],
  });
  return { reviewDraft: reviewDraftRevision, annotationSet };
}

/**
 * Rebuild all contracts from the saved payload. The caller may provide a
 * ResearchSession record to enforce that the workspace has one evidence
 * lineage; a brief-only workspace is allowed before research starts.
 */
export function normaliseWorkspacePayload({ payload, sessionRecord = null } = {}) {
  if (!isObject(payload)) throw new ContractError('workspace_invalid', 'Workspace payload must be an object');
  const brief = createBrief(payload.brief ?? payload);
  if (sessionRecord && brief.briefId !== sessionRecord.brief.briefId) {
    throw new ContractError('lineage_mismatch', 'Workspace topic does not match its research session', {
      workspaceBriefId: brief.briefId,
      sessionBriefId: sessionRecord.brief.briefId,
    });
  }

  let evidence = payload.evidencePacket ?? payload.evidence ?? null;
  if (!evidence && sessionRecord) evidence = sessionRecord.evidencePacket;
  if (evidence) {
    evidence = createEvidencePacket(brief, evidence);
    if (sessionRecord && evidence.packetId !== sessionRecord.evidencePacket.packetId) {
      throw new ContractError('lineage_mismatch', 'Workspace evidence does not match its research session');
    }
  }

  let argumentMap = payload.argumentMap ?? null;
  if (!argumentMap && sessionRecord?.argumentMap) argumentMap = sessionRecord.argumentMap;
  if (argumentMap) {
    if (!evidence) throw new ContractError('lineage_mismatch', 'An argument map requires an evidence packet');
    const requestedStatus = argumentMap.status ?? 'draft';
    argumentMap = createArgumentMap(brief, evidence, {
      ...argumentMap,
      status: requestedStatus,
      allowIncomplete: requestedStatus === 'draft',
    });
    if (sessionRecord?.argumentMap && argumentMap.mapId !== sessionRecord.argumentMap.mapId) {
      throw new ContractError('lineage_mismatch', 'Workspace argument map does not match the confirmed session map');
    }
  }

  let styleProfile = payload.styleProfile ?? null;
  if (styleProfile) styleProfile = createStyleProfile(styleProfile);

  let draft = payload.draft ?? null;
  if (draft) {
    if (!argumentMap || argumentMap.status !== 'confirmed') {
      throw new ContractError('argument_map_unconfirmed', 'An article draft requires a confirmed outline');
    }
    draft = createDraft(brief, argumentMap, {
      ...draft,
      briefId: brief.briefId,
      argumentMapId: argumentMap.mapId,
      styleProfileId: styleProfile?.styleProfileId ?? draft.styleProfileId ?? null,
      revision: draft.revision,
      parentIds: draft.parentIds,
    });
  }

  const canonical = {
    ...cloneJson(payload),
    brief,
    evidence: evidence ?? null,
    evidencePacket: evidence ?? null,
    argumentMap: argumentMap ?? null,
    styleProfile,
    draft,
  };
  return canonical;
}

// Keep the American spelling available to adapters and tests while using the
// project’s existing British spelling internally.
export const normalizeWorkspacePayload = normaliseWorkspacePayload;

export function reviewWorkspacePayload({ payload, sessionRecord = null, annotations = [], previousAnnotations = [], resolvedAnnotationIds = [] } = {}) {
  const canonical = normaliseWorkspacePayload({ payload, sessionRecord });
  const mergedAnnotations = mergeAnnotationHistory(previousAnnotations, [
    ...(Array.isArray(canonical.annotations) ? canonical.annotations : []),
    ...(Array.isArray(annotations) ? annotations : []),
  ], resolvedAnnotationIds);
  canonical.annotations = mergedAnnotations;
  if (!canonical.draft) return { payload: canonical, annotationHistory: mergedAnnotations, revisionHistory: [], reviewReport: null, annotationSet: null };
  if (!canonical.argumentMap || canonical.argumentMap.status !== 'confirmed') {
    throw new ContractError('argument_map_unconfirmed', 'A draft cannot be reviewed until the outline is confirmed');
  }
  const { reviewDraft: candidate, annotationSet } = createReviewContext(canonical.draft, mergedAnnotations);
  const reviewReport = reviewDraft({
    brief: canonical.brief,
    evidencePacket: canonical.evidence,
    argumentMap: canonical.argumentMap,
    draft: candidate,
    styleProfile: canonical.styleProfile,
    annotationSet,
  });
  return { payload: canonical, annotationHistory: mergedAnnotations, revisionHistory: [], reviewReport, annotationSet };
}

export function reviewSavedWorkspace(workspace, sessionRecord = null) {
  if (!workspace) throw new ContractError('workspace_not_found', 'Workspace was not found');
  const result = reviewWorkspacePayload({
    payload: workspace.payload,
    sessionRecord,
    previousAnnotations: workspace.annotationHistory,
  });
  return { ...result, workspace };
}

export function finalizationCheck(workspace, sessionRecord = null) {
  const result = reviewSavedWorkspace(workspace, sessionRecord);
  const draftHash = result.payload.draft?.draftHash ?? null;
  return { ...result, draftHash };
}

export function mergeRevisionHistory(existing, supplied, previousPayload, nextPayload) {
  const history = Array.isArray(existing) ? cloneJson(existing) : [];
  if (Array.isArray(supplied)) history.push(...cloneJson(supplied));
  const previousDraft = previousPayload?.draft;
  const nextDraft = nextPayload?.draft;
  if (previousDraft?.draftHash && nextDraft?.draftHash && previousDraft.draftHash !== nextDraft.draftHash) {
    if (!history.some((entry) => entry?.draftHash === previousDraft.draftHash)) {
      history.push({
        version: previousPayload?.version ?? null,
        draftHash: previousDraft.draftHash,
        draft: previousDraft,
        savedAt: new Date().toISOString(),
      });
    }
  }
  const seen = new Set();
  return history.filter((entry) => {
    const key = entry?.draftHash ?? JSON.stringify(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
