import {
  assertContractVersion,
  assertOneOf,
  ContractError,
  freezeContract,
  makeId,
  optionalText,
  requiredText,
  sha256,
} from '../lib/primitives.mjs';
import { BRIEF_SCHEMA_VERSION } from './brief.mjs';
import { EVIDENCE_PACKET_SCHEMA_VERSION } from './evidence-packet.mjs';
import { ARGUMENT_MAP_SCHEMA_VERSION } from './argument-map.mjs';
import { STYLE_PROFILE_SCHEMA_VERSION } from './style-profile.mjs';
import { DRAFT_SCHEMA_VERSION } from './draft.mjs';
import { ANNOTATION_SET_SCHEMA_VERSION } from './annotation-set.mjs';

export const WRITER_REQUEST_SCHEMA_VERSION = 'wechat-article-studio.writer-request.v1';
export const WRITER_RESPONSE_SCHEMA_VERSION = 'wechat-article-studio.writer-response.v1';

function snapshot(value) {
  return value == null ? null : structuredClone(value);
}

/** Freeze the exact editorial context a provider is allowed to consume. */
export function createWriterRequest({
  brief,
  evidencePacket,
  argumentMap,
  styleProfile = null,
  draft = null,
  annotationSet = null,
  mode = 'initial_generation',
  provider = 'bridge',
  model,
  clientRunId,
} = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  assertContractVersion(evidencePacket, 'evidencePacket', EVIDENCE_PACKET_SCHEMA_VERSION);
  assertContractVersion(argumentMap, 'argumentMap', ARGUMENT_MAP_SCHEMA_VERSION);
  if (styleProfile) assertContractVersion(styleProfile, 'styleProfile', STYLE_PROFILE_SCHEMA_VERSION);
  if (draft) assertContractVersion(draft, 'draft', DRAFT_SCHEMA_VERSION);
  if (annotationSet) assertContractVersion(annotationSet, 'annotationSet', ANNOTATION_SET_SCHEMA_VERSION);
  assertOneOf(mode, 'writerRequest.mode', ['initial_generation', 'annotation_regeneration']);
  if (argumentMap.status !== 'confirmed') {
    throw new ContractError('argument_map_unconfirmed', 'Writer requests require a confirmed argument map', {
      mapId: argumentMap.mapId,
      status: argumentMap.status,
    });
  }
  if (brief.briefId !== evidencePacket.briefId || brief.briefId !== argumentMap.briefId || argumentMap.packetId !== evidencePacket.packetId) {
    throw new ContractError('lineage_mismatch', 'Writer request inputs do not share the same lineage');
  }
  if (styleProfile && draft?.styleProfileId && draft.styleProfileId !== styleProfile.styleProfileId) {
    throw new ContractError('lineage_mismatch', 'Writer request draft does not belong to the supplied style profile');
  }
  if (mode === 'annotation_regeneration' && (!draft || !annotationSet)) {
    throw new ContractError('writer_context_missing', 'Annotation regeneration requires both a draft and an annotation set');
  }
  if (annotationSet && draft && annotationSet.baseDraftId !== draft.draftId) {
    throw new ContractError('stale_annotation_set', 'Writer request annotation set targets a different draft');
  }

  const core = {
    schemaVersion: WRITER_REQUEST_SCHEMA_VERSION,
    parentIds: [brief.briefId, evidencePacket.packetId, argumentMap.mapId, ...(styleProfile ? [styleProfile.styleProfileId] : []), ...(draft ? [draft.draftId] : []), ...(annotationSet ? [annotationSet.annotationSetId] : [])],
    mode,
    provider: requiredText(provider, 'writerRequest.provider'),
    model: optionalText(model, 'writerRequest.model'),
    clientRunId: optionalText(clientRunId, 'writerRequest.clientRunId'),
    brief: snapshot(brief),
    evidencePacket: snapshot(evidencePacket),
    argumentMap: snapshot(argumentMap),
    styleProfile: snapshot(styleProfile),
    draft: snapshot(draft),
    annotationSet: snapshot(annotationSet),
  };
  return freezeContract({
    ...core,
    requestId: makeId('writer-request', core),
    requestHash: sha256(core),
  });
}

/** Validate a provider result without allowing it to silently change request context. */
export function createWriterResponse(request, {
  status = 'completed',
  provider,
  model,
  draftInput = null,
  error = null,
  diagnostics = {},
} = {}) {
  assertContractVersion(request, 'writerRequest', WRITER_REQUEST_SCHEMA_VERSION);
  assertOneOf(status, 'writerResponse.status', ['completed', 'failed']);
  if (status === 'completed' && (!draftInput || typeof draftInput !== 'object' || Array.isArray(draftInput))) {
    throw new ContractError('writer_response_invalid', 'Completed writer responses must include a structured draftInput');
  }
  if (status === 'failed' && !error) {
    throw new ContractError('writer_response_invalid', 'Failed writer responses must include an error');
  }
  const core = {
    schemaVersion: WRITER_RESPONSE_SCHEMA_VERSION,
    parentIds: [request.requestId],
    requestId: request.requestId,
    status,
    provider: requiredText(provider ?? request.provider, 'writerResponse.provider'),
    model: optionalText(model ?? request.model, 'writerResponse.model'),
    draftInput: status === 'completed' ? snapshot(draftInput) : null,
    error: status === 'failed' ? requiredText(String(error), 'writerResponse.error') : null,
    diagnostics: snapshot(diagnostics) ?? {},
  };
  return freezeContract({
    ...core,
    responseId: makeId('writer-response', core),
    responseHash: sha256(core),
  });
}
