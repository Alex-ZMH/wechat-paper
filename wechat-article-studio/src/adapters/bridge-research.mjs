import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEvidencePacket } from '../contracts/evidence-packet.mjs';
import { BRIEF_SCHEMA_VERSION } from '../contracts/brief.mjs';
import { assertContractVersion, ContractError, requiredText } from '../lib/primitives.mjs';
import { resolveCodexExecutable } from '../lib/codex-executable.mjs';

export const BRIDGE_RESEARCH_REQUEST_SCHEMA = 'content-desk.research-request.v1';
// Research is owned by ResearchJobStore, which keeps the request alive until
// the Bridge returns, the caller cancels, or the Bridge reports a failure.
// Keep this export for compatibility, but do not impose a studio deadline.
export const DEFAULT_RESEARCH_TIMEOUT_MS = undefined;
export const RESEARCH_TRACE_SCHEMA = 'wechat-article-studio.research-trace.v1';
export const CODEX_RESEARCH_RECOVERY_SCHEMA_PATH = fileURLToPath(new URL('../schemas/codex-research-recovery-output.schema.json', import.meta.url));

const DEFAULT_SOURCE_TYPES = [
  'paper', 'standard', 'government', 'official', 'dataset',
  'research_institution', 'industry_association', 'vendor', 'independent', 'news',
];

// The workbench sends the Bridge an allow-listed profile id.  Keep this
// mapping here as an audit receipt so a trace can distinguish the profile the
// workbench requested from the model actually selected by the Bridge.  This
// is intentionally descriptive only; the Bridge remains the source of truth
// for model validation and execution.
const PROFILE_MAP = Object.freeze({
  'codex-sol': { provider: 'codex-cli', model: 'gpt-5.6-sol' },
  'codex-terra': { provider: 'codex-cli', model: 'gpt-5.6-terra' },
  'codex-luna': { provider: 'codex-cli', model: 'gpt-5.6-luna' },
  'ollama-qwen3-8b': { provider: 'ollama', model: 'qwen3:8b' },
});

/**
 * Fetch-compatible request used for the synchronous Bridge endpoint.  Node's
 * global fetch (undici) has a roughly five-minute response-header timeout;
 * that silently drops a legitimate long research run while the Bridge keeps
 * its model process busy.  The native http(s) client has no such implicit
 * header deadline, so our explicit AbortSignal remains the sole wall-clock
 * bound.  This helper intentionally implements only the response surface the
 * adapter needs (ok/status/headers/text/json).
 */
export function bridgeFetch(input, options = {}) {
  const target = new URL(String(input));
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const method = options.method || 'GET';
  const headers = options.headers || {};
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = transport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      signal: options.signal,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.once('error', (error) => finish(reject, error));
      response.once('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        finish(resolve, {
          ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
          status: response.statusCode,
          headers: response.headers,
          text: async () => body,
          json: async () => JSON.parse(body),
        });
      });
    });
    request.once('error', (error) => finish(reject, error));
    try {
      if (options.body !== undefined && options.body !== null) request.write(options.body);
      request.end();
    } catch (error) {
      finish(reject, error);
    }
  });
}

function profileReceipt(value) {
  if (value == null || value === '') return { requested: null, mapped: null };
  const requested = String(value);
  return {
    requested,
    mapped: PROFILE_MAP[requested] ?? { provider: 'unknown', model: requested, allowListed: false },
  };
}

/**
 * Return a serialisable profile mapping receipt for internal run logs.  This
 * does not validate or alter the outgoing request; validation is still owned
 * by the Bridge and its model catalogue.
 */
export function bridgeProfileReceipt(value) {
  return profileReceipt(value);
}

function confidenceToNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(1, value));
  return ({ high: 0.9, medium: 0.7, low: 0.4, disputed: 0.2 })[String(value).toLowerCase()] ?? 0.5;
}

function timeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abortFromParent();
  else if (parentSignal) parentSignal.addEventListener('abort', abortFromParent, { once: true });
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Bridge research timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', abortFromParent);
    },
  };
}

function serialiseError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    code: error.code,
    message: error.message,
    ...(error.cause ? { cause: serialiseError(error.cause) } : {}),
  };
}

function recoveryError(code, message, details = {}) {
  return new ContractError(code, message, {
    classification: 'source_audit_recovery',
    ...details,
  });
}

function candidateSourceDate(source) {
  return source?.publishedAt ?? source?.date ?? source?.publishedDate ?? '';
}

function candidateSourceType(source) {
  return source?.sourceType ?? source?.type ?? '';
}

/**
 * Check the narrow shape that is safe to repair locally.  A candidate is
 * eligible only when the Bridge has already audited every source and every
 * claim is source-bound.  Anything less remains a normal audit failure.
 */
