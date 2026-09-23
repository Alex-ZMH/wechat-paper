import { assertContractVersion, freezeContract, makeId, optionalText, requiredText, sha256, ContractError } from '../lib/primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from './evidence-packet.mjs';

export const RESEARCH_SESSION_SCHEMA_VERSION = 'wechat-article-studio.research-session.v1';

/**
 * A research session records the accepted evidence boundary without implying
 * that an article has already been written. It is intentionally provider-
 * neutral so Bridge can later be replaced by another research adapter.
 */
export function createResearchSession(brief, evidencePacket, { provider = 'bridge', clientRunId, providerRef = null } = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  if (evidencePacket.briefId !== brief.briefId) {
    throw new ContractError('lineage_mismatch', 'Research evidence does not belong to the session brief', {
      briefId: brief.briefId,
      packetBriefId: evidencePacket.briefId,
    });
  }
  const core = {
    schemaVersion: RESEARCH_SESSION_SCHEMA_VERSION,
    parentIds: [brief.briefId, evidencePacket.packetId],
    briefId: brief.briefId,
    evidencePacketId: evidencePacket.packetId,
    provider: requiredText(provider, 'researchSession.provider'),
    providerRef: providerRef == null ? null : {
      packetId: requiredText(providerRef.packetId, 'researchSession.providerRef.packetId'),
      packetHash: requiredText(providerRef.packetHash, 'researchSession.providerRef.packetHash'),
    },
    clientRunId: optionalText(clientRunId, 'researchSession.clientRunId'),
    status: 'accepted',
  };
  return freezeContract({
    ...core,
    sessionId: makeId('research', core),
    sessionHash: sha256(core),
  });
}
