/**
 * Project-owned validator for content-desk.evidence-packet.v1.
 *
 * This module intentionally has no network or host-tool dependency.  It only
 * validates the frozen, server-owned artifact that a research run is allowed
 * to hand to the writing pipeline.  Web pages remain data; their text is
 * never interpreted as instructions by this validator.
 */

export const EVIDENCE_PACKET_SCHEMA_VERSION = 'content-desk.evidence-packet.v1';
export const EVIDENCE_PACKET_MAX_SOURCES = 40;
export const EVIDENCE_PACKET_MAX_CLAIMS = 100;
export const EVIDENCE_PACKET_MAX_UNCERTAINTIES = 80;

const TOP_LEVEL_FIELDS = new Set([
  'schemaVersion', 'packetId', 'packetHash', 'topic', 'scope', 'retrieval',
  'researchStatus', 'retrievalStatus', 'createdAt', 'sources', 'claims',
  'uncertainties', 'audit',
]);
const SCOPE_FIELDS = new Set([
  'question', 'audience', 'domain', 'genre', 'channel', 'jurisdiction',
  'include', 'exclude', 'cutoff', 'sourceTypes',
]);
const RETRIEVAL_FIELDS = new Set(['queries', 'mode', 'startedAt', 'completedAt']);
const SOURCE_FIELDS = new Set([
  'sourceId', 'title', 'url', 'publisher', 'sourceType', 'authority',
  'publishedAt', 'accessedAt', 'accessStatus', 'usageStatus', 'sourceFamilyId',
  'excerpt', 'locator', 'contentHash',
]);
const CLAIM_FIELDS = new Set([
  'claimId', 'text', 'kind', 'sourceIds', 'evidence', 'confidence', 'status', 'basis',
]);
const EVIDENCE_FIELDS = new Set(['sourceId', 'excerpt', 'locator']);
const UNCERTAINTY_FIELDS = new Set(['uncertaintyId', 'text', 'claimIds', 'action']);
const AUDIT_FIELDS = new Set([
  'status', 'auditorModel', 'auditedAt', 'sourceChecks', 'claimChecks', 'issues',
  'summary', 'independence',
]);
const CHECK_FIELDS = new Set(['sourceId', 'claimId', 'status', 'issues']);
const STATUSES = new Set(['complete', 'partial', 'blocked', 'manual_required']);
const SOURCE_TYPES = new Set([
  'paper', 'standard', 'government', 'official', 'dataset', 'research_institution',
  'industry_association', 'vendor', 'independent', 'news', 'other',
]);
const AUTHORITY = new Set(['A', 'B', 'C', 'U']);
const ACCESS_STATUS = new Set(['accessible', 'partial', 'blocked', 'manual_required']);
const USAGE_STATUS = new Set(['allowed', 'metadata_only', 'manual_required', 'unknown']);
const CLAIM_KINDS = new Set(['fact', 'definition', 'metric', 'case_result', 'vendor_claim', 'inference', 'opinion']);
const CLAIM_CONFIDENCE = new Set(['high', 'medium', 'low', 'disputed']);
const CLAIM_STATUS = new Set(['supported', 'mixed', 'unverified', 'rejected']);

export class EvidencePacketValidationError extends Error {
  constructor(message, path = '') {
    super(path ? `${path}: ${message}` : message);
    this.name = 'EvidencePacketValidationError';
    this.path = path;
    this.code = 'evidence_packet_invalid';
  }
}

function fail(message, path) {
  throw new EvidencePacketValidationError(message, path);
}

function object(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('必须是对象', path);
  return value;
}

function fields(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`包含不支持字段 ${key}`, path);
  return value;
}

function text(value, path, { required = false, max = 4_000 } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('不能为空', path);
    return '';
  }
  if (typeof value !== 'string') fail('必须是文本', path);
  if (!value.trim() && required) fail('不能为空', path);
  if (value.length > max) fail(`长度不得超过 ${max}`, path);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) fail('含有控制字符', path);
  return value;
}

