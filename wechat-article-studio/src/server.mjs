import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPipeline } from './orchestrator.mjs'
import { createBrief } from './contracts/brief.mjs'
import { fetchCodexResearchEvidence } from './adapters/codex-research.mjs'
import { createResearchSession } from './contracts/research-session.mjs'
import { createArgumentMap, createArgumentMapSkeleton } from './contracts/argument-map.mjs'
import { createEvidencePacket } from './contracts/evidence-packet.mjs'
import { composeEvidenceWriterResponse } from './adapters/evidence-writer.mjs'
import { fetchCodexWriter } from './adapters/codex-writer.mjs'
import { toBridgeWriterRequest } from './adapters/bridge-writer.mjs'
import { createStyleProfile } from './contracts/style-profile.mjs'
import { reviewDraft } from './contracts/review-report.mjs'
import { createWechatPackage } from './contracts/wechat-package.mjs'
import { createWriterRequest } from './contracts/writer.mjs'
import { createDraft } from './contracts/draft.mjs'
import { ContractError, sha256 } from './lib/primitives.mjs'
import { ResearchSessionStore } from './lib/research-session-store.mjs'
import { LocalWorkspaceStore } from './lib/workspace-store.mjs'
import { ResearchJobStore } from './lib/research-jobs.mjs'
import {
  mergeAnnotationHistory,
  mergeRevisionHistory,
  normaliseWorkspacePayload,
  reviewWorkspacePayload,
} from './lib/workspace-service.mjs'
import { exportWordDocument } from './export/word-exporter.mjs'
import { verifyResearchSources } from './lib/source-verification.mjs'
import { attachContentAudit, createContentReviewer } from './lib/content-review.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// The workbench entry point is intentionally fixed. 43127 belongs to the
// legacy Bridge and must never become the browser server by accident.
// User-facing startup remains fixed at 43210. Tests may bind an alternate
// local port without touching the user service or workspace.
const configuredPort = Number(process.env.WECHAT_STUDIO_PORT ?? 43210)
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536 ? configuredPort : 43210
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }
const configuredDataDir = process.env.WECHAT_STUDIO_DATA_DIR
  ? resolve(process.env.WECHAT_STUDIO_DATA_DIR)
  : join(ROOT, 'data')
const dataRelative = relative(ROOT, configuredDataDir)
if (dataRelative.startsWith('..') || resolve(ROOT, dataRelative) !== configuredDataDir) {
  throw new Error('WECHAT_STUDIO_DATA_DIR must stay inside the wechat-article-studio project')
}
const DATA_DIR = configuredDataDir
const researchSessions = new ResearchSessionStore({ filePath: join(DATA_DIR, 'research-sessions.json') })
const workspaces = new LocalWorkspaceStore({ filePath: join(DATA_DIR, 'workspace.json') })
const contentReviewer = createContentReviewer(DATA_DIR)

async function fetchLiveResearch(brief, options = {}) {
  if (!options.onTrace) {
    mkdirSync(DATA_DIR, { recursive: true })
    options = { ...options, onTrace: event => appendFileSync(join(DATA_DIR, 'research-audit.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), briefId: brief.briefId, ...event })}\n`, 'utf8') }
  }
  const envelope = await fetchCodexResearchEvidence(brief, options)
  options.onTrace?.({ event: 'research_candidate_received', packetId: envelope.packet.packetId, sources: envelope.packet.sources.length, claims: envelope.packet.claims.length })
  return envelope
}

const researchJobs = new ResearchJobStore({
  dataDir: DATA_DIR,
  run: async (input, { signal, onProgress, onTrace }) => {
    const brief = createBrief(input.brief ?? input)
    if (signal?.aborted) throw new ContractError('research_cancelled', 'Research was cancelled before it started')
    onTrace?.({ event: 'brief_created', briefId: brief.briefId, topic: brief.topic })
    const evidenceEnvelope = await fetchLiveResearch(brief, {
      clientRunId: input.clientRunId,
      signal,
      onProgress,
      onTrace,
    })
    if (signal?.aborted) throw new ContractError('research_cancelled', 'Research was cancelled')
    onProgress?.({ stage: 'research_freeze' })
    const researchSession = createResearchSession(brief, evidenceEnvelope.packet, {
      provider: 'codex-cli',
      clientRunId: evidenceEnvelope.clientRunId ?? input.clientRunId,
      providerRef: evidenceEnvelope.providerRef,
    })
    const record = researchSessions.save({ researchSession, brief, evidencePacket: evidenceEnvelope.packet })
    onTrace?.({ event: 'research_record_saved', sessionId: researchSession.sessionId, packetId: evidenceEnvelope.packet.packetId })
    return { ...record, researchMode: 'realtime_research' }
  },
})

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body, null, 2))
}

