import {
  ARGUMENT_MAP_SCHEMA_VERSION,
} from './argument-map.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';
import { DRAFT_SCHEMA_VERSION } from './draft.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from './evidence-packet.mjs';
import { STYLE_PROFILE_SCHEMA_VERSION } from './style-profile.mjs';
import { ANNOTATION_SET_SCHEMA_VERSION } from './annotation-set.mjs';
import {
  assertContractVersion,
  assertUnique,
  freezeContract,
  makeId,
  normalizeForDuplicate,
  sha256,
  ContractError,
} from '../lib/primitives.mjs';

export const REVIEW_REPORT_SCHEMA_VERSION = 'wechat-article-studio.review-report.v1';

function addIssue(issues, code, message, details = {}, severity = 'error') {
  issues.push({ code, severity, message, details });
}

function collectParagraphs(draft) {
  return draft.sections.flatMap((section) => section.paragraphs);
}

/**
 * Deterministic preflight review. A report with any hard issue is explicitly
 * `review_required`; WechatPackage refuses delivery in that state.
 */
export function reviewDraft({ brief, evidencePacket, argumentMap, draft, styleProfile, annotationSet } = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  assertContractVersion(argumentMap, 'argumentMap', ARGUMENT_MAP_SCHEMA_VERSION);
  assertContractVersion(draft, 'draft', DRAFT_SCHEMA_VERSION);
  if (styleProfile) {
    assertContractVersion(styleProfile, 'styleProfile', STYLE_PROFILE_SCHEMA_VERSION);
    if (draft.styleProfileId && draft.styleProfileId !== styleProfile.styleProfileId) {
      throw new ContractError('lineage_mismatch', 'Draft does not belong to the supplied style profile', {
        draftStyleProfileId: draft.styleProfileId,
        styleProfileId: styleProfile.styleProfileId,
      });
    }
  }
  if (annotationSet) {
    assertContractVersion(annotationSet, 'annotationSet', ANNOTATION_SET_SCHEMA_VERSION);
    if (!draft.parentIds.includes(annotationSet.annotationSetId)) {
      throw new ContractError('lineage_mismatch', 'Draft does not include the supplied annotation set as a parent', {
        draftId: draft.draftId,
        annotationSetId: annotationSet.annotationSetId,
      });
    }
  }

  if (brief.briefId !== evidencePacket.briefId || brief.briefId !== argumentMap.briefId || brief.briefId !== draft.briefId) {
    throw new ContractError('lineage_mismatch', 'Review inputs do not share the same brief lineage');
  }
  if (argumentMap.packetId !== evidencePacket.packetId || draft.argumentMapId !== argumentMap.mapId) {
    throw new ContractError('lineage_mismatch', 'Review inputs do not share the same evidence/argument lineage');
  }

  const issues = [];
  const hardIssues = [];
  const paragraphs = collectParagraphs(draft);
  const packetClaims = new Map(evidencePacket.claims.map((claim) => [claim.claimId, claim]));
  const argumentClaims = argumentMap.points.flatMap((point) => point.claimIds);
  const argumentClaimSet = new Set(argumentClaims);
  const paragraphClaimRefs = paragraphs.flatMap((paragraph) => paragraph.claimIds);
  const paragraphClaimSet = new Set(paragraphClaimRefs);
  const sourceIds = new Set(evidencePacket.sources.map((source) => source.sourceId));

  const structureOk = Boolean(
    draft.title &&
      draft.digest &&
      draft.lead &&
      draft.closingCta &&
      draft.sections.length > 0 &&
      draft.sections.every((section) => section.heading && section.paragraphs.length > 0 && section.paragraphs.every((p) => p.text)),
  );
  if (!structureOk) {
    addIssue(issues, 'structure_incomplete', 'Draft is missing a required article section or text');
    hardIssues.push(issues.at(-1));
  }

  let claimCoverageOk = true;
  for (const claimId of argumentClaimSet) {
    if (!paragraphClaimSet.has(claimId)) {
      claimCoverageOk = false;
      const issue = { code: 'claim_not_used', severity: 'error', message: `Claim ${claimId} is not cited by the draft`, details: { claimId } };
      issues.push(issue);
      hardIssues.push(issue);
    }
  }
  for (const claimId of paragraphClaimSet) {
    if (!argumentClaimSet.has(claimId)) {
      claimCoverageOk = false;
      const issue = { code: 'unknown_claim_reference', severity: 'error', message: `Draft cites unknown claim ${claimId}`, details: { claimId } };
      issues.push(issue);
      hardIssues.push(issue);
    }
  }

  let evidenceCoverageOk = true;
  for (const claimId of paragraphClaimSet) {
    const claim = packetClaims.get(claimId);
    if (!claim || !Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0) {
      evidenceCoverageOk = false;
      const issue = { code: 'claim_without_evidence', severity: 'error', message: `Claim ${claimId} has no source evidence`, details: { claimId } };
      issues.push(issue);
      hardIssues.push(issue);
      continue;
    }
    const missingSource = claim.evidenceIds.find((sourceId) => !sourceIds.has(sourceId));
    if (missingSource) {
      evidenceCoverageOk = false;
      const issue = {
        code: 'missing_source_reference',
        severity: 'error',
        message: `Claim ${claimId} references missing source ${missingSource}`,
        details: { claimId, sourceId: missingSource },
      };
      issues.push(issue);
      hardIssues.push(issue);
    }
  }

  let noDuplicateClaims = true;
  try {
    assertUnique(argumentClaims, 'argumentMap.claimIds');
  } catch (error) {
    noDuplicateClaims = false;
    const issue = { code: 'duplicate_claim_reference', severity: 'error', message: error.message, details: error.details };
    issues.push(issue);
    hardIssues.push(issue);
  }
  for (const paragraph of paragraphs) {
    try {
      assertUnique(paragraph.claimIds, `paragraph ${paragraph.paragraphId}.claimIds`);
    } catch (error) {
      noDuplicateClaims = false;
      const issue = { code: 'duplicate_claim_reference', severity: 'error', message: error.message, details: error.details };
      issues.push(issue);
      hardIssues.push(issue);
    }
  }

  let noDuplicateParagraphs = true;
  const seenParagraphText = new Map();
  for (const paragraph of paragraphs) {
    const normalized = normalizeForDuplicate(paragraph.text);
    if (!normalized) continue;
    const previousId = seenParagraphText.get(normalized);
    if (previousId) {
      noDuplicateParagraphs = false;
      const issue = {
        code: 'duplicate_paragraph',
        severity: 'error',
        message: `Paragraph ${paragraph.paragraphId} duplicates ${previousId}`,
        details: { paragraphId: paragraph.paragraphId, previousId },
      };
      issues.push(issue);
      hardIssues.push(issue);
    } else {
      seenParagraphText.set(normalized, paragraph.paragraphId);
    }
  }

  const longParagraph = paragraphs.find((paragraph) => paragraph.text.length > 600);
  const mobileReadability = !longParagraph && paragraphs.length <= 24;
  if (longParagraph) {
    addIssue(issues, 'paragraph_too_long', `Paragraph ${longParagraph.paragraphId} exceeds 600 characters`, {
      paragraphId: longParagraph.paragraphId,
    });
    const issue = issues.at(-1);
    hardIssues.push(issue);
  }
  if (paragraphs.length > 24) {
    addIssue(issues, 'too_many_paragraphs', 'Draft has more than 24 paragraphs for a mobile article');
    hardIssues.push(issues.at(-1));
  }

  // Style rules are deliberately limited to explicit avoid phrases. More
  // subjective voice judgments remain human/editorial work for now.
  let styleConsistencyOk = true;
  if (styleProfile) {
    const textFields = [
      ['title', draft.title],
      ['digest', draft.digest],
      ['lead', draft.lead],
      ...draft.sections.flatMap((section) => [
        [`section:${section.sectionId}:heading`, section.heading],
        ...section.paragraphs.map((paragraph) => [`paragraph:${paragraph.paragraphId}`, paragraph.text]),
      ]),
      ['closingCta', draft.closingCta],
    ];
    for (const avoidPhrase of styleProfile.avoid) {
      const normalizedAvoid = avoidPhrase.toLocaleLowerCase('zh-CN');
      const match = textFields.find(([, text]) => text.toLocaleLowerCase('zh-CN').includes(normalizedAvoid));
      if (match) {
        styleConsistencyOk = false;
        addIssue(
          issues,
          'style_avoid_phrase',
          `Draft uses a phrase excluded by the style profile: ${avoidPhrase}`,
          { avoidPhrase, location: match[0] },
          'warning',
        );
      }
    }
  }

  const logicOk = structureOk && claimCoverageOk;
  const evidenceOk = evidenceCoverageOk;
  const repetitionOk = noDuplicateClaims && noDuplicateParagraphs;
  const readabilityOk = mobileReadability;
  let annotationGateOk = true;
  if (annotationSet) {
    for (const annotation of annotationSet.annotations) {
      if (annotation.priority !== 'high' || annotation.status === 'resolved') continue;
      annotationGateOk = false;
      const issue = {
        code: 'unresolved_high_priority_annotation',
        severity: 'error',
        message: `High-priority annotation ${annotation.annotationId} is still open`,
        details: { annotationId: annotation.annotationId, targetParagraphId: annotation.targetParagraphId },
      };
      issues.push(issue);
      hardIssues.push(issue);
    }
  }
  const parentIds = [brief.briefId, evidencePacket.packetId, argumentMap.mapId, draft.draftId];
  if (annotationSet) parentIds.push(annotationSet.annotationSetId);
  if (styleProfile) parentIds.push(styleProfile.styleProfileId);

  const checks = {
    logic: logicOk,
    evidence: evidenceOk,
    repetition: repetitionOk,
    style: styleConsistencyOk,
    readability: readabilityOk,
    annotationGate: annotationGateOk,
    structure: structureOk,
    claimCoverage: claimCoverageOk,
    evidenceCoverage: evidenceCoverageOk,
    noDuplicateClaims,
    noDuplicateParagraphs,
    mobileReadability,
  };
  const core = {
    schemaVersion: REVIEW_REPORT_SCHEMA_VERSION,
    parentIds,
    styleProfileId: styleProfile?.styleProfileId ?? draft.styleProfileId ?? null,
    annotationSetId: annotationSet?.annotationSetId ?? null,
    briefId: brief.briefId,
    draftId: draft.draftId,
    checks,
    issues,
    hardIssues,
    score: Math.max(0, 100 - hardIssues.length * 20),
    status: hardIssues.length === 0 ? 'approved' : 'review_required',
  };
  return freezeContract({
    ...core,
    reviewId: makeId('review', core),
    reportHash: sha256(core),
  });
}