export function validateResearchRecoveryCandidate(candidate, brief) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { eligible: false, reason: 'candidate_missing' };
  }
  if (candidate.schemaVersion && candidate.schemaVersion !== 'content-desk.research-candidate.v1') {
    return { eligible: false, reason: 'candidate_schema_mismatch' };
  }
  if (candidate.status && candidate.status !== 'audit_failed') {
    return { eligible: false, reason: 'candidate_status_mismatch' };
  }
  if (!brief?.topic || candidate.topic !== brief.topic) {
    return { eligible: false, reason: 'candidate_topic_mismatch' };
  }
  const sources = Array.isArray(candidate.sources) ? candidate.sources : [];
  const claims = Array.isArray(candidate.claims) ? candidate.claims : [];
  if (sources.length === 0) return { eligible: false, reason: 'candidate_sources_missing' };
  if (claims.length === 0) return { eligible: false, reason: 'candidate_claims_missing' };

  const sourceIds = new Set();
  for (const source of sources) {
    if (!source || typeof source !== 'object') return { eligible: false, reason: 'candidate_source_invalid' };
    if (source.auditStatus !== 'pass') return { eligible: false, reason: 'candidate_source_not_audited' };
    if (typeof source.sourceId !== 'string' || source.sourceId.trim().length === 0) {
      return { eligible: false, reason: 'candidate_source_id_missing' };
    }
    if (sourceIds.has(source.sourceId)) return { eligible: false, reason: 'candidate_source_id_duplicate' };
    if (typeof source.url !== 'string' || !/^https?:\/\//iu.test(source.url.trim())) {
      return { eligible: false, reason: 'candidate_source_url_missing' };
    }
    if (typeof source.title !== 'string' || source.title.trim().length === 0) {
      return { eligible: false, reason: 'candidate_source_title_missing' };
    }
    sourceIds.add(source.sourceId);
  }

  const claimIds = new Set();
  for (const claim of claims) {
    if (!claim || typeof claim !== 'object') return { eligible: false, reason: 'candidate_claim_invalid' };
    if (!['supported', 'mixed'].includes(claim.auditStatus)) {
      return { eligible: false, reason: 'candidate_claim_not_audited' };
    }
    if (typeof claim.claimId !== 'string' || claim.claimId.trim().length === 0) {
      return { eligible: false, reason: 'candidate_claim_id_missing' };
    }
    if (claimIds.has(claim.claimId)) return { eligible: false, reason: 'candidate_claim_id_duplicate' };
    claimIds.add(claim.claimId);
    if (typeof claim.text !== 'string' || claim.text.trim().length === 0) {
      return { eligible: false, reason: 'candidate_claim_text_missing' };
    }
    if (!Array.isArray(claim.sourceIds) || claim.sourceIds.length === 0) {
      return { eligible: false, reason: 'candidate_claim_sources_missing' };
    }
    if (new Set(claim.sourceIds).size !== claim.sourceIds.length) {
      return { eligible: false, reason: 'candidate_claim_source_duplicate' };
    }
    if (claim.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
      return { eligible: false, reason: 'candidate_claim_source_unknown' };
    }
  }
  return { eligible: true, sourceIds: [...sourceIds] };
}

function buildResearchRecoveryPrompt(candidate) {
  const sources = candidate.sources.map((source) => ({
    sourceId: source.sourceId,
    title: source.title,
    url: source.url,
    publisher: source.publisher ?? '',
    date: candidateSourceDate(source),
    type: candidateSourceType(source),
  }));
  return [
    '你是严格的来源摘录恢复器。',
    '仅访问下方列出的原始 URL；不要搜索其它网址，不要使用模型记忆或常识补写。',
    '对每一个 sourceId 打开其原始 URL，返回一段能直接支持候选主张的短摘录，并给出页码、章节、表格或网页定位信息。',
    '如果原始 URL 无法访问或找不到支持内容，必须让该条 excerpt 为空；下游会拒绝不完整结果。',
    '最终响应必须严格符合 output-schema：只返回 sources 数组，不要 Markdown、解释、代码围栏或其它字段。',
    `候选来源（只能访问这些 URL）：${JSON.stringify(sources)}`,
    `候选主张（只用于判断摘录相关性，不得改写）：${JSON.stringify(candidate.claims.map((claim) => ({ claimId: claim.claimId, text: claim.text, sourceIds: claim.sourceIds })))}`,
  ].join('\n');
}

function assertRecoveryOutput(candidate, output) {
  if (!output || typeof output !== 'object' || Array.isArray(output) || !Array.isArray(output.sources)) {
    throw recoveryError('research_recovery_invalid_output', 'Research recovery did not return a sources array', {
      phase: 'recovery_parse',
    });
  }
  const expected = new Set(candidate.sources.map((source) => source.sourceId));
  const seen = new Set();
  for (const item of output.sources) {
    if (!item || typeof item !== 'object') {
      throw recoveryError('research_recovery_invalid_output', 'Research recovery returned an invalid source entry', {
        phase: 'recovery_validate',
      });
    }
    if (typeof item.sourceId !== 'string' || !expected.has(item.sourceId) || seen.has(item.sourceId)) {
      throw recoveryError('research_recovery_source_mismatch', 'Research recovery source IDs do not match the audited candidate', {
        phase: 'recovery_validate',
        sourceId: item.sourceId,
      });
    }
    if (typeof item.excerpt !== 'string' || item.excerpt.trim().length === 0) {
      throw recoveryError('research_recovery_excerpt_missing', 'Research recovery did not return an excerpt for every source', {
        phase: 'recovery_validate',
        sourceId: item.sourceId,
      });
    }
    if (typeof item.locator !== 'string' || item.locator.trim().length === 0) {
      throw recoveryError('research_recovery_locator_missing', 'Research recovery did not return a locator for every source', {
        phase: 'recovery_validate',
        sourceId: item.sourceId,
      });
    }
    seen.add(item.sourceId);
  }
  const missing = [...expected].filter((sourceId) => !seen.has(sourceId));
  if (missing.length > 0 || seen.size !== expected.size) {
    throw recoveryError('research_recovery_sources_incomplete', 'Research recovery did not cover every audited source', {
      phase: 'recovery_validate',
      missing,
    });
  }
  return output;
}