function recordFailureAudit(req, error, status) {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    appendFileSync(join(DATA_DIR, 'server-audit.jsonl'), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.url,
      status,
      code: error?.code ?? 'pipeline_failed',
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
      stack: error?.stack,
    })}\n`, 'utf8')
  } catch (auditError) {
    // Failure auditing is best effort and must never replace the actionable
    // response sent to the user.
    console.error(`Server failure audit could not be written: ${auditError.message}`)
  }
}

async function bodyJson(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

function writerStyleProfile(input) {
  return input.styleProfile === null || input.styleProfile === undefined
    ? null
    : createStyleProfile(input.styleProfile)
}

function verifiedEvidenceInput(input = {}) {
  let source = input.evidencePacket ?? input.evidence ?? input.packet ?? input
  if (Array.isArray(input.runs)) {
    const topic = input.brief?.topic
    const matches = input.runs.filter((candidate) => candidate?.brief?.topic === topic)
    if (matches.length === 0) {
      throw new ContractError(
        'verified_materials_selection_required',
        'No imported material matches this topic. Select the material explicitly before continuing.',
        { topic, availableTopics: input.runs.map((candidate) => candidate?.brief?.topic).filter(Boolean) },
      )
    }
    if (matches.length > 1 && !input.selectedRunId) {
      throw new ContractError('verified_materials_selection_required', 'Multiple imported materials match this topic. Select one explicitly.', { topic })
    }
    const run = input.selectedRunId
      ? matches.find((candidate) => candidate?.id === input.selectedRunId || candidate?.runId === input.selectedRunId)
      : matches[0]
    if (!run) throw new ContractError('verified_materials_selection_required', 'Select one imported material before continuing.', { topic })
    source = run?.evidencePacket ?? source
  }
  if (source?.evidencePacket && !source.sources && !source.claims) source = source.evidencePacket
  if (!source || !Array.isArray(source.sources) || !Array.isArray(source.claims)) {
    throw new ContractError('verified_materials_invalid', '已核验资料必须包含完整的来源和主张信息')
  }
  const materialTopic = input.materialTopic ?? source.materialTopic ?? source.topic ?? null
  if (!materialTopic && input.confirmTopicMismatch !== true && input.runs == null) {
    throw new ContractError('topic_mismatch_confirmation_required', '导入资料未标明选题，请确认它适用于当前文章后再继续。', {
      topic: input.brief?.topic,
    })
  }
  if (materialTopic && input.brief?.topic && materialTopic !== input.brief.topic && input.confirmTopicMismatch !== true) {
    throw new ContractError('topic_mismatch_confirmation_required', '导入资料与当前选题不一致，请确认后再继续。', {
      topic: input.brief.topic,
      materialTopic,
    })
  }
  const sources = source.sources.map((item, index) => ({
    ...item,
    sourceId: item?.sourceId ?? `verified-source-${index + 1}`,
    excerpt: item?.excerpt ?? item?.quote ?? item?.summary,
    // This route is an explicit human-verified mode. It must never be
    // presented as realtime research, even if an imported file says so.
    sourceOrigin: 'human_curated',
  }))
  const claims = source.claims.map((item, index) => ({
    ...item,
    claimId: item?.claimId ?? `verified-claim-${index + 1}`,
    evidenceIds: item?.evidenceIds ?? item?.sourceIds ?? item?.evidence?.map((entry) => entry?.sourceId),
  }))
  return { sources, claims }
}

async function runWriterPipeline(record, input = {}) {
  const argumentMapInput = input.argumentMap ?? record.argumentMap ?? createArgumentMapSkeleton(record.brief, record.evidencePacket)
  const argumentMap = createArgumentMap(record.brief, record.evidencePacket, {
    ...argumentMapInput,
    status: 'confirmed',
  })
  const styleProfile = writerStyleProfile(input)
  const annotationSet = input.annotationSet ?? null
  const provider = input.provider ?? 'codex-cli'
  if (provider !== 'codex-cli') {
    throw new ContractError('writer_provider_mismatch', `Unsupported live writer provider: ${provider}`, { provider })
  }
  const writerRequest = createWriterRequest({
    brief: record.brief,
    evidencePacket: record.evidencePacket,
    argumentMap,
    styleProfile,
    provider,
    mode: input.mode ?? 'initial_generation',
    draft: input.draft ?? null,
    annotationSet,
    model: input.model ?? process.env.WRITER_MODEL ?? 'gpt-5.6-sol',
    clientRunId: input.clientRunId,
  })
  const writerResponse = await fetchCodexWriter(writerRequest, {
    model: writerRequest.model,
    timeoutMs: input.timeoutMs,
  })
  const draft = createDraft(record.brief, argumentMap, {
    ...writerResponse.draftInput,
    briefId: record.brief.briefId,
    argumentMapId: argumentMap.mapId,
    styleProfileId: styleProfile?.styleProfileId ?? null,
    parentIds: [
      record.brief.briefId,
      record.evidencePacket.packetId,
      argumentMap.mapId,
      writerRequest.requestId,
      writerResponse.responseId,
      ...(styleProfile ? [styleProfile.styleProfileId] : []),
      ...(annotationSet ? [annotationSet.annotationSetId] : []),
    ],
    revision: input.revision,
  })
  const structuralReview = reviewDraft({
    brief: record.brief,
    evidencePacket: record.evidencePacket,
    argumentMap,
    draft,
    styleProfile,
    annotationSet,
  })
  const reviewReport = structuralReview
  const wechatPackage = createWechatPackage({
    brief: record.brief,
    evidencePacket: record.evidencePacket,
    argumentMap,
    draft,
    review: reviewReport,
  })
  return {
    ...record,
    argumentMap,
    styleProfile,
    writerRequest,
    writerResponse,
    draft,
    reviewReport,
    review: reviewReport,
    wechatPackage,
  }
}

async function serveStatic(req, res) {
  const requestPath = req.url === '/' ? '/index.html' : req.url.split('?')[0]
  const safePath = normalize(requestPath).replace(/^([.][.][/\\])+/, '')
  const file = join(ROOT, 'public', safePath.replace(/^[/\\]+/, ''))
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'text/plain; charset=utf-8' })
    res.end(data)
  } catch {
    sendJson(res, 404, { error: 'not_found' })
  }
}

function sessionForWorkspace(input, existing = null) {
  const sessionId = input?.sessionId ?? existing?.sessionId ?? null
  if (!sessionId) return null
  const record = researchSessions.get(sessionId)
  if (!record) throw new ContractError('research_session_not_found', 'Research session was not found', { sessionId })
  return record
}

function workspaceVersion(input, existing) {
  if (!existing) return input?.baseVersion == null ? 0 : Number(input.baseVersion)
  if (input?.baseVersion == null) {
    throw new ContractError('workspace_version_required', 'Saving an existing workspace requires its loaded version')
  }
  return Number(input.baseVersion)
}

function canonicalWorkspaceForExport(workspace, sessionRecord) {
  const reviewed = reviewWorkspacePayload({
    payload: workspace.payload,
    sessionRecord,
    previousAnnotations: workspace.annotationHistory,
  })
  const reviewReport = reviewed.reviewReport
  return { ...reviewed, reviewReport, payload: { ...reviewed.payload, reviewReport, review: reviewReport } }
}

async function saveWorkspaceRequest(input = {}) {
  const existing = input.workspaceId ? workspaces.get(input.workspaceId) : null
  if (input.workspaceId && !existing && Number(input.baseVersion ?? 0) !== 0) {
    throw new ContractError('workspace_not_found', 'Workspace was not found', { workspaceId: input.workspaceId })
  }
  if (existing?.needsExplicitRestore) {
    throw new ContractError('legacy_workspace_confirmation_required', 'This older workspace is preserved for audit. Restore it explicitly before saving.')
  }
  if (existing?.sessionId && input.sessionId && String(input.sessionId) !== String(existing.sessionId)) {
    throw new ContractError('lineage_mismatch', 'An existing workspace cannot switch to another research session; start a new article instead.')
  }
  const sessionRecord = sessionForWorkspace(input, existing)
  const payloadInput = input.payload ?? input
  let reviewed = reviewWorkspacePayload({
    payload: payloadInput,
    sessionRecord,
    previousAnnotations: existing?.annotationHistory ?? [],
    annotations: [
      ...(Array.isArray(input.annotationHistory) ? input.annotationHistory : []),
      ...(Array.isArray(input.annotations) ? input.annotations : []),
    ],
    resolvedAnnotationIds: input.resolvedAnnotationIds ?? [],
  })
  const previousDraft = existing?.payload?.draft
  let annotationHistory = reviewed.annotationHistory
  const annotationChanged = JSON.stringify(existing?.annotationHistory ?? []) !== JSON.stringify(annotationHistory)
  const draftContentChanged = Boolean(previousDraft?.draftHash && reviewed.payload.draft?.draftHash && previousDraft.draftHash !== reviewed.payload.draft.draftHash)
  if (previousDraft?.draftHash && reviewed.payload.draft && (draftContentChanged || annotationChanged)) {
    // The browser deliberately edits text in place while retaining the
    // immutable Draft contract's old revision number. Rebuild a new server
    // revision and link it to the previous draft before reviewing/exporting.
    const candidate = reviewed.payload.draft
    const nextDraft = createDraft(reviewed.payload.brief, reviewed.payload.argumentMap, {
      ...candidate,
      briefId: reviewed.payload.brief.briefId,
      argumentMapId: reviewed.payload.argumentMap.mapId,
      styleProfileId: reviewed.payload.styleProfile?.styleProfileId ?? candidate.styleProfileId ?? null,
      revision: Math.max(previousDraft.revision + 1, Number(candidate.revision || 0) + 1),
      parentIds: [...new Set([...(candidate.parentIds ?? []), previousDraft.draftId])],
    })
    reviewed = reviewWorkspacePayload({
      payload: { ...reviewed.payload, draft: nextDraft },
      sessionRecord,
      previousAnnotations: existing?.annotationHistory ?? [],
      annotations: [
        ...(Array.isArray(input.annotationHistory) ? input.annotationHistory : []),
        ...(Array.isArray(input.annotations) ? input.annotations : []),
      ],
      resolvedAnnotationIds: input.resolvedAnnotationIds ?? [],
    })
  }
  const reviewReport = reviewed.reviewReport
  const payload = { ...reviewed.payload, reviewReport, review: reviewReport }
  annotationHistory = reviewed.annotationHistory
  let revisionHistory = mergeRevisionHistory(
    existing?.revisionHistory ?? [],
    input.revisionHistory,
    existing?.payload ? { ...existing.payload, version: existing.version } : null,
    payload,
  )
  if (annotationChanged) {
    revisionHistory = [
      ...revisionHistory,
      {
        kind: 'annotation',
        draftHash: payload?.draft?.draftHash ?? null,
        annotationHistory,
        savedAt: new Date().toISOString(),
      },
    ]
  }
  return workspaces.save({
    workspaceId: input.workspaceId,
    baseVersion: workspaceVersion(input, existing),
    sessionId: sessionRecord?.researchSession?.sessionId ?? input.sessionId ?? existing?.sessionId ?? null,
    mode: input.mode ?? existing?.mode ?? (sessionRecord ? 'research' : 'brief'),
    payload,
    annotationHistory,
    revisionHistory,
    // Historical approval is retained for old records, never renewed or used
    // as an entitlement to save, write, or export.
    humanApproval: existing?.humanApproval ?? null,
  })
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/research/jobs') {
      const input = await bodyJson(req)
      const job = researchJobs.start(input)
      return sendJson(res, ['queued', 'running', 'cancelling'].includes(job.status) ? 202 : 200, { job })
    }
    if (req.method === 'GET' && req.url.startsWith('/api/research/jobs/')) {
      const path = req.url.split('?')[0]
      const jobId = decodeURIComponent(path.slice('/api/research/jobs/'.length))
      return sendJson(res, 200, { job: researchJobs.get(jobId) })
    }
    if (req.method === 'POST' && req.url.startsWith('/api/research/jobs/') && req.url.split('?')[0].endsWith('/cancel')) {
      const path = req.url.split('?')[0]
      const jobId = decodeURIComponent(path.slice('/api/research/jobs/'.length, -'/cancel'.length))
      const job = await researchJobs.cancel(jobId)
      return sendJson(res, 200, { job })
    }
    if (req.method === 'POST' && req.url === '/api/pipeline') {
      const input = await bodyJson(req)
      if (!input?.brief || !input.brief.topic || !input.brief.purpose || !input.brief.audience || !(input.evidencePacket || input.evidence) || !input.argumentMap || !(input.draft || input.draftInput)) {
        throw new ContractError('pipeline_input_required', 'A production pipeline request requires a brief, evidence packet, confirmed argument map, and draft')
      }
      if (input.argumentMap.status !== 'confirmed') {
        throw new ContractError('argument_map_unconfirmed', '请先确认大纲，再生成文章')
      }
      const result = runPipeline({
        ...input,
        evidence: input.evidence ?? input.evidencePacket,
        styleProfile: input.styleProfile === undefined ? null : input.styleProfile,
        annotationSet: input.annotationSet ?? { annotations: [] },
      })
      return sendJson(res, 200, result)
    }
    if (req.method === 'POST' && req.url.split('?')[0] === '/api/export/word') {
      const input = await bodyJson(req)
      if (!input.workspaceId) throw new ContractError('workspace_required', 'Download the saved workspace version before exporting')
      const workspace = workspaces.get(input.workspaceId)
      if (!workspace) throw new ContractError('workspace_not_found', 'Workspace was not found', { workspaceId: input.workspaceId })
      if (workspace.needsExplicitRestore) {
        throw new ContractError('legacy_workspace_confirmation_required', 'This older workspace must be explicitly restored before downloading')
      }
      if (input.version == null || Number(input.version) !== workspace.version) {
        throw new ContractError('workspace_version_required', 'The download must target the current saved version', {
          workspaceId: workspace.workspaceId,
          currentVersion: workspace.version,
          receivedVersion: input.version,
        })
      }
      const sessionRecord = sessionForWorkspace({}, workspace)
      const canonical = canonicalWorkspaceForExport(workspace, sessionRecord)
      const exported = await exportWordDocument(canonical.payload)
      const encodedFileName = encodeURIComponent(exported.fileName)
      res.writeHead(200, {
        'content-type': exported.contentType,
        'content-disposition': `attachment; filename="article.docx"; filename*=UTF-8''${encodedFileName}`,
        'content-length': exported.buffer.byteLength,
        'cache-control': 'no-store',
      })
      res.end(exported.buffer)
      return
    }
    if (req.method === 'POST' && req.url === '/api/research') {
      const input = await bodyJson(req)
      const brief = createBrief(input.brief ?? input)
      const evidenceEnvelope = await fetchLiveResearch(brief, {
        clientRunId: input.clientRunId,
      })
      const researchSession = createResearchSession(brief, evidenceEnvelope.packet, {
        provider: 'codex-cli',
        clientRunId: evidenceEnvelope.clientRunId ?? input.clientRunId,
        providerRef: evidenceEnvelope.providerRef,
      })
      const record = researchSessions.save({ researchSession, brief, evidencePacket: evidenceEnvelope.packet })
      return sendJson(res, 200, { ...record, researchMode: 'realtime_research' })
    }
    if (req.method === 'POST' && req.url === '/api/research/verified') {
      const input = await bodyJson(req)
      const brief = createBrief(input.brief ?? input)
      const evidencePacket = createEvidencePacket(brief, verifiedEvidenceInput(input))
      const researchSession = createResearchSession(brief, evidencePacket, {
        provider: 'human_curated',
        clientRunId: input.clientRunId,
      })
      const record = researchSessions.save({ researchSession, brief, evidencePacket })
      return sendJson(res, 200, { ...record, researchMode: 'verified_materials' })
    }
    if (req.method === 'POST' && req.url.startsWith('/api/research/') && req.url.split('?')[0].endsWith('/source-check')) {
      const path = req.url.split('?')[0].slice('/api/research/'.length)
      const sessionId = decodeURIComponent(path.slice(0, -'/source-check'.length))
      const record = researchSessions.get(sessionId)
      if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
      const results = await verifyResearchSources(record.evidencePacket)
      return sendJson(res, 200, { results })
    }
    if (req.method === 'POST' && req.url.startsWith('/api/research/') && req.url.split('?')[0].endsWith('/argument-map')) {
      const path = req.url.split('?')[0].slice('/api/research/'.length)
      const sessionId = decodeURIComponent(path.slice(0, -'/argument-map'.length))
      const record = researchSessions.get(sessionId)
      if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
      const input = await bodyJson(req)
      const argumentMap = createArgumentMap(record.brief, record.evidencePacket, {
        points: input.points,
        status: 'confirmed',
      })
      const updated = researchSessions.saveArgumentMap(sessionId, argumentMap)
      return sendJson(res, 200, { ...updated, argumentMap })
    }
    // The old deterministic evidence scaffold is kept as an explicitly named
    // diagnostic endpoint. It is never the default for the live writer path.
    if (req.method === 'POST' && req.url.startsWith('/api/research/') && req.url.split('?')[0].endsWith('/evidence-scaffold')) {
      const path = req.url.split('?')[0].slice('/api/research/'.length)
      const sessionId = decodeURIComponent(path.slice(0, -'/evidence-scaffold'.length))
      const record = researchSessions.get(sessionId)
      if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
      const input = await bodyJson(req)
      const argumentMapInput = input.argumentMap ?? record.argumentMap ?? createArgumentMapSkeleton(record.brief, record.evidencePacket)
      const argumentMap = createArgumentMap(record.brief, record.evidencePacket, {
        ...argumentMapInput,
        status: 'confirmed',
      })
      const styleProfile = writerStyleProfile(input)
      const writerRequest = createWriterRequest({
        brief: record.brief,
        evidencePacket: record.evidencePacket,
        argumentMap,
        styleProfile,
        provider: 'evidence-writer',
        mode: 'initial_generation',
        clientRunId: input.clientRunId,
      })
      const writerResponse = composeEvidenceWriterResponse(writerRequest)
      const draft = createDraft(record.brief, argumentMap, {
        ...writerResponse.draftInput,
        revision: input.revision,
      })
      const reviewReport = reviewDraft({ brief: record.brief, evidencePacket: record.evidencePacket, argumentMap, draft, styleProfile })
      const wechatPackage = createWechatPackage({ brief: record.brief, evidencePacket: record.evidencePacket, argumentMap, draft, review: reviewReport })
      return sendJson(res, 200, { ...record, argumentMap, styleProfile, writerRequest, writerResponse, draft, reviewReport, review: reviewReport, wechatPackage })
    }
    if (req.method === 'POST' && req.url.startsWith('/api/research/') && req.url.split('?')[0].endsWith('/draft')) {
      const path = req.url.split('?')[0].slice('/api/research/'.length)
      const sessionId = decodeURIComponent(path.slice(0, -'/draft'.length))
      const record = researchSessions.get(sessionId)
      if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
      const input = await bodyJson(req)
      const currentMap = createArgumentMap(record.brief, record.evidencePacket, {
        ...(input.argumentMap ?? record.argumentMap ?? createArgumentMapSkeleton(record.brief, record.evidencePacket)),
        status: 'confirmed',
      })
      const adopted = researchSessions.saveArgumentMap(sessionId, currentMap)
      return sendJson(res, 200, await runWriterPipeline(adopted, { ...input, argumentMap: currentMap }))
    }
    if (req.method === 'POST' && req.url.startsWith('/api/research/') && req.url.split('?')[0].endsWith('/writer-request')) {
      const path = req.url.split('?')[0].slice('/api/research/'.length)
      const sessionId = decodeURIComponent(path.slice(0, -'/writer-request'.length))
      const record = researchSessions.get(sessionId)
      if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
      const input = await bodyJson(req)
      const argumentMapInput = input.argumentMap ?? input
      const argumentMap = createArgumentMap(record.brief, record.evidencePacket, {
        ...argumentMapInput,
        status: 'confirmed',
      })
      const styleProfile = input.styleProfile === null || input.styleProfile === undefined
        ? null
        : createStyleProfile(input.styleProfile)
      const writerRequest = createWriterRequest({
        brief: record.brief,
        evidencePacket: record.evidencePacket,
        argumentMap,
        styleProfile,
        provider: input.provider ?? 'bridge',
        mode: input.mode ?? 'initial_generation',
        draft: input.draft ?? null,
        annotationSet: input.annotationSet ?? null,
        model: input.model,
        clientRunId: input.clientRunId,
      })
      const body = { ...record, argumentMap, styleProfile, writerRequest }
      if (writerRequest.provider === 'bridge') {
        body.bridgeRequest = toBridgeWriterRequest(writerRequest, {
          bridgeEvidenceRef: input.bridgeEvidenceRef ?? record.researchSession.providerRef,
          writerModel: input.writerModel,
          reviewerModel: input.reviewerModel,
          dualReview: input.dualReview ?? true,
        })
      }
      return sendJson(res, 200, body)
    }
    if (req.method === 'GET' && req.url === '/api/research') {
      return sendJson(res, 200, { sessions: researchSessions.list() })
    }
    if (req.method === 'GET' && req.url === '/api/workspace/latest') {
      return sendJson(res, 200, { workspace: workspaces.latest() })
    }
    if (req.method === 'GET' && req.url === '/api/workspaces') {
      return sendJson(res, 200, { workspaces: workspaces.list({ includeLegacy: true }) })
    }
    if (req.method === 'GET' && req.url.startsWith('/api/workspace/') && !req.url.includes('?')) {
      const workspaceId = decodeURIComponent(req.url.slice('/api/workspace/'.length))
      const workspace = workspaces.get(workspaceId)
      if (!workspace) return sendJson(res, 404, { error: 'workspace_not_found', workspaceId })
      return sendJson(res, 200, { workspace })
    }
    if (req.method === 'POST' && req.url === '/api/workspace') {
      const input = await bodyJson(req)
      const workspace = await saveWorkspaceRequest(input)
      return sendJson(res, 200, { workspace })
    }
    if (req.method === 'POST' && req.url === '/api/workspace/review') {
      const input = await bodyJson(req)
      const existing = input.workspaceId ? workspaces.get(input.workspaceId) : null
      // Suggestions can be requested on an unsaved article. No review receipt
      // participates in save or export eligibility.
      if (existing?.sessionId && input.sessionId && String(input.sessionId) !== String(existing.sessionId)) {
        throw new ContractError('lineage_mismatch', 'An existing workspace cannot switch to another research session')
      }
      const sessionRecord = sessionForWorkspace(input, existing)
      const reviewed = reviewWorkspacePayload({
        payload: input.payload ?? input,
        sessionRecord,
        previousAnnotations: existing?.annotationHistory ?? [],
        annotations: [
          ...(Array.isArray(input.annotationHistory) ? input.annotationHistory : []),
          ...(Array.isArray(input.annotations) ? input.annotations : []),
        ],
        resolvedAnnotationIds: input.resolvedAnnotationIds ?? [],
      })
      const audit = reviewed.payload.draft ? await contentReviewer.review(reviewed.payload) : null
      const reviewReport = attachContentAudit(reviewed.reviewReport, audit)
      return sendJson(res, 200, {
        payload: { ...reviewed.payload, reviewReport, review: reviewReport },
        annotationHistory: reviewed.annotationHistory,
        revisionHistory: existing?.revisionHistory ?? [],
        reviewReport,
        version: null,
      })
    }
    if (req.method === 'POST' && req.url.startsWith('/api/workspace/') && req.url.split('?')[0].endsWith('/finalize')) {
      const path = req.url.split('?')[0]
      const workspaceId = decodeURIComponent(path.slice('/api/workspace/'.length, -'/finalize'.length))
      const workspace = workspaces.get(workspaceId)
      if (!workspace) return sendJson(res, 404, { error: 'workspace_not_found', workspaceId })
      const input = await bodyJson(req)
      if (input.version == null || Number(input.version) !== workspace.version) {
        throw new ContractError('workspace_version_required', 'Only the current saved version can be finalized', {
          currentVersion: workspace.version,
          receivedVersion: input.version,
        })
      }
      // Legacy clients may still call this endpoint. It is a read-only
      // compatibility response, not a new approval or version transition.
      return sendJson(res, 200, { workspace, deprecated: true })
    }
    if (req.method === 'POST' && req.url.startsWith('/api/workspace/') && req.url.split('?')[0].endsWith('/restore-legacy')) {
      const path = req.url.split('?')[0]
      const workspaceId = decodeURIComponent(path.slice('/api/workspace/'.length, -'/restore-legacy'.length))
      const workspace = workspaces.restoreLegacy(workspaceId)
      return sendJson(res, 200, { workspace })
    }
    if (req.method === 'GET' && req.url.startsWith('/api/research/')) {
      const path = req.url.slice('/api/research/'.length).split('?')[0]
      if (path.endsWith('/argument-map')) {
        const sessionId = decodeURIComponent(path.slice(0, -'/argument-map'.length))
        const record = researchSessions.get(sessionId)
        if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
        return sendJson(res, 200, {
          ...record,
          argumentMap: record.argumentMap ?? createArgumentMapSkeleton(record.brief, record.evidencePacket),
        })
      }
      const sessionId = decodeURIComponent(path)
      const record = researchSessions.get(sessionId)
      if (!record) return sendJson(res, 404, { error: 'research_session_not_found', sessionId })
      return sendJson(res, 200, record)
    }
    if (req.method === 'GET' && req.url === '/api/health') return sendJson(res, 200, {
      ok: true,
      service: 'wechat-article-studio-core',
      workspaceScope: sha256(DATA_DIR).slice(0, 12),
    })
    if (req.method === 'GET') return serveStatic(req, res)
    return sendJson(res, 405, { error: 'method_not_allowed' })
  } catch (error) {
    const status = error?.code === 'word_export_reader_fields' ? 422
      : ['workspace_conflict', 'workspace_version_required', 'busy'].includes(error?.code) ? 409
      : ['workspace_not_found', 'research_session_not_found', 'research_job_not_found'].includes(error?.code) ? 404
      : ['research_timeout', 'research_upstream_504'].includes(error?.code) ? 504
      : [
      'writer_unavailable',
      'writer_timeout',
      'writer_failed',
      'writer_provider_mismatch',
      'writer_response_invalid',
      'writer_paragraph_unbound',
      'writer_claim_uncovered',
      'research_transport_error',
      'research_failed',
      'word_export_unavailable',
      'word_export_timeout',
      'word_export_failed',
      'persistence_failed',
    ].includes(error?.code) ? 503 : 400
    recordFailureAudit(req, error, status)
    return sendJson(res, status, {
      error: error?.code || 'pipeline_failed',
      message: error instanceof Error ? error.message : String(error),
      details: error?.details,
    })
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`wechat-article-studio listening on http://127.0.0.1:${PORT}`))
