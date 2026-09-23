import { ARGUMENT_MAP_SCHEMA_VERSION } from './argument-map.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';
import { DRAFT_SCHEMA_VERSION } from './draft.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from './evidence-packet.mjs';
import { REVIEW_REPORT_SCHEMA_VERSION } from './review-report.mjs';
import {
  assertContractVersion,
  freezeContract,
  makeId,
  sha256,
  ContractError,
} from '../lib/primitives.mjs';

export const WECHAT_PACKAGE_SCHEMA_VERSION = 'wechat-article-studio.wechat-package.v1';

const INTERNAL_TOKEN_PATTERN = /(?:\[(?:claim|source|evidence|internal):[^\]\r\n]+\]|\{\{(?:claim|source|evidence|internal):[^}\r\n]+\}\}|<!--\s*internal:[\s\S]*?-->)/giu;

/** Remove editorial trace tokens before a package can leave the studio. */
export function cleanInternalTokens(value) {
  return String(value ?? '')
    .replace(INTERNAL_TOKEN_PATTERN, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\s+([，。；：、！？,.!?])/gu, '$1')
    .replace(/([（(])\s+/gu, '$1')
    .replace(/\s+([）)])/gu, '$1')
    .trim();
}

function escapeHtml(value) {
  return cleanInternalTokens(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderBody(draft) {
  const chunks = [`<h1>${escapeHtml(draft.title)}</h1>`, `<p class="lead">${escapeHtml(draft.lead)}</p>`];
  for (const section of draft.sections) {
    chunks.push(`<h2>${escapeHtml(section.heading)}</h2>`);
    for (const paragraph of section.paragraphs) {
      chunks.push(`<p>${escapeHtml(paragraph.text)}</p>`);
    }
  }
  chunks.push(`<p class="closing-cta">${escapeHtml(draft.closingCta)}</p>`);
  return chunks.join('\n');
}

function renderMarkdown(draft) {
  const chunks = [`# ${cleanInternalTokens(draft.title)}`, `> ${cleanInternalTokens(draft.lead)}`];
  for (const section of draft.sections) {
    chunks.push(`## ${cleanInternalTokens(section.heading)}`);
    for (const paragraph of section.paragraphs) chunks.push(cleanInternalTokens(paragraph.text));
  }
  chunks.push(cleanInternalTokens(draft.closingCta));
  return chunks.join('\n\n');
}

function buildSourceLedger(evidencePacket) {
  return evidencePacket.claims.map((claim) => {
    const sources = claim.evidenceIds.map((sourceId) => evidencePacket.sources.find((source) => source.sourceId === sourceId)).filter(Boolean);
    return {
      claimId: claim.claimId,
      claimText: claim.text,
      sources: sources.map((source) => ({ sourceId: source.sourceId, title: source.title, url: source.url })),
    };
  });
}

/**
 * Convert structured content into a WeChat-ready package. Review findings
 * remain visible suggestions, not delivery authorization.
 */
export function createWechatPackage({ brief, evidencePacket, argumentMap, draft, review } = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  assertContractVersion(argumentMap, 'argumentMap', ARGUMENT_MAP_SCHEMA_VERSION);
  assertContractVersion(draft, 'draft', DRAFT_SCHEMA_VERSION);
  assertContractVersion(review, 'review', REVIEW_REPORT_SCHEMA_VERSION);

  if (
    brief.briefId !== evidencePacket.briefId ||
    brief.briefId !== argumentMap.briefId ||
    brief.briefId !== draft.briefId ||
    review.draftId !== draft.draftId ||
    evidencePacket.packetId !== argumentMap.packetId ||
    argumentMap.mapId !== draft.argumentMapId
  ) {
    throw new ContractError('lineage_mismatch', 'Wechat package inputs do not share the same lineage');
  }

  const selectedClaims = new Set(argumentMap.points.flatMap(point => point.claimIds));
  for (const paragraph of draft.sections.flatMap(section => section.paragraphs)) {
    const unknown = paragraph.claimIds.find(id => !selectedClaims.has(id));
    if (unknown) throw new ContractError('missing_claim', `Paragraph references unknown claim ${unknown}`, { claimId: unknown });
  }

  const bodyHtml = renderBody(draft);
  const contentCore = {
    metadata: {
      title: cleanInternalTokens(draft.title),
      digest: cleanInternalTokens(draft.digest),
      author: cleanInternalTokens(brief.authorName),
      channel: cleanInternalTokens(brief.channel),
    },
    bodyHtml,
    bodyMarkdown: renderMarkdown(draft),
    sourceLedger: buildSourceLedger(evidencePacket),
    tags: draft.tags.map(cleanInternalTokens),
    assetSlots: draft.assetSlots,
  };
  const core = {
    schemaVersion: WECHAT_PACKAGE_SCHEMA_VERSION,
    parentIds: [brief.briefId, evidencePacket.packetId, argumentMap.mapId, draft.draftId, review.reviewId],
    briefId: brief.briefId,
    draftId: draft.draftId,
    reviewId: review.reviewId,
    status: 'ready',
    ...contentCore,
    deliveryBlockers: [],
  };
  return freezeContract({
    ...core,
    packageId: makeId('wechat', core),
    contentHash: sha256(contentCore),
  });
}

/** The final side-effect boundary validates the contract, not old review flags. */
export function deliverWechatPackage(wechatPackage) {
  if (!wechatPackage || wechatPackage.schemaVersion !== WECHAT_PACKAGE_SCHEMA_VERSION) {
    throw new ContractError('schema_mismatch', 'Expected a WechatPackage contract');
  }
  return freezeContract({
    status: 'queued',
    packageId: wechatPackage.packageId,
    contentHash: wechatPackage.contentHash,
  });
}
