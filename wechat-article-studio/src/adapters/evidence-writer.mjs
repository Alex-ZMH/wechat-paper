import { assertContractVersion, ContractError, requiredText } from '../lib/primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from '../contracts/brief.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from '../contracts/evidence-packet.mjs';
import { ARGUMENT_MAP_SCHEMA_VERSION } from '../contracts/argument-map.mjs';
import { createDraft } from '../contracts/draft.mjs';
import { WRITER_REQUEST_SCHEMA_VERSION, createWriterResponse } from '../contracts/writer.mjs';

export const EVIDENCE_WRITER_ADAPTER_SCHEMA_VERSION = 'wechat-article-studio.evidence-writer-adapter.v1';

function compact(text, maxLength = 180) {
  const value = requiredText(text, 'writer.text');
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function sourceExcerpt(claim, packet) {
  const source = packet.sources.find((item) => item.sourceId === claim.evidenceIds[0]);
  if (!source) throw new ContractError('missing_source', `Writer cannot find evidence for claim ${claim.claimId}`, { claimId: claim.claimId });
  return { source, excerpt: compact(source.excerpt) };
}

/**
 * Compose a reviewable evidence scaffold. This adapter is intentionally
 * literal: it joins confirmed theses, claims, and source excerpts, leaving
 * rhetorical improvement to a later writer implementation or human editor.
 */
export function composeEvidenceDraft(brief, evidencePacket, argumentMap, { styleProfileId = null, revision = 1 } = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  assertContractVersion(argumentMap, 'argumentMap', ARGUMENT_MAP_SCHEMA_VERSION);
  if (argumentMap.status !== 'confirmed') {
    throw new ContractError('argument_map_unconfirmed', 'Evidence writer requires a confirmed argument map', {
      mapId: argumentMap.mapId,
      status: argumentMap.status,
    });
  }
  if (evidencePacket.briefId !== brief.briefId || argumentMap.briefId !== brief.briefId || argumentMap.packetId !== evidencePacket.packetId) {
    throw new ContractError('lineage_mismatch', 'Evidence writer inputs do not share the same lineage');
  }

  const claimById = new Map(evidencePacket.claims.map((claim) => [claim.claimId, claim]));
  const sections = argumentMap.points.map((point) => {
    const paragraphs = point.claimIds.map((claimId) => {
      const claim = claimById.get(claimId);
      if (!claim) throw new ContractError('missing_claim', `Writer cannot find claim ${claimId}`, { claimId });
      const { source, excerpt } = sourceExcerpt(claim, evidencePacket);
      return {
        paragraphId: `${point.pointId}-paragraph-${claimId}`,
        text: `${point.thesis} 证据显示：${claim.text} 来源摘录：“${excerpt}”（${source.title}）。`,
        claimIds: [claimId],
      };
    });
    return { sectionId: point.pointId, order: point.order, heading: point.heading, paragraphs };
  });

  return createDraft(brief, argumentMap, {
    styleProfileId,
    revision,
    title: brief.topic,
    digest: `围绕“${brief.purpose}”，本文把每个判断放回可核对的主张和来源。`,
    lead: `这篇文章不先堆结论，而是从可核对的证据出发，逐步回答：${brief.purpose}`,
    sections,
    closingCta: '发布前请逐段核对主张、来源摘录和文章语气，再决定是否交付。',
    tags: ['证据写作'],
    assetSlots: [],
  });
}

function draftToInput(draft) {
  return {
    styleProfileId: draft.styleProfileId,
    revision: draft.revision,
    title: draft.title,
    digest: draft.digest,
    lead: draft.lead,
    sections: draft.sections,
    closingCta: draft.closingCta,
    tags: draft.tags,
    assetSlots: draft.assetSlots,
  };
}

/** Deterministic provider implementation for the WriterRequest contract. */
export function composeEvidenceWriterResponse(writerRequest) {
  assertContractVersion(writerRequest, 'writerRequest', WRITER_REQUEST_SCHEMA_VERSION);
  if (writerRequest.provider !== 'evidence-writer') {
    throw new ContractError('writer_provider_mismatch', 'Evidence writer can only handle provider=evidence-writer');
  }
  const draft = composeEvidenceDraft(
    writerRequest.brief,
    writerRequest.evidencePacket,
    writerRequest.argumentMap,
    { styleProfileId: writerRequest.styleProfile?.styleProfileId ?? null },
  );
  return createWriterResponse(writerRequest, {
    provider: 'evidence-writer',
    draftInput: draftToInput(draft),
    diagnostics: { deterministic: true, disclaimer: 'evidence scaffold; human revision required' },
  });
}
