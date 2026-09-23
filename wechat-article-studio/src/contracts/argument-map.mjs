import {
  assertContractVersion,
  assertUnique,
  ensureArray,
  freezeContract,
  makeId,
  requiredText,
  sha256,
  assertOneOf,
  ContractError,
} from '../lib/primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from './evidence-packet.mjs';

export const ARGUMENT_MAP_SCHEMA_VERSION = 'wechat-article-studio.argument-map.v1';

function normalizePoint(point, index, claimIds) {
  const pointClaimIds = ensureArray(point?.claimIds ?? [], `argumentMap.points[${index}].claimIds`, {
    allowEmpty: false,
  }).map((claimId) => requiredText(claimId, `argumentMap.points[${index}].claimIds[]`));
  assertUnique(pointClaimIds, `argumentMap.points[${index}].claimIds`);
  const unknownClaim = pointClaimIds.find((claimId) => !claimIds.has(claimId));
  if (unknownClaim) {
    throw new ContractError('missing_claim', `Argument point references unknown claim ${unknownClaim}`, {
      pointId: point?.pointId,
      claimId: unknownClaim,
    });
  }
  return {
    pointId: requiredText(point?.pointId ?? `point-${index + 1}`, `argumentMap.points[${index}].pointId`),
    order: Number.isInteger(point?.order) ? point.order : index + 1,
    heading: requiredText(point?.heading, `argumentMap.points[${index}].heading`),
    thesis: requiredText(point?.thesis, `argumentMap.points[${index}].thesis`),
    claimIds: pointClaimIds,
  };
}

function assertConfirmedPoint(point, index) {
  if (point.heading.startsWith('待编辑：') || point.thesis.startsWith('请结合来源摘录')) {
    throw new ContractError('argument_map_incomplete', `argumentMap.points[${index}] still contains an editor placeholder`, {
      pointId: point.pointId,
    });
  }
}

/** Map each editorial point to packet claims before prose is generated. */
export function createArgumentMap(brief, evidencePacket, input = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  if (evidencePacket.briefId !== brief.briefId) {
    throw new ContractError('lineage_mismatch', 'Evidence packet does not belong to brief', {
      briefId: brief.briefId,
      packetBriefId: evidencePacket.briefId,
    });
  }
  const claimIds = new Set(evidencePacket.claims.map((claim) => claim.claimId));
  const status = assertOneOf(input.status ?? 'confirmed', 'argumentMap.status', ['draft', 'confirmed']);
  if (status === 'draft' && input.allowIncomplete !== true) {
    throw new ContractError('argument_map_unconfirmed', 'Draft-status argument maps must be edited and confirmed before writing');
  }
  const points = ensureArray(input.points ?? [], 'argumentMap.points', { allowEmpty: false }).map((point, index) =>
    normalizePoint(point, index, claimIds),
  );
  if (status === 'confirmed') points.forEach(assertConfirmedPoint);
  assertUnique(points.map((point) => point.pointId), 'argumentMap.points.pointId');

  const core = {
    schemaVersion: ARGUMENT_MAP_SCHEMA_VERSION,
    parentIds: [brief.briefId, evidencePacket.packetId],
    briefId: brief.briefId,
    packetId: evidencePacket.packetId,
    status,
    points: points.sort((a, b) => a.order - b.order || a.pointId.localeCompare(b.pointId)),
  };
  return freezeContract({
    ...core,
    mapId: makeId('map', core),
    mapHash: sha256(core),
  });
}

/**
 * Build a usable initial outline directly from real claims. Editing remains
 * optional; the current outline is adopted when writing begins.
 */
export function createArgumentMapSkeleton(brief, evidencePacket) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  const points = evidencePacket.claims.map((claim, index) => ({
    pointId: `point-${claim.claimId}`,
    order: index + 1,
    heading: claim.text.slice(0, 36),
    thesis: claim.caveat ? `${claim.text}（适用边界：${claim.caveat}）` : claim.text,
    claimIds: [claim.claimId],
  }));
  return createArgumentMap(brief, evidencePacket, { points, status: 'confirmed' });
}