function buildRecoveredPacket(brief, candidate, recoveryOutput, accessedAt = new Date().toISOString()) {
  const excerpts = new Map(recoveryOutput.sources.map((item) => [item.sourceId, item]));
  const sources = candidate.sources.map((source) => {
    const recovered = excerpts.get(source.sourceId);
    return {
      sourceId: source.sourceId,
      title: requiredText(source.title, `candidate.sources.${source.sourceId}.title`),
      url: requiredText(source.url, `candidate.sources.${source.sourceId}.url`),
      publisher: source.publisher ?? '',
      publishedAt: candidateSourceDate(source),
      accessedAt: source.accessedAt ?? accessedAt,
      sourceType: candidateSourceType(source),
      sourceOrigin: 'realtime_research',
      authority: source.authority ?? '',
      locator: recovered.locator.trim(),
      usageStatus: source.usageStatus ?? '',
      sourceFamilyId: source.sourceFamilyId ?? '',
      excerpt: recovered.excerpt.trim(),
    };
  });
  const claims = candidate.claims.map((claim) => ({
    claimId: requiredText(claim.claimId, 'candidate.claims.claimId'),
    text: requiredText(claim.text, 'candidate.claims.text'),
    evidenceIds: [...new Set(claim.sourceIds)],
    confidence: confidenceToNumber(claim.confidence),
    caveat: claim.caveat ?? '',
    kind: claim.kind ?? 'fact',
    status: claim.status ?? claim.auditStatus,
  }));
  return createEvidencePacket(brief, { sources, claims });
}