function list(value, path, max) {
  if (!Array.isArray(value) || value.length > max) fail(`必须是 0-${max} 项数组`, path);
  return value;
}

function isoDate(value, path, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('必须是 ISO 日期或时间', path);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/u.test(value)) {
    fail('必须是 YYYY-MM-DD 或 UTC ISO 时间', path);
  }
  const date = new Date(value.includes('T') ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) fail('日期无效', path);
  return value;
}

function id(value, path, prefix) {
  const result = text(value, path, { required: true, max: 128 });
  if (!new RegExp(`^${prefix}[A-Za-z0-9][A-Za-z0-9_:-]*$`, 'u').test(result)) fail('标识格式无效', path);
  return result;
}

function httpUrl(value, path) {
  const url = text(value, path, { required: true, max: 4_000 });
  let parsed;
  try { parsed = new URL(url); } catch { fail('URL 无效', path); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('只允许 http/https URL', path);
  return url;
}

function stringArray(value, path, { maxItems = 20, itemMax = 500, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('不能为空', path);
    return [];
  }
  const values = list(value, path, maxItems);
  return values.map((item, index) => text(item, `${path}[${index}]`, { required: true, max: itemMax }));
}

function validateSource(value, index) {
  const path = `sources[${index}]`;
  fields(value, SOURCE_FIELDS, path);
  const source = {
    sourceId: id(value.sourceId, `${path}.sourceId`, 's-'),
    title: text(value.title, `${path}.title`, { required: true, max: 500 }),
    url: httpUrl(value.url, `${path}.url`),
    publisher: text(value.publisher, `${path}.publisher`, { required: true, max: 300 }),
    sourceType: text(value.sourceType, `${path}.sourceType`, { required: true, max: 64 }),
    authority: text(value.authority, `${path}.authority`, { required: true, max: 1 }),
    publishedAt: isoDate(value.publishedAt, `${path}.publishedAt`),
    accessedAt: isoDate(value.accessedAt, `${path}.accessedAt`, { required: true }),
    accessStatus: text(value.accessStatus, `${path}.accessStatus`, { required: true, max: 32 }),
    usageStatus: text(value.usageStatus, `${path}.usageStatus`, { required: true, max: 32 }),
    sourceFamilyId: text(value.sourceFamilyId, `${path}.sourceFamilyId`, { max: 128 }) || null,
    excerpt: text(value.excerpt, `${path}.excerpt`, { max: 1_200 }) || null,
    locator: text(value.locator, `${path}.locator`, { max: 500 }) || null,
    contentHash: text(value.contentHash, `${path}.contentHash`, { max: 128 }) || null,
  };
  if (!SOURCE_TYPES.has(source.sourceType)) fail('sourceType 不受支持', `${path}.sourceType`);
  if (!AUTHORITY.has(source.authority)) fail('authority 必须为 A/B/C/U', `${path}.authority`);
  if (!ACCESS_STATUS.has(source.accessStatus)) fail('accessStatus 不受支持', `${path}.accessStatus`);
  if (!USAGE_STATUS.has(source.usageStatus)) fail('usageStatus 不受支持', `${path}.usageStatus`);
  if (source.usageStatus === 'allowed' && !['accessible', 'partial'].includes(source.accessStatus)) {
    fail('usageStatus=allowed 时 accessStatus 必须是 accessible 或 partial', path);
  }
  if (source.accessStatus === 'accessible' && source.usageStatus === 'allowed' && !source.excerpt) {
    fail('可用来源必须提供短证据摘录', path);
  }
  return source;
}

function validateEvidence(value, index, sourceIds) {
  const path = `evidence[${index}]`;
  fields(value, EVIDENCE_FIELDS, path);
  const sourceId = id(value.sourceId, `${path}.sourceId`, 's-');
  if (!sourceIds.has(sourceId)) fail('引用了不存在的 sourceId', `${path}.sourceId`);
  return {
    sourceId,
    excerpt: text(value.excerpt, `${path}.excerpt`, { required: true, max: 1_200 }),
    locator: text(value.locator, `${path}.locator`, { max: 500 }) || null,
  };
}

function validateClaim(value, index, sourceIds) {
  const path = `claims[${index}]`;
  fields(value, CLAIM_FIELDS, path);
  const sourceIdValues = stringArray(value.sourceIds, `${path}.sourceIds`, { maxItems: EVIDENCE_PACKET_MAX_SOURCES, itemMax: 128, required: true });
  const sourceIdSet = new Set(sourceIdValues);
  if (sourceIdSet.size !== sourceIdValues.length) fail('sourceIds 不得重复', `${path}.sourceIds`);
  for (const sourceId of sourceIdSet) {
    if (!/^s-[A-Za-z0-9][A-Za-z0-9_:-]*$/u.test(sourceId) || !sourceIds.has(sourceId)) fail('引用了不存在的 sourceId', `${path}.sourceIds`);
  }
  const claim = {
    claimId: id(value.claimId, `${path}.claimId`, 'c-'),
    text: text(value.text, `${path}.text`, { required: true, max: 1_500 }),
    kind: text(value.kind, `${path}.kind`, { required: true, max: 64 }),
    sourceIds: sourceIdValues,
    evidence: list(value.evidence ?? [], `${path}.evidence`, EVIDENCE_PACKET_MAX_SOURCES)
      .map((item, itemIndex) => validateEvidence(item, itemIndex, sourceIds)),
    confidence: text(value.confidence, `${path}.confidence`, { required: true, max: 16 }),
    status: text(value.status, `${path}.status`, { required: true, max: 32 }),
    basis: text(value.basis, `${path}.basis`, { max: 1_000 }) || null,
  };
  if (!CLAIM_KINDS.has(claim.kind)) fail('kind 不受支持', `${path}.kind`);
  if (!CLAIM_CONFIDENCE.has(claim.confidence)) fail('confidence 不受支持', `${path}.confidence`);
  if (!CLAIM_STATUS.has(claim.status)) fail('status 不受支持', `${path}.status`);
  if (['fact', 'definition', 'metric', 'case_result'].includes(claim.kind)
    && (claim.sourceIds.length === 0 || claim.evidence.length === 0)) {
    fail('事实类 claim 必须有来源和证据摘录', path);
  }
  if (claim.kind === 'vendor_claim'
    && !claim.sourceIds.some((sourceId) => sourceIds.get(sourceId)?.sourceType === 'vendor')) {
    fail('vendor_claim 必须至少引用一个 vendor 来源', path);
  }
  return claim;
}

function validateUncertainty(value, index, claimIds) {
  const path = `uncertainties[${index}]`;
  fields(value, UNCERTAINTY_FIELDS, path);
  const related = stringArray(value.claimIds, `${path}.claimIds`, { maxItems: EVIDENCE_PACKET_MAX_CLAIMS, itemMax: 128 });
  for (const claimId of related) if (!claimIds.has(claimId)) fail('引用了不存在的 claimId', `${path}.claimIds`);
  return {
    uncertaintyId: id(value.uncertaintyId, `${path}.uncertaintyId`, 'u-'),
    text: text(value.text, `${path}.text`, { required: true, max: 1_000 }),
    claimIds: related,
    action: text(value.action, `${path}.action`, { max: 1_000 }) || null,
  };
}

function validateAudit(value, sourceIds, claimIds, { requireAudit }) {
  if (value === undefined || value === null) {
    if (requireAudit) fail('缺少来源审计回执', 'audit');
    return null;
  }
  const path = 'audit';
  fields(value, AUDIT_FIELDS, path);
  const sourceChecks = list(value.sourceChecks ?? [], `${path}.sourceChecks`, EVIDENCE_PACKET_MAX_SOURCES).map((item, index) => {
    const checkPath = `${path}.sourceChecks[${index}]`;
    fields(item, CHECK_FIELDS, checkPath);
    const sourceId = id(item.sourceId, `${checkPath}.sourceId`, 's-');
    if (!sourceIds.has(sourceId)) fail('引用了不存在的 sourceId', `${checkPath}.sourceId`);
    return {
      sourceId,
      status: text(item.status, `${checkPath}.status`, { required: true, max: 16 }),
      issues: stringArray(item.issues, `${checkPath}.issues`, { maxItems: 8, itemMax: 500 }),
    };
  });
  const claimChecks = list(value.claimChecks ?? [], `${path}.claimChecks`, EVIDENCE_PACKET_MAX_CLAIMS).map((item, index) => {
    const checkPath = `${path}.claimChecks[${index}]`;
    fields(item, CHECK_FIELDS, checkPath);
    const claimId = id(item.claimId, `${checkPath}.claimId`, 'c-');
    if (!claimIds.has(claimId)) fail('引用了不存在的 claimId', `${checkPath}.claimId`);
    return {
      claimId,
      status: text(item.status, `${checkPath}.status`, { required: true, max: 16 }),
      issues: stringArray(item.issues, `${checkPath}.issues`, { maxItems: 8, itemMax: 500 }),
    };
  });
  const audit = {
    status: text(value.status, `${path}.status`, { required: true, max: 16 }),
    auditorModel: text(value.auditorModel, `${path}.auditorModel`, { required: true, max: 128 }),
    auditedAt: isoDate(value.auditedAt, `${path}.auditedAt`, { required: true }),
    sourceChecks,
    claimChecks,
    issues: stringArray(value.issues, `${path}.issues`, { maxItems: 30, itemMax: 500 }),
    summary: text(value.summary, `${path}.summary`, { max: 2_000 }) || null,
    independence: text(value.independence, `${path}.independence`, { max: 1_000 }) || null,
  };
  if (!['passed', 'failed'].includes(audit.status)) fail('status 必须是 passed 或 failed', `${path}.status`);
  if (requireAudit && audit.status !== 'passed') fail('来源审计未通过', path);
  const sourceCheckIds = new Set(sourceChecks.map((item) => item.sourceId));
  const claimCheckIds = new Set(claimChecks.map((item) => item.claimId));
  if (requireAudit && sourceCheckIds.size !== sourceIds.size) fail('审计未覆盖全部来源', `${path}.sourceChecks`);
  if (requireAudit && claimCheckIds.size !== claimIds.size) fail('审计未覆盖全部主张', `${path}.claimChecks`);
  return audit;
}

export function validateEvidencePacket(value, { requireAudit = true, requirePacketHash = false } = {}) {
  const packet = fields(value, TOP_LEVEL_FIELDS, 'packet');
  if (packet.schemaVersion !== EVIDENCE_PACKET_SCHEMA_VERSION) fail('schemaVersion 不受支持', 'schemaVersion');
  const packetId = id(packet.packetId, 'packetId', 'ep-');
  const topic = text(packet.topic, 'topic', { required: true, max: 12_000 });
  const scopeValue = packet.scope ?? {};
  fields(scopeValue, SCOPE_FIELDS, 'scope');
  const scope = {
    question: text(scopeValue.question, 'scope.question', { max: 4_000 }) || null,
    audience: text(scopeValue.audience, 'scope.audience', { max: 500 }) || null,
    domain: text(scopeValue.domain, 'scope.domain', { max: 500 }) || null,
    genre: text(scopeValue.genre, 'scope.genre', { max: 500 }) || null,
    channel: text(scopeValue.channel, 'scope.channel', { max: 500 }) || null,
    jurisdiction: text(scopeValue.jurisdiction, 'scope.jurisdiction', { max: 500 }) || null,
    include: stringArray(scopeValue.include, 'scope.include', { maxItems: 20, itemMax: 500 }),
    exclude: stringArray(scopeValue.exclude, 'scope.exclude', { maxItems: 20, itemMax: 500 }),
    cutoff: isoDate(scopeValue.cutoff, 'scope.cutoff', { required: true }),
    sourceTypes: stringArray(scopeValue.sourceTypes, 'scope.sourceTypes', { maxItems: 12, itemMax: 64 }),
  };
  const retrievalValue = packet.retrieval ?? {};
  fields(retrievalValue, RETRIEVAL_FIELDS, 'retrieval');
  const retrieval = {
    queries: stringArray(retrievalValue.queries, 'retrieval.queries', { maxItems: 40, itemMax: 500, required: true }),
    mode: text(retrievalValue.mode, 'retrieval.mode', { required: true, max: 64 }),
    startedAt: isoDate(retrievalValue.startedAt, 'retrieval.startedAt', { required: true }),
    completedAt: isoDate(retrievalValue.completedAt, 'retrieval.completedAt', { required: true }),
  };
  const researchStatus = text(packet.researchStatus, 'researchStatus', { required: true, max: 32 });
  const retrievalStatus = text(packet.retrievalStatus, 'retrievalStatus', { required: true, max: 32 });
  if (!STATUSES.has(researchStatus) || !STATUSES.has(retrievalStatus)) fail('researchStatus/retrievalStatus 不受支持', 'packet');
  const createdAt = isoDate(packet.createdAt, 'createdAt', { required: true });
  const sources = list(packet.sources, 'sources', EVIDENCE_PACKET_MAX_SOURCES).map(validateSource);
  if (sources.length === 0 && researchStatus === 'complete') fail('complete packet 必须有来源', 'sources');
  const sourceMap = new Map();
  for (const source of sources) {
    if (sourceMap.has(source.sourceId)) fail('sourceId 必须唯一', 'sources');
    sourceMap.set(source.sourceId, source);
  }
  const claimsRaw = list(packet.claims, 'claims', EVIDENCE_PACKET_MAX_CLAIMS);
  const claims = claimsRaw.map((item, index) => validateClaim(item, index, sourceMap));
  const claimIds = new Set();
  for (const claim of claims) {
    if (claimIds.has(claim.claimId)) fail('claimId 必须唯一', 'claims');
    claimIds.add(claim.claimId);
  }
  const uncertaintyRaw = list(packet.uncertainties, 'uncertainties', EVIDENCE_PACKET_MAX_UNCERTAINTIES);
  const uncertainties = uncertaintyRaw.map((item, index) => validateUncertainty(item, index, claimIds));
  const uncertaintyIds = new Set();
  for (const item of uncertainties) {
    if (uncertaintyIds.has(item.uncertaintyId)) fail('uncertaintyId 必须唯一', 'uncertainties');
    uncertaintyIds.add(item.uncertaintyId);
  }
  if (['partial', 'blocked', 'manual_required'].includes(researchStatus)
    && uncertainties.length === 0) fail('未完成研究必须说明 uncertainties', 'uncertainties');
  const audit = validateAudit(packet.audit, sourceMap, claimIds, { requireAudit });
  const packetHash = text(packet.packetHash, 'packetHash', { max: 64 }) || null;
  if ((requirePacketHash || packetHash !== null) && !/^[a-f0-9]{64}$/u.test(packetHash ?? '')) {
    fail('packetHash 必须是 64 位十六进制', 'packetHash');
  }
  return {
    schemaVersion: EVIDENCE_PACKET_SCHEMA_VERSION,
    packetId,
    ...(packetHash ? { packetHash } : {}),
    topic,
    scope,
    retrieval,
    researchStatus,
    retrievalStatus,
    createdAt,
    sources,
    claims,
    uncertainties,
    audit,
  };
}

export function canonicalEvidencePacket(value) {
  const clone = JSON.parse(JSON.stringify(value));
  delete clone.packetHash;
  return JSON.stringify(clone);
}
