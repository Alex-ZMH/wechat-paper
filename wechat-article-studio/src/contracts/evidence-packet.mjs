import {
  assertContractVersion,
  assertUnique,
  ensureArray,
  ensureFiniteNumber,
  freezeContract,
  makeId,
  optionalText,
  requiredText,
  sha256,
  ContractError,
  assertOneOf,
} from '../lib/primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';

export const EVIDENCE_PACKET_SCHEMA_VERSION = 'wechat-article-studio.evidence-packet.v1';
export const EVIDENCE_SOURCE_ORIGINS = ['realtime_research', 'user_provided', 'human_curated', 'fixture'];

function normalizeSource(source, index) {
  return {
    sourceId: requiredText(source?.sourceId ?? `source-${index + 1}`, `sources[${index}].sourceId`),
    title: requiredText(source?.title, `sources[${index}].title`),
    url: optionalText(source?.url, `sources[${index}].url`),
    excerpt: requiredText(source?.excerpt, `sources[${index}].excerpt`),
    publisher: optionalText(source?.publisher, `sources[${index}].publisher`),
    publishedAt: optionalText(source?.publishedAt, `sources[${index}].publishedAt`),
    accessedAt: optionalText(source?.accessedAt, `sources[${index}].accessedAt`),
    sourceType: optionalText(source?.sourceType, `sources[${index}].sourceType`),
    sourceOrigin: assertOneOf(
      source?.sourceOrigin,
      `sources[${index}].sourceOrigin`,
      EVIDENCE_SOURCE_ORIGINS,
    ),
    authority: optionalText(source?.authority, `sources[${index}].authority`),
    locator: optionalText(source?.locator, `sources[${index}].locator`),
    usageStatus: optionalText(source?.usageStatus, `sources[${index}].usageStatus`),
    sourceFamilyId: optionalText(source?.sourceFamilyId, `sources[${index}].sourceFamilyId`),
  };
}

function normalizeClaim(claim, index, sourceIds) {
  const evidenceIds = ensureArray(claim?.evidenceIds ?? [], `claims[${index}].evidenceIds`, {
    allowEmpty: false,
  }).map((sourceId) => requiredText(sourceId, `claims[${index}].evidenceIds[]`));
  assertUnique(evidenceIds, `claims[${index}].evidenceIds`);
  if (evidenceIds.some((sourceId) => !sourceIds.has(sourceId))) {
    const missing = evidenceIds.find((sourceId) => !sourceIds.has(sourceId));
    throw new ContractError('missing_source', `Claim ${claim?.claimId ?? index + 1} references unknown source ${missing}`, {
      claimId: claim?.claimId,
      sourceId: missing,
    });
  }
  return {
    claimId: requiredText(claim?.claimId ?? `claim-${index + 1}`, `claims[${index}].claimId`),
    text: requiredText(claim?.text, `claims[${index}].text`),
    evidenceIds,
    confidence: ensureFiniteNumber(claim?.confidence, `claims[${index}].confidence`, 1),
    caveat: optionalText(claim?.caveat, `claims[${index}].caveat`),
    kind: optionalText(claim?.kind, `claims[${index}].kind`),
    status: optionalText(claim?.status, `claims[${index}].status`),
  };
}

/** Build a normalized, immutable evidence packet. Every claim must cite a source excerpt. */
export function createEvidencePacket(brief, input = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  const sources = ensureArray(input.sources ?? [], 'evidence.sources', { allowEmpty: false }).map(normalizeSource);
  // Check the normalized list before converting it to a Set. A Set silently
  // removes duplicate IDs, which would make the duplicate-source contract
  // check ineffective.
  assertUnique(sources.map((source) => source.sourceId), 'evidence.sources.sourceId');
  const sourceIds = new Set(sources.map((source) => source.sourceId));

  const claims = ensureArray(input.claims ?? [], 'evidence.claims', { allowEmpty: false }).map((claim, index) =>
    normalizeClaim(claim, index, sourceIds),
  );
  assertUnique(claims.map((claim) => claim.claimId), 'evidence.claims.claimId');

  const core = {
    schemaVersion: EVIDENCE_PACKET_SCHEMA_VERSION,
    parentIds: [brief.briefId],
    briefId: brief.briefId,
    sources,
    claims,
  };
  const packetHash = sha256(core);
  return freezeContract({
    ...core,
    packetId: makeId('packet', core),
    packetHash,
  });
}