function runCodexResearchRecovery(candidate, {
  signal,
  model = process.env.RESEARCH_MODEL || 'gpt-5.6-sol',
  executable,
  schemaPath = CODEX_RESEARCH_RECOVERY_SCHEMA_PATH,
  spawnImpl = nodeSpawn,
  mkdtempImpl = mkdtemp,
  readFileImpl = readFile,
  rmImpl = rm,
  onProgress = () => {},
  onTrace = () => {},
  traceContext = {},
} = {}) {
  return (async () => {
    let executableInfo;
    try {
      executableInfo = executable === undefined || executable === null
        ? resolveCodexExecutable()
        : { command: String(executable), source: 'option' };
    } catch (error) {
      throw recoveryError('research_recovery_unavailable', `Codex research recovery is unavailable: ${error.message}`, {
        phase: 'recovery_start',
        cause: serialiseError(error),
      });
    }
    if (!executableInfo.command.trim()) {
      throw recoveryError('research_recovery_unavailable', 'Codex research recovery executable is empty', {
        phase: 'recovery_start',
      });
    }
    const tempDir = await mkdtempImpl(join(tmpdir(), 'wechat-article-research-recovery-'));
    const outputPath = join(tempDir, 'recovery-output.json');
    const args = [
      '-c', 'approval_policy=never',
      ...(model ? ['-m', model] : []),
      '--search',
      'exec',
      '--skip-git-repo-check',
      '--ephemeral',
      '--sandbox', 'read-only',
      '--output-schema', schemaPath,
      '-o', outputPath,
      '-C', process.cwd(),
      '-',
    ];
    const emit = async (event) => {
      const entry = {
        schemaVersion: RESEARCH_TRACE_SCHEMA,
        timestamp: new Date().toISOString(),
        ...traceContext,
        ...event,
      };
      try { await onTrace(entry); } catch { /* observational */ }
      try { await onProgress({ ...entry, stage: entry.stage ?? 'research_recovery' }); } catch { /* observational */ }
    };
    await emit({ event: 'research_recovery_process_started', stage: 'research_recovery', executableSource: executableInfo.source, model, sourceIds: candidate.sources.map((source) => source.sourceId) });
    try {
      const output = await new Promise((resolve, reject) => {
        let stderr = '';
        let child;
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          if (signal) signal.removeEventListener('abort', abort);
          fn(value);
        };
        const abort = () => {
          try { child?.kill?.('SIGTERM'); } catch { /* process may already have exited */ }
          finish(reject, recoveryError('research_recovery_aborted', 'Research recovery was aborted by the caller', {
            phase: 'recovery_process',
          }));
        };
        if (signal?.aborted) return abort();
        try {
          child = spawnImpl(executableInfo.command, args, {
            cwd: process.cwd(),
            env: process.env,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'ignore', 'pipe'],
          });
        } catch (error) {
          finish(reject, recoveryError('research_recovery_unavailable', `Codex research recovery could not start: ${error.message}`, {
            phase: 'recovery_process',
            cause: serialiseError(error),
          }));
          return;
        }
        signal?.addEventListener('abort', abort, { once: true });
        child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
        child.once('error', (error) => finish(reject, recoveryError('research_recovery_unavailable', `Codex research recovery could not start: ${error.message}`, {
          phase: 'recovery_process',
          cause: serialiseError(error),
        })));
        child.once('close', (code, signalName) => {
          if (code !== 0) {
            finish(reject, recoveryError('research_recovery_failed', `Codex research recovery exited with code ${code ?? 'unknown'}${signalName ? ` (${signalName})` : ''}`, {
              phase: 'recovery_process',
              code,
              signal: signalName,
              stderr: stderr.slice(-4000),
            }));
            return;
          }
          finish(resolve, { code, signal: signalName, stderr });
        });
        child.stdin?.end(buildResearchRecoveryPrompt(candidate));
      });
      let raw;
      try {
        raw = JSON.parse(await readFileImpl(outputPath, 'utf8'));
      } catch (error) {
        throw recoveryError('research_recovery_invalid_output', `Codex research recovery output was not valid JSON: ${error.message}`, {
          phase: 'recovery_parse',
          cause: serialiseError(error),
        });
      }
      const validated = assertRecoveryOutput(candidate, raw);
      await emit({ event: 'research_recovery_process_finished', stage: 'research_recovery', code: output.code, sourceCount: validated.sources.length });
      return validated;
    } catch (error) {
      const normalized = error instanceof ContractError
        ? error
        : recoveryError('research_recovery_failed', 'Codex research recovery failed', { phase: 'recovery_process', cause: serialiseError(error) });
      await emit({ event: 'research_recovery_failed', stage: normalized.details?.phase || 'research_recovery', error: serialiseError(normalized) });
      throw normalized;
    } finally {
      await rmImpl(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

export { runCodexResearchRecovery };

/**
 * Recover a narrowly defined, already-audited Bridge candidate without
 * sending a second Bridge request.  This is used when a user retries the
 * exact failed request: the original candidate stays the only source list.
 */
export async function recoverAuditedBridgeCandidate(brief, candidate, {
  signal,
  recoveryRunner = undefined,
  recoveryModel,
  recoveryExecutable,
  recoverySchemaPath,
  recoverySpawnImpl,
  recoveryMkdtempImpl,
  recoveryReadFileImpl,
  recoveryRmImpl,
  onProgress = () => {},
  onTrace = () => {},
  traceContext = {},
} = {}) {
  const candidateCheck = validateResearchRecoveryCandidate(candidate, brief);
  if (!candidateCheck.eligible) {
    throw recoveryError('research_recovery_candidate_ineligible', 'The saved research candidate cannot be safely recovered', {
      phase: 'recovery_validate',
      reason: candidateCheck.reason,
    });
  }
  const runRecovery = recoveryRunner ?? ((value, context) => runCodexResearchRecovery(value, {
    ...context,
    model: recoveryModel,
    executable: recoveryExecutable,
    schemaPath: recoverySchemaPath ?? CODEX_RESEARCH_RECOVERY_SCHEMA_PATH,
    spawnImpl: recoverySpawnImpl ?? nodeSpawn,
    mkdtempImpl: recoveryMkdtempImpl ?? mkdtemp,
    readFileImpl: recoveryReadFileImpl ?? readFile,
    rmImpl: recoveryRmImpl ?? rm,
  }));
  const recoveryOutput = await runRecovery(candidate, {
    signal,
    model: recoveryModel,
    executable: recoveryExecutable,
    schemaPath: recoverySchemaPath ?? CODEX_RESEARCH_RECOVERY_SCHEMA_PATH,
    spawnImpl: recoverySpawnImpl ?? nodeSpawn,
    mkdtempImpl: recoveryMkdtempImpl ?? mkdtemp,
    readFileImpl: recoveryReadFileImpl ?? readFile,
    rmImpl: recoveryRmImpl ?? rm,
    onProgress,
    onTrace,
    traceContext,
  });
  return buildRecoveredPacket(brief, candidate, assertRecoveryOutput(candidate, recoveryOutput));
}

/**
 * Best-effort cancellation scoped to the exact clientRunId.  The returned
 * receipt is retained in the internal audit trace; callers must not treat an
 * HTTP 200 from /v1/cancel as proof that the child process has already exited.
 */
async function cancelBridgeResearch(baseUrl, clientRunId, cancelImpl, {
  onTrace = () => {},
  onProgress = () => {},
  traceContext = {},
  // The health endpoint is lightweight and is used only after /v1/cancel
  // confirms this exact clientRunId.  Tests may pass `null` to opt out.
  healthFetchImpl = globalThis.fetch,
  healthPollMs = 500,
  healthTimeoutMs = 5000,
  allowCancel = true,
} = {}) {
  const endpoint = `${baseUrl.replace(/\/$/u, '')}/v1/cancel`;
  const attemptedAt = new Date().toISOString();
  const emit = async (event) => {
    const entry = {
      schemaVersion: RESEARCH_TRACE_SCHEMA,
      timestamp: new Date().toISOString(),
      ...traceContext,
      ...event,
    };
    try { await onTrace(entry); } catch { /* trace hooks must not change control flow */ }
    try { await onProgress({ ...entry, stage: entry.stage ?? 'research_cancel' }); } catch { /* idem */ }
  };

  if (!allowCancel || !clientRunId || typeof cancelImpl !== 'function') {
    const receipt = {
      attempted: false,
      status: 'not_attempted',
      reason: !allowCancel
        ? 'job_not_accepted'
        : !clientRunId ? 'missing_client_run_id' : 'missing_cancel_transport',
    };
    await emit({ event: 'cancel_skipped', stage: 'research_cancel', cancel: receipt });
    return receipt;
  }

  await emit({ event: 'cancel_requested', stage: 'research_cancel', endpoint });
  try {
    const response = await cancelImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientRunId }),
      signal: AbortSignal.timeout(5000),
    });
    let body;
    if (response && typeof response.json === 'function') {
      try { body = await response.json(); } catch { body = undefined; }
    }
    const statusCode = Number.isFinite(response?.status) ? response.status : undefined;
    const responseCode = body?.code;
    const matched = body?.clientRunId === clientRunId
      || responseCode === 'cancel_requested'
      || responseCode === 'run_committing';
    const receipt = {
      attempted: true,
      attemptedAt,
      status: response?.ok === false || (statusCode !== undefined && statusCode >= 400)
        ? 'rejected'
        : 'accepted',
      httpStatus: statusCode,
      code: responseCode,
      matchedClientRunId: matched,
      body,
    };
    await emit({
      event: 'cancel_response',
      stage: 'research_cancel',
      status: statusCode,
      cancel: receipt,
    });

    // /health does not expose the active clientRunId on older Bridges.  Only
    // poll after /v1/cancel explicitly accepted this exact id; a mismatch or
    // an idle response must never be interpreted as this job's release.
    if (matched && typeof healthFetchImpl === 'function' && receipt.status === 'accepted') {
      const health = await verifyBridgeRelease(baseUrl, clientRunId, healthFetchImpl, {
        onTrace,
        onProgress,
        traceContext,
        pollMs: healthPollMs,
        timeoutMs: healthTimeoutMs,
      });
      receipt.release = health;
    } else {
      receipt.release = {
        status: matched ? 'not_verified' : 'not_owned',
        reason: matched ? 'health_transport_unavailable' : 'cancel_client_run_mismatch',
      };
    }
    return receipt;
  } catch (error) {
    const receipt = {
      attempted: true,
      attemptedAt,
      status: 'failed',
      error: serialiseError(error),
      release: { status: 'not_verified', reason: 'cancel_transport_failed' },
    };
    await emit({ event: 'cancel_error', stage: 'research_cancel', cancel: receipt });
    return receipt;
  }
}

