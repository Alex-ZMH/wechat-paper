import {
  assertContractVersion,
  assertUnique,
  ensureArray,
  freezeContract,
  makeId,
  optionalText,
  requiredText,
  sha256,
  ContractError,
} from '../lib/primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';
import { ARGUMENT_MAP_SCHEMA_VERSION } from './argument-map.mjs';

export const DRAFT_SCHEMA_VERSION = 'wechat-article-studio.draft.v1';

function normalizeAssetSlot(slot, index) {
  if (typeof slot === 'string') {
    return {
      slotId: `asset-${index + 1}`,
      purpose: requiredText(slot, `draft.assetSlots[${index}]`),
      alt: '',
    };
  }
  return {
    slotId: requiredText(slot?.slotId ?? `asset-${index + 1}`, `draft.assetSlots[${index}].slotId`),
    purpose: requiredText(slot?.purpose, `draft.assetSlots[${index}].purpose`),
    alt: optionalText(slot?.alt, `draft.assetSlots[${index}].alt`),
  };
}

function normalizeParagraph(paragraph, sectionIndex, paragraphIndex, knownClaimIds, sectionId) {
  const claimIds = ensureArray(paragraph?.claimIds ?? [], `draft.sections[${sectionIndex}].paragraphs[${paragraphIndex}].claimIds`).map(
    (claimId) => requiredText(claimId, `draft.sections[${sectionIndex}].paragraphs[${paragraphIndex}].claimIds[]`),
  );
  assertUnique(claimIds, `draft.sections[${sectionIndex}].paragraphs[${paragraphIndex}].claimIds`);
  const unknownClaim = claimIds.find((claimId) => !knownClaimIds.has(claimId));
  if (unknownClaim) {
    throw new ContractError('missing_claim', `Draft paragraph references unknown claim ${unknownClaim}`, {
      paragraphId: paragraph?.paragraphId,
      claimId: unknownClaim,
    });
  }
  return {
    paragraphId: requiredText(
      paragraph?.paragraphId ?? `${sectionId}-paragraph-${paragraphIndex + 1}`,
      `draft.sections[${sectionIndex}].paragraphs[${paragraphIndex}].paragraphId`,
    ),
    text: requiredText(paragraph?.text, `draft.sections[${sectionIndex}].paragraphs[${paragraphIndex}].text`),
    claimIds,
  };
}

function normalizeSections(sectionsInput, knownClaimIds) {
  const sections = ensureArray(sectionsInput ?? [], 'draft.sections', { allowEmpty: false }).map((section, sectionIndex) => {
    const sectionId = requiredText(section?.sectionId ?? `section-${sectionIndex + 1}`, `draft.sections[${sectionIndex}].sectionId`);
    const paragraphs = ensureArray(section?.paragraphs ?? [], `draft.sections[${sectionIndex}].paragraphs`, {
      allowEmpty: false,
    }).map((paragraph, paragraphIndex) =>
      normalizeParagraph(paragraph, sectionIndex, paragraphIndex, knownClaimIds, sectionId),
    );
    return {
      sectionId,
      order: Number.isInteger(section?.order) ? section.order : sectionIndex + 1,
      heading: requiredText(section?.heading, `draft.sections[${sectionIndex}].heading`),
      paragraphs,
    };
  });
  assertUnique(sections.map((section) => section.sectionId), 'draft.sections.sectionId');
  assertUnique(
    sections.flatMap((section) => section.paragraphs.map((paragraph) => paragraph.paragraphId)),
    'draft.paragraphs.paragraphId',
  );
  return sections.sort((a, b) => a.order - b.order || a.sectionId.localeCompare(b.sectionId));
}

function buildDraftCore(brief, argumentMap, input, revision) {
  const knownClaimIds = new Set(argumentMap.points.flatMap((point) => point.claimIds));
  const suppliedParents = Array.isArray(input.parentIds) && input.briefId === brief.briefId && input.argumentMapId === argumentMap.mapId
    ? input.parentIds.map((parentId, index) => requiredText(parentId, `draft.parentIds[${index}]`))
    : null;
  const core = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    parentIds: suppliedParents ?? [brief.briefId, argumentMap.mapId, ...(input.styleProfileId ? [input.styleProfileId] : [])],
    briefId: brief.briefId,
    argumentMapId: argumentMap.mapId,
    styleProfileId: input.styleProfileId == null ? null : requiredText(input.styleProfileId, 'draft.styleProfileId'),
    revision,
    title: requiredText(input.title, 'draft.title'),
    digest: requiredText(input.digest, 'draft.digest'),
    lead: requiredText(input.lead, 'draft.lead'),
    sections: normalizeSections(input.sections, knownClaimIds),
    closingCta: requiredText(input.closingCta, 'draft.closingCta'),
    tags: ensureArray(input.tags ?? [], 'draft.tags').map((tag, index) => requiredText(tag, `draft.tags[${index}]`)),
    assetSlots: ensureArray(input.assetSlots ?? [], 'draft.assetSlots').map(normalizeAssetSlot),
  };
  assertUnique(core.tags, 'draft.tags');
  assertUnique(core.assetSlots.map((slot) => slot.slotId), 'draft.assetSlots.slotId');
  return core;
}

function finalizeDraft(core) {
  return freezeContract({
    ...core,
    draftId: makeId('draft', core),
    draftHash: sha256(core),
  });
}

/** Construct revision one of an article draft from the argument map. */
export function createDraft(brief, argumentMap, input = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(argumentMap, 'argumentMap', ARGUMENT_MAP_SCHEMA_VERSION);
  if (argumentMap.briefId !== brief.briefId) {
    throw new ContractError('lineage_mismatch', 'Argument map does not belong to brief', {
      briefId: brief.briefId,
      mapBriefId: argumentMap.briefId,
    });
  }
  if (argumentMap.status !== 'confirmed') {
    throw new ContractError('argument_map_unconfirmed', 'Draft can only be created from a confirmed argument map', {
      mapId: argumentMap.mapId,
      status: argumentMap.status,
    });
  }
  const revision = Number.isInteger(input.revision) && input.revision > 0 ? input.revision : 1;
  return finalizeDraft(buildDraftCore(brief, argumentMap, input, revision));
}

/**
 * Build an immutable revision while preserving editorial metadata. Annotation
 * application uses this helper so revision IDs and hashes remain deterministic.
 */
export function reviseDraft(draft, nextSections, {
  revision = draft.revision + 1,
  parentIds = [draft.draftId],
} = {}) {
  assertContractVersion(draft, 'draft', DRAFT_SCHEMA_VERSION);
  const core = {
    schemaVersion: DRAFT_SCHEMA_VERSION,
    parentIds: [...parentIds],
    briefId: draft.briefId,
    argumentMapId: draft.argumentMapId,
    styleProfileId: draft.styleProfileId ?? null,
    revision,
    title: draft.title,
    digest: draft.digest,
    lead: draft.lead,
    sections: nextSections,
    closingCta: draft.closingCta,
    tags: draft.tags,
    assetSlots: draft.assetSlots,
  };
  return finalizeDraft(core);
}
