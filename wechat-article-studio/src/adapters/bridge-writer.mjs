import { assertContractVersion, ContractError, requiredText } from '../lib/primitives.mjs';
import { WRITER_REQUEST_SCHEMA_VERSION, createWriterResponse } from '../contracts/writer.mjs';

export const BRIDGE_CONTENT_REQUEST_SCHEMA_VERSION = 'content-desk.request.v2';

function bridgeRef(value) {
  const packetId = requiredText(value?.packetId, 'bridgeEvidenceRef.packetId');
  const packetHash = requiredText(value?.packetHash, 'bridgeEvidenceRef.packetHash');
  if (!/^ep-[A-Za-z0-9][A-Za-z0-9_:-]*$/u.test(packetId) || !/^[a-f0-9]{64}$/u.test(packetHash)) {
    throw new ContractError('invalid_evidence_ref', 'Bridge writer requires a server-owned packetId and packetHash');
  }
  return { packetId, packetHash };
}

function draftText(draft) {
  if (!draft) return '';
  return [
    draft.title,
    draft.lead,
    ...draft.sections.flatMap((section) => [section.heading, ...section.paragraphs.map((paragraph) => paragraph.text)]),
    draft.closingCta,
  ].filter(Boolean).join('\n\n');
}

/**
 * Map the provider-neutral request to the legacy Bridge v2 schema. The raw
 * evidence packet is deliberately omitted; only Bridge-owned id+hash may
 * authorize a research-writing call.
 */
export function toBridgeWriterRequest(writerRequest, {
  bridgeEvidenceRef,
  writerModel,
  reviewerModel,
  dualReview = true,
} = {}) {
  assertContractVersion(writerRequest, 'writerRequest', WRITER_REQUEST_SCHEMA_VERSION);
  if (writerRequest.provider !== 'bridge') {
    throw new ContractError('writer_provider_mismatch', 'Bridge adapter requires provider=bridge');
  }
  const ref = bridgeRef(bridgeEvidenceRef);
  const brief = writerRequest.brief;
  const styleProfile = writerRequest.styleProfile;
  const payload = {
    schemaVersion: BRIDGE_CONTENT_REQUEST_SCHEMA_VERSION,
    task: {
      kind: 'research_writing',
      domain: 'general',
      genre: '微信公众号文章',
      channel: brief.channel,
      purpose: brief.purpose,
    },
    mode: writerRequest.mode,
    brief: {
      topic: brief.topic,
      audience: brief.audience,
      format: '微信公众号文章',
      tone: styleProfile?.name ?? brief.tone,
      targetLength: String(brief.targetLength),
      materials: brief.materials.map((item) => item.text).join('\n'),
    },
    targetLength: brief.targetLength,
    evidencePacketId: ref.packetId,
    evidencePacketHash: ref.packetHash,
    skillChain: ['topic-evidence-research', ...(styleProfile ? ['writing-dna'] : [])],
    dnaMode: styleProfile ? 'writing' : 'none',
    protectedFacts: writerRequest.evidencePacket.claims.map((claim) => claim.text),
    voiceProfile: styleProfile ? { tone: styleProfile.name, traits: styleProfile.principles } : undefined,
    clientRunId: writerRequest.clientRunId || undefined,
    writerModel,
    reviewerModel,
    dualReview,
  };
  if (writerRequest.mode === 'annotation_regeneration') {
    payload.previousGeneratedDraft = draftText(writerRequest.draft);
    payload.currentDraft = draftText(writerRequest.draft);
    payload.annotations = writerRequest.annotationSet.annotations.map((annotation) => ({
      id: annotation.annotationId,
      note: annotation.instruction || '请根据该批注修订对应段落。',
      resolved: annotation.status === 'resolved',
    }));
  }
  return Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined));
}

/**
 * Accept only a future structured Bridge response. The current legacy Bridge
 * returns plain text; refusing to guess claim-to-paragraph bindings is safer
 * than presenting an unverifiable Draft as complete.
 */
export function normalizeBridgeWriterResponse(writerRequest, raw) {
  assertContractVersion(writerRequest, 'writerRequest', WRITER_REQUEST_SCHEMA_VERSION);
  if (!raw || typeof raw !== 'object') throw new ContractError('writer_response_invalid', 'Bridge writer response must be an object');
  if (raw.draftInput && typeof raw.draftInput === 'object') {
    return createWriterResponse(writerRequest, {
      status: raw.status === 'failed' ? 'failed' : 'completed',
      provider: 'bridge',
      model: raw.model,
      draftInput: raw.draftInput,
      error: raw.error,
      diagnostics: raw.diagnostics,
    });
  }
  if (typeof raw.draft === 'string' && raw.draft.trim()) {
    throw new ContractError('writer_response_unstructured', 'Bridge returned plain draft text; structured claim bindings are required before Draft creation');
  }
  throw new ContractError('writer_response_invalid', 'Bridge writer response lacks a structured draftInput');
}

export async function fetchBridgeWriter(writerRequest, {
  bridgeEvidenceRef,
  baseUrl = process.env.CONTENT_DESK_BRIDGE_URL || 'http://127.0.0.1:43127',
  fetchImpl = globalThis.fetch,
  signal,
  writerModel,
  reviewerModel,
  dualReview = true,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new ContractError('missing_fetch', 'A fetch implementation is required');
  const response = await fetchImpl(`${baseUrl.replace(/\/$/u, '')}/v1/content`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(toBridgeWriterRequest(writerRequest, { bridgeEvidenceRef, writerModel, reviewerModel, dualReview })),
    signal,
  });
  const raw = await response.json();
  if (!response.ok) throw new ContractError(raw?.code || 'writer_failed', raw?.error || `Bridge writer failed with HTTP ${response.status}`, { status: response.status });
  return normalizeBridgeWriterResponse(writerRequest, raw);
}