async function verifyBridgeRelease(baseUrl, clientRunId, healthFetchImpl, {
  onTrace = () => {},
  onProgress = () => {},
  traceContext = {},
  pollMs = 500,
  timeoutMs = 5000,
} = {}) {
  const endpoint = `${baseUrl.replace(/\/$/u, '')}/health`;
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let last;
  while (Date.now() <= deadline) {
    try {
      const response = await healthFetchImpl(endpoint, { signal: AbortSignal.timeout(Math.min(2000, Math.max(250, timeoutMs))) });
      let body;
      if (response && typeof response.json === 'function') {
        try { body = await response.json(); } catch { body = undefined; }
      } else body = response;
      last = { httpStatus: response?.status, busy: body?.busy, stage: body?.stage, clientRunId: body?.clientRunId };
      const entry = {
        event: 'cancel_release_health',
        stage: 'research_cancel_release',
        endpoint,
        ...last,
      };
      try { await onTrace({ schemaVersion: RESEARCH_TRACE_SCHEMA, timestamp: new Date().toISOString(), ...traceContext, ...entry }); } catch { /* no-op */ }
      try { await onProgress({ schemaVersion: RESEARCH_TRACE_SCHEMA, timestamp: new Date().toISOString(), ...traceContext, ...entry }); } catch { /* no-op */ }

      // Newer Bridges may expose the active run id.  If it is different, stop
      // polling: this process must not observe or affect another user's run.
      if (body?.clientRunId && body.clientRunId !== clientRunId) {
        return { status: 'not_owned', reason: 'health_client_run_mismatch', last };
      }
      if (body?.busy === false || body?.stage === 'idle') return { status: 'released', last };
    } catch (error) {
      last = { error: serialiseError(error) };
      try { await onTrace({ schemaVersion: RESEARCH_TRACE_SCHEMA, timestamp: new Date().toISOString(), ...traceContext, event: 'cancel_release_health_error', stage: 'research_cancel_release', endpoint, ...last }); } catch { /* no-op */ }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(50, pollMs), remaining)));
  }
  return { status: 'pending', reason: 'bridge_still_busy_or_health_unavailable', last };
}

/**
 * Observe the synchronous Bridge run while its response is pending.  Older
 * Bridge versions expose only `busy` and `stage`, not the clientRunId.  To
 * avoid attributing another user's work to this run, ownership is established
 * only when either (a) a newer Bridge returns a matching clientRunId or (b)
 * this request observed the Bridge idle immediately before send and then saw
 * the expected idle→busy transition.  A busy Bridge observed before send is
 * never claimed, and no progress or cancellation is emitted for it.
 */
function createBridgeHealthObserver(baseUrl, clientRunId, healthFetchImpl, {
  onTrace = () => {},
  onProgress = () => {},
  pollMs = 1000,
  timeoutMs = 2500,
  traceContext = {},
} = {}) {
  const endpoint = `${baseUrl.replace(/\/$/u, '')}/health`;
  let running = false;
  let timer;
  let initialBusy;
  let accepted = false;
  let ownership = 'unknown';
  let requestSent = false;
  let last;
  const emit = async (event) => {
    const entry = {
      schemaVersion: RESEARCH_TRACE_SCHEMA,
      timestamp: new Date().toISOString(),
      ...traceContext,
      ...event,
    };
    try { await onTrace(entry); } catch { /* observational */ }
    try { await onProgress({ ...entry, stage: entry.stage ?? 'research' }); } catch { /* observational */ }
  };
  const read = async ({ initial = false } = {}) => {
    if (!running && !initial) return;
    try {
      const response = await healthFetchImpl(endpoint, {
        signal: AbortSignal.timeout(Math.max(250, timeoutMs)),
      });
      let body;
      if (response && typeof response.json === 'function') {
        try { body = await response.json(); } catch { body = undefined; }
      } else body = response;
      last = {
        status: response?.status,
        busy: body?.busy,
        stage: body?.stage,
        clientRunId: body?.clientRunId,
      };
      if (initial) initialBusy = body?.busy;
      const matchingId = Boolean(body?.clientRunId && body.clientRunId === clientRunId);
      const idleTransition = initialBusy === false && body?.busy === true;
      // The synchronous Bridge rejects a request with HTTP 409 whenever it is
      // already busy. If the preflight health read failed, a still-pending
      // POST followed by busy=true therefore proves that this run owns the
      // Bridge slot even when older Bridges do not echo clientRunId.
      const requestPending = requestSent && initialBusy !== true && body?.busy === true;
      if (!accepted && (matchingId || idleTransition || requestPending)) {
        accepted = true;
        ownership = matchingId ? 'client_run_id' : idleTransition ? 'idle_transition' : 'request_pending';
        await emit({
          event: 'research_accepted',
          stage: 'research_accepted',
          observedFrom: 'bridge_health',
          ownership,
        });
      }
      if (accepted) {
        await emit({
          event: 'research_progress',
          stage: body?.stage || (body?.busy ? 'research' : 'idle'),
          observedFrom: 'bridge_health',
          ownership,
          busy: body?.busy,
          bridgeStage: body?.stage,
          raw: body,
        });
      } else {
        await emit({
          event: initial ? 'bridge_health_initial' : 'bridge_health_unowned',
          stage: 'research_observer',
          observedFrom: 'bridge_health',
          ownership: 'unknown',
          busy: body?.busy,
          bridgeStage: body?.stage,
        });
      }
    } catch (error) {
      await emit({
        event: 'bridge_health_error',
        stage: 'research_observer',
        observedFrom: 'bridge_health',
        ownership,
        error: serialiseError(error),
      });
    }
  };
  const schedule = () => {
    if (!running) return;
    timer = setTimeout(async () => {
      await read();
      schedule();
    }, Math.max(250, pollMs));
  };
  return {
    async start() {
      if (typeof healthFetchImpl !== 'function') return;
      // Snapshot before the request.  If another run is already busy, this
      // observer remains unowned and cannot cancel that run on our timeout.
      await read({ initial: true });
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    markRequestSent() {
      requestSent = true;
    },
    canCancel() {
      // When health observation is disabled (custom transport/unit tests),
      // the Bridge still scopes cancellation by the exact clientRunId.  In a
      // live call with a health snapshot, an idle (or unavailable) preflight
      // leaves no evidence of another active run; the exact-id cancellation
      // is still safe and a run_mismatch response is retained if ownership
      // was never established.  A preflight busy state remains unowned.
      return accepted || (typeof healthFetchImpl !== 'function') || initialBusy !== true;
    },
    snapshot() {
      return { accepted, ownership, initialBusy, last };
    },
  };
}

function mapPacket(brief, raw) {
  if (!raw || typeof raw !== 'object') throw new ContractError('invalid_research_response', 'Bridge research response must be an object');
  if (raw.schemaVersion !== 'content-desk.evidence-packet.v1') {
    throw new ContractError('schema_mismatch', 'Bridge returned an unsupported evidence packet schema', { received: raw.schemaVersion });
  }
  if (raw.audit?.status && raw.audit.status !== 'passed') {
    throw new ContractError('research_unverified', 'Bridge returned a packet that did not pass source audit', { audit: raw.audit });
  }
  if (raw.auditPassed === false || raw.researchStatus !== 'complete' || raw.retrievalStatus !== 'complete') {
    throw new ContractError('research_incomplete', 'Bridge research is not a complete, audited packet');
  }
  if (Number(raw.unresolvedCriticalClaims ?? 0) > 0) {
    throw new ContractError('research_unverified', 'Bridge packet still contains unresolved critical claims', {
      unresolvedCriticalClaims: raw.unresolvedCriticalClaims,
    });
  }

  const sources = Array.isArray(raw.sources) ? raw.sources.map((source, index) => ({
    sourceId: requiredText(source?.sourceId, `research.sources[${index}].sourceId`),
    title: requiredText(source?.title, `research.sources[${index}].title`),
    url: source?.url ?? '',
    publisher: source?.publisher ?? '',
    publishedAt: source?.publishedAt ?? '',
    accessedAt: source?.accessedAt ?? '',
    sourceType: source?.sourceType ?? '',
    sourceOrigin: 'realtime_research',
    authority: source?.authority ?? '',
    usageStatus: source?.usageStatus ?? '',
    sourceFamilyId: source?.sourceFamilyId ?? '',
    locator: source?.locator ?? '',
    excerpt: requiredText(source?.excerpt, `research.sources[${index}].excerpt`),
  })) : [];
  const claims = Array.isArray(raw.claims) ? raw.claims.flatMap((claim, index) => {
    const evidenceIds = [...new Set([
      ...(Array.isArray(claim?.sourceIds) ? claim.sourceIds : []),
      ...(Array.isArray(claim?.evidence) ? claim.evidence.map((item) => item?.sourceId) : []),
    ].filter(Boolean))];
    // The Bridge contract permits source-free opinion claims; the studio
    // contract deliberately does not. Keep unsupported advice out of the
    // EvidencePacket instead of rejecting every audited, source-backed claim.
    if (evidenceIds.length === 0) return [];
    return [{
      claimId: requiredText(claim?.claimId, `research.claims[${index}].claimId`),
      text: requiredText(claim?.text, `research.claims[${index}].text`),
      evidenceIds,
      confidence: confidenceToNumber(claim?.confidence),
      caveat: claim?.caveat ?? '',
      kind: claim?.kind ?? 'fact',
      status: claim?.status ?? 'supported',
    }];
  }) : [];

  return createEvidencePacket(brief, { sources, claims });
}

export function toBridgeResearchRequest(brief, { writerModel, reviewerModel, clientRunId, cutoff = new Date().toISOString().slice(0, 10) } = {}) {
  assertContractVersion(brief, 'brief', BRIEF_SCHEMA_VERSION);
  return {
    schemaVersion: BRIDGE_RESEARCH_REQUEST_SCHEMA,
    topic: brief.topic,
    purpose: brief.purpose,
    audience: brief.audience,
    channel: brief.channel,
    cutoff,
    depth: 'standard',
    sourceTypes: DEFAULT_SOURCE_TYPES,
    include: brief.materials.map((item) => item.text).filter(Boolean).map((text) => text.slice(0, 500)),
    exclude: [],
    ...(writerModel ? { writerModel } : {}),
    ...(reviewerModel ? { reviewerModel } : {}),
    ...(clientRunId ? { clientRunId } : {}),
  };
}

export async function fetchBridgeEvidenceEnvelope(brief, {
  baseUrl = process.env.CONTENT_DESK_BRIDGE_URL || 'http://127.0.0.1:43127',
  fetchImpl = undefined,
  signal,
  // An explicit timeout remains available to focused tests/diagnostics. The
  // production job path leaves this undefined so a slow but live Bridge run
  // is not discarded by a second studio-side wall-clock limit.
  timeoutMs = DEFAULT_RESEARCH_TIMEOUT_MS,
  cancelImpl = globalThis.fetch,
  healthFetchImpl = undefined,
  healthPollMs = 500,
  healthTimeoutMs = 5000,
  writerModel,
  reviewerModel,
  clientRunId,
  recoveryRunner = undefined,
  recoveryModel,
  recoveryExecutable,
  recoverySchemaPath,
  recoverySpawnImpl,
  recoveryMkdtempImpl,
  recoveryReadFileImpl,
  recoveryRmImpl,
  onProgress = () => {},
  onTrace = () => {},
} = {}) {
  const effectiveFetch = fetchImpl ?? bridgeFetch;
  if (typeof effectiveFetch !== 'function') throw new ContractError('missing_fetch', 'A fetch implementation is required');
  const effectiveHealthFetch = healthFetchImpl === undefined
    ? (fetchImpl ? undefined : globalThis.fetch)
    : healthFetchImpl;
  const effectiveClientRunId = clientRunId || `research-${randomUUID()}`;
  const requestSignal = timeoutSignal(signal, timeoutMs);
  const startedAt = Date.now();
  const traceContext = {
    clientRunId: effectiveClientRunId,
    baseUrl: baseUrl.replace(/\/$/u, ''),
    timeoutMs,
    profileMapping: {
      writer: profileReceipt(writerModel),
      reviewer: profileReceipt(reviewerModel),
    },
    topic: brief?.topic,
  };
  const emit = async (event) => {
    const entry = {
      schemaVersion: RESEARCH_TRACE_SCHEMA,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      ...traceContext,
      ...event,
    };
    try { await onTrace(entry); } catch { /* hooks are observational */ }
    try { await onProgress({ ...entry, stage: entry.stage ?? event.event ?? 'research' }); } catch { /* hooks are observational */ }
  };
  let requestStarted = false;
  const healthObserver = createBridgeHealthObserver(
    baseUrl,
    effectiveClientRunId,
    effectiveHealthFetch,
    {
      onTrace,
      onProgress,
      traceContext,
      pollMs: healthPollMs,
      timeoutMs: Math.min(2500, Math.max(250, healthTimeoutMs)),
    },
  );
  await emit({ event: 'request_received', stage: 'request_received' });
  try {
    await healthObserver.start();
    const requestBody = toBridgeResearchRequest(brief, {
      writerModel,
      reviewerModel,
      clientRunId: effectiveClientRunId,
    });
    await emit({
      event: 'request_sent',
      stage: 'request_sent',
      method: 'POST',
      endpoint: `${baseUrl.replace(/\/$/u, '')}/v1/research`,
      request: requestBody,
    });
    requestStarted = true;
    healthObserver.markRequestSent();
    const response = await effectiveFetch(`${baseUrl.replace(/\/$/u, '')}/v1/research`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: requestSignal.signal,
    });
    await emit({ event: 'response_received', stage: 'response_received', status: response?.status, ok: response?.ok });
    let raw;
    try {
      raw = await response.json();
      await emit({
        event: 'response_parsed',
        stage: 'response_parse',
        status: response?.status,
        raw,
      });
    } catch (error) {
      const status = Number(response?.status);
      // A gateway may return an HTML/plain-text 504 page.  Preserve the HTTP
      // signal even when JSON parsing fails so this cannot be mistaken for a
      // local timeout or generic malformed model output.
      const parseError = new ContractError(
        status === 504 ? 'research_upstream_504' : 'invalid_research_response',
        status === 504 ? 'Bridge research failed with upstream HTTP 504' : 'Bridge research response is not valid JSON',
        {
          classification: status === 504 ? 'upstream_504' : 'invalid_output',
          phase: 'response_parse',
          status,
          clientRunId: effectiveClientRunId,
          cause: serialiseError(error),
        },
      );
      await emit({ event: 'error', stage: 'response_parse', error: serialiseError(parseError) });
      throw parseError;
    }
    if (!response.ok) {
      const status = Number(response?.status);
      const rawCode = raw?.code || raw?.errorCode;
      const classification = status === 504
        ? 'upstream_504'
        : rawCode === 'busy' || status === 409
          ? 'busy'
          : rawCode === 'cli_unavailable' || rawCode === 'model_unavailable'
            ? 'model_start_failure'
            : rawCode === 'cli_failed' || rawCode === 'research_cli_failed'
              ? 'model_process_failure'
              : rawCode === 'research_output_invalid'
                ? 'invalid_output'
              : rawCode === 'research_audit_failed' || rawCode === 'research_audit_invalid'
                ? 'source_audit'
                : 'bridge_failure';
      const errorCode = status === 504 ? 'research_upstream_504' : (rawCode || 'research_failed');
      const bridgeError = new ContractError(errorCode, raw?.error || `Bridge research failed with HTTP ${status}`, {
        status,
        raw,
        classification,
        phase: raw?.stage || 'bridge_response',
        clientRunId: effectiveClientRunId,
      });
      await emit({ event: 'error', stage: bridgeError.details.phase, error: serialiseError(bridgeError), raw });

      // A legacy Bridge can have a fully audited candidate but fail to freeze
      // the packet because one or more source excerpts are missing.  Repair is
      // intentionally narrow: it is attempted only for a 422 audit failure
      // whose candidate has passed all source/claim consistency checks.
      if (status === 422 && rawCode === 'research_audit_failed') {
        const candidateCheck = validateResearchRecoveryCandidate(raw?.candidate, brief);
        await emit({
          event: 'research_recovery_candidate_checked',
          stage: 'research_recovery_validate',
          eligible: candidateCheck.eligible,
          reason: candidateCheck.reason,
          sourceIds: candidateCheck.sourceIds,
        });
        if (candidateCheck.eligible) {
          try {
            await emit({
              event: 'research_recovery_started',
              stage: 'research_recovery',
              sourceIds: candidateCheck.sourceIds,
            });
            const recoveredPacket = await recoverAuditedBridgeCandidate(brief, raw.candidate, {
              signal: requestSignal.signal,
              recoveryRunner,
              model: recoveryModel,
              recoveryModel,
              recoveryExecutable,
              recoverySchemaPath,
              recoverySpawnImpl,
              recoveryMkdtempImpl,
              recoveryReadFileImpl,
              recoveryRmImpl,
              onProgress,
              onTrace,
              traceContext: { ...traceContext, elapsedMs: Date.now() - startedAt },
            });
            await emit({
              event: 'research_recovery_completed',
              stage: 'research_recovery',
              sourceCount: recoveredPacket.sources.length,
              claimCount: recoveredPacket.claims.length,
            });
            await emit({
              event: 'source_audit_result',
              stage: 'source_audit',
              auditStatus: 'passed',
              auditPassed: true,
              researchStatus: 'complete',
              retrievalStatus: 'complete',
              recovery: true,
            });
            await emit({
              event: 'research_complete',
              stage: 'research_complete',
              sources: recoveredPacket.sources.length,
              claims: recoveredPacket.claims.length,
              packetId: recoveredPacket.packetId,
              recovery: true,
            });
            return {
              packet: recoveredPacket,
              providerRef: null,
              clientRunId: effectiveClientRunId,
            };
          } catch (error) {
            const recoveryFailure = error instanceof ContractError
              ? error
              : recoveryError('research_recovery_failed', 'Research recovery failed', { phase: 'recovery_process', cause: serialiseError(error) });
            bridgeError.details = {
              ...(bridgeError.details || {}),
              recovery: serialiseError(recoveryFailure),
              recoveryStatus: 'failed',
            };
            await emit({
              event: 'research_recovery_failed',
              stage: recoveryFailure.details?.phase || 'research_recovery',
              error: serialiseError(recoveryFailure),
            });
            throw bridgeError;
          }
        }
      }
      throw bridgeError;
    }
    const packet = raw?.packet ?? raw;
    await emit({
      event: 'source_audit_result',
      stage: 'source_audit',
      auditStatus: packet?.audit?.status,
      auditPassed: packet?.auditPassed,
      researchStatus: packet?.researchStatus,
      retrievalStatus: packet?.retrievalStatus,
      unresolvedCriticalClaims: packet?.unresolvedCriticalClaims,
    });
    let normalizedPacket;
    try {
      normalizedPacket = mapPacket(brief, packet);
    } catch (error) {
      const mappedError = error instanceof ContractError
        ? error
        : new ContractError('invalid_research_response', 'Bridge research packet could not be normalised');
      const classification = mappedError.code === 'research_unverified' || mappedError.code === 'research_incomplete'
        ? 'source_audit'
        : 'invalid_output';
      mappedError.details = {
        ...(mappedError.details || {}),
        classification,
        phase: 'packet_normalize',
        clientRunId: effectiveClientRunId,
      };
      await emit({ event: 'error', stage: 'packet_normalize', error: serialiseError(mappedError) });
      throw mappedError;
    }
    await emit({
      event: 'research_complete',
      stage: 'research_complete',
      sources: normalizedPacket.sources.length,
      claims: normalizedPacket.claims.length,
      packetId: normalizedPacket.packetId,
    });
    return {
      packet: normalizedPacket,
      providerRef: packet?.packetId && packet?.packetHash
        ? { packetId: packet.packetId, packetHash: packet.packetHash }
        : null,
      clientRunId: effectiveClientRunId,
    };
  } catch (error) {
    if (requestSignal.didTimeout()) {
      const cancel = requestStarted
        ? await cancelBridgeResearch(baseUrl, effectiveClientRunId, cancelImpl, {
          onTrace,
          onProgress,
          traceContext: { ...traceContext, elapsedMs: Date.now() - startedAt },
          healthFetchImpl: effectiveHealthFetch,
          healthPollMs,
          healthTimeoutMs,
          allowCancel: healthObserver.canCancel(),
        })
        : { attempted: false, status: 'not_attempted', reason: 'request_not_started' };
      const timeoutError = new ContractError('research_timeout', `Bridge research timed out after ${timeoutMs} ms`, {
        timeoutMs,
        classification: 'studio_timeout',
        phase: 'client_timeout',
        clientRunId: effectiveClientRunId,
        cancel,
      });
      await emit({ event: 'error', stage: 'client_timeout', error: serialiseError(timeoutError), cancel });
      throw timeoutError;
    }
    if (error?.name === 'AbortError') {
      const cancel = requestStarted
        ? await cancelBridgeResearch(baseUrl, effectiveClientRunId, cancelImpl, {
          onTrace,
          onProgress,
          traceContext: { ...traceContext, elapsedMs: Date.now() - startedAt },
          healthFetchImpl: effectiveHealthFetch,
          healthPollMs,
          healthTimeoutMs,
          allowCancel: healthObserver.canCancel(),
        })
        : { attempted: false, status: 'not_attempted', reason: 'request_not_started' };
      const abortedError = new ContractError('research_aborted', 'Bridge research was aborted by the caller', {
        classification: 'caller_abort',
        phase: 'client_abort',
        clientRunId: effectiveClientRunId,
        cancel,
      });
      await emit({ event: 'error', stage: 'client_abort', error: serialiseError(abortedError), cancel });
      throw abortedError;
    }
    if (error instanceof ContractError) {
      error.details = {
        ...(error.details || {}),
        clientRunId: effectiveClientRunId,
        ...(error.details?.classification ? {} : { classification: 'bridge_failure' }),
      };
      throw error;
    }
    const transportError = new ContractError('research_transport_error', 'Bridge research request failed before a response was received', {
      classification: 'bridge_unreachable',
      phase: 'transport',
      clientRunId: effectiveClientRunId,
      cause: serialiseError(error),
    });
    await emit({ event: 'error', stage: 'transport', error: serialiseError(transportError) });
    throw transportError;
  } finally {
    healthObserver.stop();
    requestSignal.cleanup();
    await emit({ event: 'request_finished', stage: 'request_finished' });
  }
}

export async function fetchBridgeEvidence(brief, options = {}) {
  return (await fetchBridgeEvidenceEnvelope(brief, options)).packet;
}

export { mapPacket as normalizeBridgeEvidencePacket };
